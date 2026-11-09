"""The `source` block of a neurips-cc conference: schedule and detail-page addresses, crawl limits and
the rules that assign each schedule card to a conference location."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, FrozenSet, Pattern, Tuple

from ...checks import Checker

FIELDS = ('type', 'scheduleUrl', 'papersExportUrl', 'userAgent', 'crawlDelaySeconds', 'maxNewPerRun', 'minEvents',
          'schedule', 'locationRules', 'detailPages', 'paperKinds', 'linkPatterns')


@dataclass(frozen=True)
class LocationRules:
    """How a schedule card is assigned to a conference location."""
    names: Tuple[Tuple[str, str], ...]          # (word in kind/parent/title, location key)
    title_kinds: FrozenSet[str]                  # kinds whose title may name the location
    venues: Tuple[Tuple[str, Pattern[str]], ...]
    untimed: Dict[str, str]                      # kind -> location for cards without a time
    untimed_default: str
    hours_location: str                          # cards starting in [hours_from, hours_until) local time
    hours_from: float
    hours_until: float
    hours_otherwise: str


@dataclass(frozen=True)
class DetailPages:
    base: str
    location_slugs: Dict[str, str]
    kind_paths: Dict[str, str]
    plain_url_on_404: FrozenSet[str]             # kind paths that fall back to base/<id> on a 404
    skip_kinds: FrozenSet[str]


@dataclass(frozen=True)
class SourceSettings:
    schedule_url: str
    papers_export_url: str
    user_agent: str
    crawl_delay: float
    max_new: int
    min_events: int
    year: int
    zone_label: str
    utc_offset_hours: float
    rules: LocationRules
    details: DetailPages
    paper_kinds: FrozenSet[str]
    openreview_link: Pattern[str]
    poster_link: Pattern[str]


def parse_settings(src: Dict[str, Any], config: Dict[str, Any], v: Checker) -> SourceSettings:
    v.known_keys(src, FIELDS, 'source')
    sched = v.mapping(src.get('schedule'), 'source.schedule')
    rules = v.mapping(src.get('locationRules'), 'source.locationRules')
    hours = v.mapping(rules.get('localHours'), 'source.locationRules.localHours')
    details = v.mapping(src.get('detailPages'), 'source.detailPages')
    links = v.mapping(src.get('linkPatterns'), 'source.linkPatterns')
    venues = []
    for i, item in enumerate(v.items(rules, 'venues', 'source.locationRules.')):
        venues.append((v.text(item, 'location', f'venues[{i}].'), v.regex(item, 'pattern', f'venues[{i}].')))
    names = v.mapping(rules.get('names'), 'source.locationRules.names')
    location_rules = LocationRules(
        names=tuple((str(k), str(val)) for k, val in names.items()),
        title_kinds=frozenset(v.strings(rules, 'titleKinds', 'source.locationRules.')),
        venues=tuple(venues),
        untimed={str(k): str(val) for k, val in v.mapping(rules.get('untimed'), 'untimed').items()},
        untimed_default=v.text(rules, 'untimedDefault', 'source.locationRules.'),
        hours_location=v.text(hours, 'location', 'localHours.'),
        hours_from=v.number(hours, 'from', 'localHours.'),
        hours_until=v.number(hours, 'until', 'localHours.'),
        hours_otherwise=v.text(hours, 'otherwise', 'localHours.'),
    )
    keys = {loc.get('key') for loc in config.get('locations') or [] if isinstance(loc, dict)}
    named = [key for _, key in location_rules.names] + [key for key, _ in venues] + \
        list(location_rules.untimed.values()) + [location_rules.hours_location]
    for key in sorted(set(named) - keys):
        v.fail(f'source.locationRules: {key!r} is not a location key')
    detail_pages = DetailPages(
        base=v.text(details, 'base', 'source.detailPages.').rstrip('/'),
        location_slugs=dict(v.mapping(details.get('locationSlugs'), 'detailPages.locationSlugs')),
        kind_paths=dict(v.mapping(details.get('kindPaths'), 'detailPages.kindPaths')),
        plain_url_on_404=frozenset(v.strings(details, 'plainUrlOn404', 'source.detailPages.')),
        skip_kinds=frozenset(v.strings(details, 'skipKinds', 'source.detailPages.')),
    )
    return SourceSettings(
        schedule_url=v.text(src, 'scheduleUrl', 'source.'),
        papers_export_url=v.text(src, 'papersExportUrl', 'source.'),
        user_agent=v.text(src, 'userAgent', 'source.'),
        crawl_delay=max(1.0, v.number(src, 'crawlDelaySeconds', 'source.')),
        max_new=int(v.number(src, 'maxNewPerRun', 'source.', minimum=0)),
        min_events=int(v.number(src, 'minEvents', 'source.', minimum=0)),
        year=int(v.number(sched, 'year', 'source.schedule.')),
        zone_label=v.text(sched, 'zoneLabel', 'source.schedule.'),
        utc_offset_hours=v.number(sched, 'utcOffsetHours', 'source.schedule.'),
        rules=location_rules,
        details=detail_pages,
        paper_kinds=frozenset(v.strings(src, 'paperKinds', 'source.')),
        openreview_link=v.regex(links, 'openreview', 'source.linkPatterns.'),
        poster_link=v.regex(links, 'poster', 'source.linkPatterns.'),
    )
