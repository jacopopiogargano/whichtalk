"""The `events-file` source: the program as a JSON file in the conference folder.

  "source": {"type": "events-file", "path": "events.json"}

  {"format": "whichtalk-events", "version": 1, "events": [
    {"id": 101, "kind": "Keynote", "title": "...", "authors": ["..."], "room": "Hall A", "location": "LIS",
     "start": "2026-10-12T09:00", "end": "2026-10-12T10:00" (or "durationMinutes": 60), "parent": 100,
     "abstract": "...", "links": [["Slides", "https://..."]], "openreviewId": "...", "poster": true,
     "topic": "...", "institutions": ["..."]}, ...]}

id, kind and title are required. A time without an offset is local time at the event's location
(its utcOffsetHours); "Z" or "+02:00" give the offset explicitly. A missing start means the time is
not announced yet. A null value counts as a missing field. Every problem is reported at once,
with the event's index and id.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

from ..checks import Checker
from ..model import Event, Program
from . import LoadOptions, SourceError

if TYPE_CHECKING:
    from ..config import Conference

log = logging.getLogger(__name__)

FORMAT = 'whichtalk-events'
VERSION = 1
FIELDS = frozenset({'id', 'kind', 'title', 'authors', 'room', 'location', 'start', 'end', 'durationMinutes',
                    'parent', 'abstract', 'links', 'openreviewId', 'poster', 'topic', 'institutions'})
TIME = re.compile(r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$')
TIME_HELP = 'like "2026-10-12T09:00" (local time at the location), "2026-10-12T09:00+02:00" or "2026-10-12T07:00Z"'
MAX_ID = 2 ** 53 - 1                     # the largest id a browser number holds exactly


@dataclass(frozen=True)
class Settings:
    path: str                            # relative to the conference folder


class EventsFile:
    type = 'events-file'
    scraper = False

    def settings(self, source: Dict[str, Any], config: Dict[str, Any], v: Checker) -> Settings:
        v.known_keys(source, ('type', 'path'), 'source')
        path = v.text(source, 'path', 'source.') if 'path' in source else 'events.json'
        if Path(path).is_absolute() or '..' in Path(path).parts:
            v.fail('source.path must be a file inside the conference folder')
        return Settings(path)

    def load(self, conf: Conference, options: LoadOptions) -> Program:
        path = conf.folder / conf.source.path
        try:
            doc = json.loads(path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            raise SourceError(f'{path} does not exist') from None
        except (OSError, ValueError) as exc:
            raise SourceError(f'{path} is not readable JSON: {exc}') from None
        events, abstracts = parse_events(doc, conf.data, heading=f'invalid {path.name}')
        return Program(events, abstracts, source_url=conf.data['page']['officialSchedule'])


ADAPTER = EventsFile()


def parse_events(doc: Any, config: Dict[str, Any], heading: str = 'invalid events file') -> Tuple[List[Event], Dict[int, str]]:
    """The events in file order and their abstracts, or SourceError listing every problem."""
    v = Checker()
    if not isinstance(doc, dict):
        v.fail(f'the file must be an object: {{"format": "{FORMAT}", "version": {VERSION}, "events": [...]}}')
        v.done(heading, SourceError)
    v.known_keys(doc, ('format', 'version', 'events'), 'the file')
    if doc.get('format') != FORMAT:
        v.fail(f'format must be "{FORMAT}"')
    if doc.get('version') != VERSION:
        v.fail(f'version must be {VERSION}')
    items = doc.get('events')
    if not isinstance(items, list):
        v.fail('events must be a list')
        items = []

    places = {loc['key']: loc['utcOffsetHours'] for loc in config['locations'] if not loc.get('all')}
    events: List[Event] = []
    abstracts: Dict[int, str] = {}
    where_of: Dict[int, str] = {}        # position in `events` -> message prefix
    first_index: Dict[int, int] = {}
    for i, item in enumerate(items):
        event, where = _event(v, i, item, places, config['defaultLocation'])
        if event is None:
            continue
        if event.id in first_index:
            v.fail(f'{where}id {event.id} is already used by events[{first_index[event.id]}]')
            continue
        first_index[event.id] = i
        where_of[len(events)] = where
        events.append(event)
        text = item.get('abstract')
        if isinstance(text, str) and text.strip():
            abstracts[event.id] = text.strip()
    _link_parents(v, events, where_of)
    v.done(heading, SourceError)
    _warn_unused(events, config)
    return events, abstracts


def _event(v: Checker, i: int, item: Any, places: Dict[str, float], default_location: str) -> Tuple[Optional[Event], str]:
    if not isinstance(item, dict):
        v.fail(f'events[{i}] must be an object')
        return None, ''
    item = {key: value for key, value in item.items() if value is not None}
    event_id = item.get('id')
    valid_id = isinstance(event_id, int) and not isinstance(event_id, bool) and 0 < event_id <= MAX_ID
    where = f'events[{i}] (id {event_id}): ' if valid_id else f'events[{i}]: '
    if not valid_id:
        v.fail(f'{where}id must be a positive whole number')
    for key in item:
        if key not in FIELDS:
            v.fail(f'{where}unknown field {key!r}')
    kind = v.text(item, 'kind', where)
    title = v.text(item, 'title', where)

    location = item.get('location', default_location)
    if not (isinstance(location, str) and location in places):
        v.fail(f'{where}location {location!r} must be one of {", ".join(places)}')
        location = default_location
    start, end = _times(v, item, where, places[location])

    links = item.get('links', [])
    if not (isinstance(links, list) and all(_is_link(x) for x in links)):
        v.fail(f'{where}links must be a list of ["label", "https://..."] pairs')
        links = []
    parent = item.get('parent')
    if parent is not None and not (isinstance(parent, int) and not isinstance(parent, bool)):
        v.fail(f'{where}parent must be the id of another event')
        parent = None
    poster = item.get('poster', False)
    if not isinstance(poster, bool):
        v.fail(f'{where}poster must be true or false')
    if 'abstract' in item and not isinstance(item['abstract'], str):
        v.fail(f'{where}abstract must be a string')
    event = Event(
        id=event_id if valid_id else 0, kind=kind, title=title,
        authors=_names(v, item, 'authors', where), room=v.optional_text(item, 'room', where, allow_empty=True),
        start=start, end=end, location=location, parent_id=parent, links=[list(x) for x in links],
        openreview_id=v.optional_text(item, 'openreviewId', where), has_poster=poster is True,
        topic=v.optional_text(item, 'topic', where, allow_empty=True),
        institutions=_names(v, item, 'institutions', where),
    )
    return (event if valid_id else None), where


def _times(v: Checker, item: Dict[str, Any], where: str, offset_hours: float) -> Tuple[Optional[int], Optional[int]]:
    has_end, has_duration = 'end' in item, 'durationMinutes' in item
    if 'start' not in item:
        if has_end or has_duration:
            v.fail(f'{where}{"end" if has_end else "durationMinutes"} needs a start (leave both out while the time is not known)')
        return None, None
    start = _time(v, item, 'start', where, offset_hours)
    if has_end and has_duration:
        v.fail(f'{where}give end or durationMinutes, not both')
        return start, None
    if has_end:
        end = _time(v, item, 'end', where, offset_hours)
        if start is not None and end is not None and end <= start:
            v.fail(f'{where}end must be after start')
            return start, None
        return start, end
    if has_duration:
        minutes = item['durationMinutes']
        if not (isinstance(minutes, (int, float)) and not isinstance(minutes, bool) and minutes > 0):
            v.fail(f'{where}durationMinutes must be a positive number')
            return start, None
        return start, None if start is None else start + round(minutes * 60)
    v.fail(f'{where}start needs an end or a durationMinutes')
    return start, None


def _time(v: Checker, item: Dict[str, Any], key: str, where: str, offset_hours: float) -> Optional[int]:
    value = item[key]
    m = TIME.match(value) if isinstance(value, str) else None
    if not m:
        v.fail(f'{where}{key} must be a time {TIME_HELP}, not {value!r}')
        return None
    *parts, zone = m.groups()
    if zone is None:
        tz = dt.timezone(dt.timedelta(hours=offset_hours))
    elif zone == 'Z':
        tz = dt.timezone.utc
    elif int(zone[1:3]) > 14 or int(zone[4:6]) > 59:
        v.fail(f'{where}{key} {value!r} has no valid UTC offset (from -12:00 to +14:00)')
        return None
    else:
        sign = -1 if zone[0] == '-' else 1
        tz = dt.timezone(sign * dt.timedelta(hours=int(zone[1:3]), minutes=int(zone[4:6])))
    try:
        moment = dt.datetime(*(int(p or 0) for p in parts), tzinfo=tz)
    except ValueError as exc:
        v.fail(f'{where}{key} {value!r} is not a valid date and time ({exc})')
        return None
    return int(moment.timestamp())


def _names(v: Checker, item: Dict[str, Any], key: str, where: str) -> List[str]:
    value = item.get(key, [])
    if isinstance(value, list) and all(isinstance(x, str) and x.strip() for x in value):
        return [x.strip() for x in value]
    v.fail(f'{where}{key} must be a list of names')
    return []


def _is_link(value: Any) -> bool:
    return (isinstance(value, list) and len(value) == 2 and all(isinstance(x, str) for x in value)
            and bool(value[0].strip()) and value[1].startswith(('https://', 'http://')))


def _link_parents(v: Checker, events: List[Event], where_of: Dict[int, str]) -> None:
    """Every parent exists and no chain of parents loops; children get their parent's title."""
    by_id = {e.id: e for e in events}
    parent_of = {}
    for n, e in enumerate(events):
        if e.parent_id is None:
            continue
        if e.parent_id == e.id:
            v.fail(f'{where_of[n]}parent is the event itself')
        elif e.parent_id not in by_id:
            v.fail(f'{where_of[n]}parent {e.parent_id} is not the id of any event')
        else:
            parent_of[e.id] = e.parent_id
            e.parent_title = by_id[e.parent_id].title
    reported = set()
    for first in parent_of:
        path, node = [], first
        while node in parent_of and node not in path:
            path.append(node)
            node = parent_of[node]
        if node in path:
            loop = path[path.index(node):]
            if frozenset(loop) not in reported:
                reported.add(frozenset(loop))
                v.fail('parents form a loop: ' + ' -> '.join(str(x) for x in loop + [loop[0]]))


def _warn_unused(events: List[Event], config: Dict[str, Any]) -> None:
    """Valid but probably not what was meant."""
    kinds = {kind for track in config['tracks'] for kind in track['kinds']}
    stray = Counter(e.kind for e in events if e.kind not in kinds)
    if stray:
        log.warning('kinds in no track, shown under the fallback track %r: %s', config['fallbackTrack'],
                    ', '.join(f'{kind} ({n})' for kind, n in sorted(stray.items())))
    urls = config.get('urls') or {}
    for count, key, field in ((sum(e.has_poster for e in events), 'poster', 'poster: true'),
                              (sum(bool(e.openreview_id) for e in events), 'openreview', 'openreviewId')):
        if count and not urls.get(key):
            log.warning('%d events set %s, but urls.%s is empty, so no link is shown', count, field, key)
