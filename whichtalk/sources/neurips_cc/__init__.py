"""The `neurips-cc` source: the schedule page of a conference site run on the neurips.cc software
(one card per event), event detail pages for descriptions and abstracts, and an optional papers
export for topics and institutions. Everything fetched is cached in conferences/<id>/cache/.

  settings  the `source` block: addresses, crawl limits, location rules
  parse     schedule cards and detail pages
  crawl     resumable, polite detail-page crawl
  papers    link roles and the opt-in papers export
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from ...cache import BuildCache, CacheError, Papers
from ...checks import Checker
from ...fetch import FetchError, PoliteClient
from ...model import Event, Program
from .. import LoadOptions, SourceError
from .crawl import DetailCrawler
from .papers import load_papers, split_links
from .parse import ScheduleEvent, parse_schedule
from .settings import SourceSettings, parse_settings

if TYPE_CHECKING:
    from ...config import Conference

log = logging.getLogger(__name__)


class NeuripsCc:
    type = 'neurips-cc'
    scraper = True

    def settings(self, source: Dict[str, Any], config: Dict[str, Any], v: Checker) -> SourceSettings:
        return parse_settings(source, config, v)

    def load(self, conf: Conference, options: LoadOptions) -> Program:
        source: SourceSettings = conf.source
        cache = BuildCache(conf.folder / 'cache')
        client = None if options.offline else PoliteClient(source.user_agent, options.delay or source.crawl_delay)
        cards = _schedule(source, cache, client)
        if options.papers_export and client is None:
            log.warning('--papers-export needs the network: ignored with --offline')
        papers = load_papers(cache, client if options.papers_export else None, source.papers_export_url)
        details = cache.load_details()
        limit = source.max_new if options.max_new is None else options.max_new
        if client is not None and options.crawl and limit > 0 and cache.details_writable:
            _crawl(conf, client, cache, details, cards, limit)
        if papers:
            log.info('%d papers enriched from the papers export', len(papers))
        events = [_event(card, source, papers) for card in cards]
        return Program(events, abstract_texts(cards, details), source.schedule_url, enriched=bool(papers))


ADAPTER = NeuripsCc()


def abstract_texts(cards: List[ScheduleEvent], details: Dict[str, Any]) -> Dict[int, str]:
    """Event id -> cached description or abstract, for events that have a non-empty one."""
    texts = {}
    for card in cards:
        entry = details.get(str(card.id)) or {}
        if entry.get('a'):
            texts[card.id] = entry['a']
    return texts


def _event(card: ScheduleEvent, source: SourceSettings, papers: Papers) -> Event:
    openreview, poster, links = split_links(card, source)
    topic, institutions = papers.get(card.id, ('', []))
    return Event(id=card.id, kind=card.kind, title=card.title, authors=card.authors, room=card.room,
                 start=card.start, end=card.end, location=card.location, parent_id=card.parent_id,
                 parent_title=card.parent_title, links=links, openreview_id=openreview, has_poster=poster,
                 topic=topic, institutions=institutions)


def _schedule(source: SourceSettings, cache: BuildCache, client: Optional[PoliteClient]) -> List[ScheduleEvent]:
    try:
        if client is None:
            page = cache.read_schedule()
            log.info('offline: using %s', cache.schedule_path)
        else:
            page = client.get_text(source.schedule_url, timeout=180)
    except (FetchError, CacheError) as exc:
        raise SourceError(f'schedule unavailable: {exc}') from None
    cards = parse_schedule(page, source)
    if len(cards) < source.min_events:
        raise SourceError(f'only {len(cards)} events parsed (< {source.min_events}): the schedule layout may have changed')
    if client is not None:
        cache.save_schedule(page)
    return cards


def _crawl(conf: Conference, client: PoliteClient, cache: BuildCache, details: Dict[str, Any],
           cards: List[ScheduleEvent], limit: int) -> None:
    crawler = DetailCrawler(client, conf.source, details, conf.location_keys, save=lambda: cache.save_details(details))
    try:
        stats = crawler.run(cards, limit)
        log.info('detail crawl: %(fetched)d pages, %(requests)d requests, %(bytes)d bytes, %(seconds)ss, '
                 '%(retries)d retries, %(errors)d errors, %(blocked)d blocked by robots.txt, %(pending)d still pending',
                 stats)
    except Exception as exc:  # details are a bonus: never fail the build over them
        log.warning('detail crawl aborted: %s', exc)
    finally:
        if crawler.stats['fetched']:
            try:
                cache.save_details(details)
            except (CacheError, OSError) as exc:
                log.error('could not save the detail cache: %s', exc)
