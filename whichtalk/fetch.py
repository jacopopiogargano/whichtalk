"""Polite HTTP: one client per build that identifies itself, obeys robots.txt (including its
Crawl-delay), keeps at least one second between requests to a host and backs off on 429/5xx."""
from __future__ import annotations

import logging
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

log = logging.getLogger(__name__)

MIN_INTERVAL = 1.0
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
BACKOFF_SECONDS = (5, 15, 45, 90)
MAX_BACKOFF = 300

Transport = Callable[[str, Dict[str, str], float], Tuple[int, bytes, Dict[str, str]]]


class FetchError(RuntimeError):
    pass


class RobotsDenied(FetchError):
    pass


@dataclass
class Response:
    status: int
    body: bytes
    headers: Dict[str, str] = field(default_factory=dict)

    def text(self) -> str:
        return self.body.decode('utf-8', errors='replace')


def urllib_transport(url: str, headers: Dict[str, str], timeout: float) -> Tuple[int, bytes, Dict[str, str]]:
    """GET; HTTP error statuses come back as values, network failures raise."""
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read() if err.fp else b'', dict(err.headers or {})


class RobotsPolicy:
    """The rules of one robots.txt for one crawler: longest matching path wins, Allow wins ties,
    `*` matches any run of characters and a trailing `$` anchors the end."""

    def __init__(self, rules: List[Tuple[bool, str]], crawl_delay: Optional[float] = None) -> None:
        self.rules = [(allow, pattern, _robots_regex(pattern)) for allow, pattern in rules]
        self.crawl_delay = crawl_delay

    @classmethod
    def allow_all(cls) -> 'RobotsPolicy':
        return cls([])

    @classmethod
    def deny_all(cls) -> 'RobotsPolicy':
        return cls([(False, '/')])

    @classmethod
    def parse(cls, text: str, product: str) -> 'RobotsPolicy':
        groups: List[Tuple[List[str], List[Tuple[bool, str]], List[float]]] = []
        reading_agents = False
        for raw in text.splitlines():
            line = raw.split('#', 1)[0].strip()
            name, sep, value = line.partition(':')
            if not sep:
                continue
            name, value = name.strip().lower(), value.strip()
            if name == 'user-agent':
                if not reading_agents:
                    groups.append(([], [], []))
                groups[-1][0].append(value.lower())
                reading_agents = True
                continue
            reading_agents = False
            if not groups:
                continue
            if name in ('allow', 'disallow') and value:
                groups[-1][1].append((name == 'allow', value))
            elif name == 'crawl-delay':
                try:
                    groups[-1][2].append(float(value))
                except ValueError:
                    pass
        product = product.lower()
        chosen = [g for g in groups if product in g[0]] or [g for g in groups if '*' in g[0]]
        rules = [rule for g in chosen for rule in g[1]]
        delays = [d for g in chosen for d in g[2]]
        return cls(rules, max(delays) if delays else None)

    def allows(self, url: str) -> bool:
        parts = urlsplit(url)
        path = (parts.path or '/') + (f'?{parts.query}' if parts.query else '')
        best: Optional[Tuple[int, bool]] = None
        for allow, pattern, regex in self.rules:
            if regex.match(path):
                rank = (len(pattern), allow)
                if best is None or rank > best:
                    best = rank
        return True if best is None else best[1]


def _robots_regex(pattern: str) -> 're.Pattern[str]':
    anchored = pattern.endswith('$')
    body = pattern[:-1] if anchored else pattern
    return re.compile('.*'.join(re.escape(piece) for piece in body.split('*')) + (r'\Z' if anchored else ''))


class PoliteClient:
    """`transport`, `sleep` and `clock` are injectable so tests never touch the network."""

    def __init__(self, user_agent: str, delay: float = 1.2, transport: Transport = urllib_transport,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic,
                 timeout: float = 60) -> None:
        self.user_agent = user_agent
        self.product = user_agent.split('/', 1)[0].strip()
        self.delay = max(MIN_INTERVAL, delay)
        self.timeout = timeout
        self._transport, self._sleep, self._clock = transport, sleep, clock
        self._robots: Dict[str, RobotsPolicy] = {}
        self._last_done: Dict[str, float] = {}
        self.stats = {'requests': 0, 'bytes': 0, 'retries': 0}

    def get(self, url: str, *, accept: str = 'text/html,application/json', obey_robots: bool = True,
            timeout: Optional[float] = None) -> Optional[Response]:
        """The final response, or None when every retry failed. Raises RobotsDenied."""
        host = _origin(url)
        policy = self._policy(host)
        if obey_robots and not policy.allows(url):
            raise RobotsDenied(f'robots.txt disallows {url}')
        headers = {'User-Agent': self.user_agent, 'Accept': accept}
        for attempt, backoff in enumerate(BACKOFF_SECONDS):
            resp = self._send(host, url, headers, timeout or self.timeout)
            if resp.status and resp.status not in RETRY_STATUSES:
                return resp
            self.stats['retries'] += 1
            retry_after = str(resp.headers.get('Retry-After') or '')
            wait = float(retry_after) if retry_after.isdigit() else backoff
            log.warning('%s: HTTP %s (attempt %d), backing off %.0fs', url, resp.status or 'error', attempt + 1, wait)
            self._sleep(min(wait, MAX_BACKOFF))
        return None

    def get_text(self, url: str, **kwargs: object) -> str:
        resp = self.get(url, **kwargs)  # type: ignore[arg-type]
        if resp is None:
            raise FetchError(f'no answer from {url}')
        if resp.status != 200:
            raise FetchError(f'HTTP {resp.status} for {url}')
        return resp.text()

    def _send(self, host: str, url: str, headers: Dict[str, str], timeout: float) -> Response:
        interval = max(self.delay, self._robots[host].crawl_delay or 0) if host in self._robots else self.delay
        last = self._last_done.get(host)
        if last is not None:
            wait = last + interval - self._clock()
            if wait > 0:
                self._sleep(wait)
        self.stats['requests'] += 1
        try:
            status, body, resp_headers = self._transport(url, headers, timeout)
        except Exception as exc:  # network failure: callers see status 0 and may retry
            log.debug('%s failed: %s', url, exc)
            status, body, resp_headers = 0, b'', {}
        finally:
            self._last_done[host] = self._clock()
        self.stats['bytes'] += len(body)
        return Response(status, body, resp_headers)

    def _policy(self, host: str) -> RobotsPolicy:
        if host not in self._robots:
            resp = self._send(host, f'{host}/robots.txt', {'User-Agent': self.user_agent, 'Accept': 'text/plain'}, 30)
            if resp.status == 200:
                policy = RobotsPolicy.parse(resp.text(), self.product)
            elif 400 <= resp.status < 500:
                policy = RobotsPolicy.allow_all()  # no robots.txt: nothing is disallowed
            else:
                log.warning('%s/robots.txt unavailable (HTTP %s): not fetching from that host this run',
                            host, resp.status or 'error')
                policy = RobotsPolicy.deny_all()
            self._robots[host] = policy
        return self._robots[host]


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f'{parts.scheme}://{parts.netloc}'
