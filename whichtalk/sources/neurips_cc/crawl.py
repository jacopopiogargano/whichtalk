"""Resumable crawl of event detail pages (descriptions and abstracts) into the conference's cache/details.json."""
from __future__ import annotations

import datetime as dt
import logging
import time
from typing import Any, Callable, Dict, List, Optional

from ...cache import now_iso
from ...fetch import PoliteClient, RobotsDenied
from .parse import ScheduleEvent, parse_detail
from .settings import DetailPages, SourceSettings

log = logging.getLogger(__name__)

# Bump when parse_detail learns a new page layout: empty results from older parsers are fetched again.
PARSE_VERSION = 2
RETRY_MISSES_AFTER = dt.timedelta(days=7)
SAVE_EVERY = 25
GIVE_UP_AFTER_FAILURES = 3


def detail_url(event: ScheduleEvent, pages: DetailPages) -> str:
    slug = pages.location_slugs.get(event.location)
    if not slug:
        return f'{pages.base}/{event.id}'  # this address redirects to the right location
    kind_path = pages.kind_paths.get(event.kind)
    return f'{pages.base}/loc/{slug}/' + (f'{kind_path}/' if kind_path else '') + str(event.id)


def needs_fetch(entry: Optional[Dict[str, Any]], now: dt.datetime) -> bool:
    """Missing pages; pages an older parser read as empty; misses and errors older than a week."""
    if not entry:
        return True
    if entry.get('s') == 200:
        return not entry.get('a') and entry.get('v', 1) < PARSE_VERSION
    try:
        return now - dt.datetime.fromisoformat(entry.get('t')) > RETRY_MISSES_AFTER  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return True


def crawl_order(events: List[ScheduleEvent], source: SourceSettings, location_order: List[str]) -> List[ScheduleEvent]:
    """Talks, tutorials and workshops first (every location), then papers location by location; by start time."""
    rank = {key: n for n, key in enumerate(location_order)}

    def key(e: ScheduleEvent) -> tuple:
        paper = e.kind in source.paper_kinds
        return (paper, rank.get(e.location, len(rank)) if paper else 0, e.start or 0, e.id)
    return sorted((e for e in events if e.kind not in source.details.skip_kinds), key=key)


class DetailCrawler:
    def __init__(self, client: PoliteClient, source: SourceSettings, cache: Dict[str, Any],
                 location_order: List[str], save: Optional[Callable[[], None]] = None,
                 clock: Callable[[], dt.datetime] = lambda: dt.datetime.now(dt.timezone.utc)) -> None:
        self.client, self.source, self.cache = client, source, cache
        self.location_order, self.save, self.clock = location_order, save, clock
        self.stats = {'fetched': 0, 'errors': 0, 'blocked': 0, 'pending': 0, 'seconds': 0.0}

    def pending(self, events: List[ScheduleEvent]) -> List[ScheduleEvent]:
        now = self.clock()
        return [e for e in crawl_order(events, self.source, self.location_order)
                if needs_fetch(self.cache.get(str(e.id)), now)]

    def run(self, events: List[ScheduleEvent], limit: int) -> Dict[str, Any]:
        started = time.monotonic()
        failures = 0
        for event in self.pending(events)[:max(0, limit)]:
            try:
                status = self._fetch(event)
            except RobotsDenied as exc:
                self.stats['blocked'] += 1
                log.debug('%s', exc)
                continue
            failures = failures + 1 if status is None else 0
            if failures >= GIVE_UP_AFTER_FAILURES:
                log.warning('detail crawl: %d failures in a row, stopping (the next build resumes)', failures)
                break
            if self.save and status is not None and self.stats['fetched'] % SAVE_EVERY == 0:
                self.save()
        self.stats['seconds'] = round(time.monotonic() - started, 1)
        self.stats['pending'] = len(self.pending(events))
        self.stats.update(self.client.stats)
        return self.stats

    def _fetch(self, event: ScheduleEvent) -> Optional[int]:
        pages = self.source.details
        url = detail_url(event, pages)
        resp = self.client.get(url)
        kind_path = pages.kind_paths.get(event.kind)
        if resp is not None and resp.status == 404 and kind_path in pages.plain_url_on_404 \
                and f'/{kind_path}/' in url:
            resp = self.client.get(f'{pages.base}/{event.id}')
        if resp is None:
            self.stats['errors'] += 1
            return None
        text = parse_detail(resp.text()) if resp.status == 200 else ''
        self.cache[str(event.id)] = {'s': resp.status, 't': now_iso(), 'a': text, 'v': PARSE_VERSION}
        self.stats['fetched'] += 1
        return resp.status
