"""Extra fields beyond the schedule card: link roles and the optional papers export (topics and
institutions)."""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from ...cache import BuildCache, Papers
from ...fetch import PoliteClient
from .parse import ScheduleEvent, unescape_repeatedly
from .settings import SourceSettings

log = logging.getLogger(__name__)


def split_links(event: ScheduleEvent, source: SourceSettings) -> Tuple[str, bool, List[List[str]]]:
    """(OpenReview id, has a poster image, the remaining links): the first two get their own buttons."""
    openreview, poster, others = '', False, []
    for label, url in event.links:
        forum = source.openreview_link.match(url)
        image = source.poster_link.match(url)
        if forum and not openreview:
            openreview = forum.group(1)
        elif image and int(image.group(1)) == event.id:
            poster = True
        else:
            others.append([label, url])
    return openreview, poster, others


# ---------------------------------------------------------------- papers export (opt-in)
def load_papers(cache: BuildCache, client: Optional[PoliteClient], url: str) -> Papers:
    """Topics and affiliations. robots.txt disallows /static for crawlers, so the export is fetched only
    when the build is run with --papers-export (client given); every other build reads the cache."""
    if client is not None:
        log.warning('fetching %s although robots.txt disallows /static (--papers-export opt-in)', url)
        try:
            payload = json.loads(client.get_text(url, obey_robots=False, timeout=180))
            rows = _paper_rows(payload.get('results') or [])
            cache.save_papers(rows)
            log.info('papers export: %d papers cached in %s', len(rows), cache.papers_path)
        except Exception as exc:  # the export is a bonus: never fail the build over it
            log.warning('papers export unavailable: %s', exc)
    return cache.load_papers()


def _paper_rows(results: List[Any]) -> Dict[str, List[Any]]:
    rows: Dict[str, List[Any]] = {}
    for item in results:
        try:
            paper_id = int(item.get('id'))
        except (TypeError, ValueError, AttributeError):
            continue
        topic = unescape_repeatedly(item['topic']) if isinstance(item.get('topic'), str) else ''
        topic = ' › '.join(part.strip() for part in topic.split('->') if part.strip())
        institutions: List[str] = []
        for author in item.get('authors') if isinstance(item.get('authors'), list) else []:
            name = unescape_repeatedly(str((author or {}).get('institution') or '')).strip()
            if name and name != 'None' and name not in institutions:
                institutions.append(name)
        rows[str(paper_id)] = [topic, institutions]
    return rows
