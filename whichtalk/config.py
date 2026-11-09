"""Conference settings: conferences/<id>/conference.json, loaded and checked before anything is fetched.

Each conference is a folder conferences/<id>/ (the folder name is the id) with conference.json and
whatever its source reads (events.json, or a scraper's cache/). Folders whose name starts with '_'
(the template) are not conferences. Optional fields get their defaults in catalog_subset(), so the
app can rely on every key being present. `source.type` picks the adapter (whichtalk/sources/), which
checks the rest of `source` itself.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from .checks import Checker, ConfigError
from .sources import Adapter, adapters

__all__ = ['Conference', 'ConfigError', 'conference_ids', 'load_conference', 'parse_conference']

ROOT = Path(__file__).resolve().parent.parent
CONFERENCES_DIR = ROOT / 'conferences'
CONFIG_FILE = 'conference.json'
CONFERENCE_ID = re.compile(r'^[a-z0-9][a-z0-9-]*$')
PAGE_FIELDS = ('title', 'description', 'ogDescription', 'canonical', 'officialSchedule', 'organizer', 'sourceName')
URL_FIELDS = {'event': '{id}', 'poster': '{id}', 'openreview': '{openreviewId}'}
LOCATION_FIELDS = ('key', 'name', 'utcOffsetHours', 'zone', 'venue', 'all')
TRACK_FIELDS = ('key', 'label', 'singular', 'kinds', 'papers')
VENUE_FIELDS = ('name', 'location', 'about', 'zones', 'walkMinutes', 'sameZoneMinutes', 'sameBuildingBaseMinutes',
                'minutesPerLevel', 'unknownLevelChange', 'upstairsMinutes')
VENUE_MINUTES = VENUE_FIELDS[5:]
THEME_COLORS = ('accent', 'accentMark', 'accentSoft')
DEFAULT_UNTIMED_NOTE = 'Not yet in the public schedule. This list updates when the organizers assign times.'


@dataclass(frozen=True)
class Conference:
    id: str
    name: str
    root: Path                   # the project: src/, static/, vendor/ and the output folders
    folder: Path                 # conferences/<id>/
    output: Path
    data: Dict[str, Any]         # conference.json as written
    adapter: Adapter             # reads the program (whichtalk/sources/)
    source: Any                  # the adapter's settings

    @property
    def location_keys(self) -> List[str]:
        return [loc['key'] for loc in self.data['locations']]

    @property
    def home(self) -> Dict[str, Any]:
        """Homepage card: listed (default false), summary, badge."""
        home = self.data.get('home') or {}
        return {'listed': bool(home.get('listed')), 'summary': home.get('summary', ''), 'badge': home.get('badge', '')}

    def catalog_subset(self) -> Dict[str, Any]:
        """The part of the config the browser app reads from the catalog, every optional key filled in."""
        d = self.data
        urls = d.get('urls') or {}
        page = d['page']
        return {
            'id': d['id'],
            'name': d['name'],
            'shortName': d['shortName'],
            'storageNamespace': d.get('storageNamespace') or f"whichtalk:{d['id']}:",
            'urls': {key: urls.get(key) or '' for key in URL_FIELDS},
            'locations': [{**loc, 'all': bool(loc.get('all'))} for loc in d['locations']],
            'defaultLocation': d['defaultLocation'],
            'tracks': [{**t, 'papers': bool(t.get('papers'))} for t in d['tracks']],
            'hiddenTracks': d['hiddenTracks'],
            'fallbackTrack': d['fallbackTrack'],
            'kindLabels': d['kindLabels'],
            'dayLabels': [{'label': x['label'], 'title': x.get('title') or x['label'], 'tracks': x['tracks']}
                          for x in d.get('dayLabels') or []],
            'containerKinds': d.get('containerKinds') or [],
            'genericSessionTitles': d.get('genericSessionTitles') or '',
            'notes': {'untimed': (d.get('notes') or {}).get('untimed') or DEFAULT_UNTIMED_NOTE},
            'venue': d.get('venue') or None,
            'page': {key: page[key] for key in ('canonical', 'officialSchedule', 'organizer', 'sourceName')},
        }

    def template_values(self) -> Dict[str, Any]:
        """Values for the page's {{placeholders}}: conference.json with every default filled in."""
        subset = self.catalog_subset()
        return {**self.data, **subset, 'page': {**self.data['page'], **subset['page']}}

    def dev_output(self) -> Path:
        """docs/<series>/<year> -> _dev/<series>/<year>: the dev page mirrors the published layout."""
        parts = Path(self.data['output']).parts
        return self.root / '_dev' / Path(*(parts[1:] or parts))


def conference_ids(conferences_dir: Path = CONFERENCES_DIR) -> List[str]:
    """Every conference folder, sorted; '_template' and other '_' or '.' folders are skipped."""
    if not conferences_dir.is_dir():
        return []
    return sorted(p.name for p in conferences_dir.iterdir()
                  if p.name[:1] not in '_.' and (p / CONFIG_FILE).is_file())


def load_conference(ref: str, root: Path = ROOT, conferences_dir: Optional[Path] = None) -> Conference:
    """`ref` is a conference id (conferences/<id>/conference.json), or the path of a conference folder
    or of its conference.json."""
    if CONFERENCE_ID.match(ref):
        conferences = conferences_dir or CONFERENCES_DIR
        folder = conferences / ref
        if not (folder / CONFIG_FILE).is_file():
            known = ', '.join(conference_ids(conferences)) or 'none'
            raise ConfigError(f'no conference {ref!r}: {folder / CONFIG_FILE} does not exist (conferences: {known})')
    else:
        folder = Path(ref).parent if Path(ref).name == CONFIG_FILE else Path(ref)
        if not (folder / CONFIG_FILE).is_file():
            raise ConfigError(f'{ref!r} is neither a conference id nor a folder with {CONFIG_FILE}')
    file = folder / CONFIG_FILE
    try:
        data = json.loads(file.read_text(encoding='utf-8'))
    except ValueError as exc:
        raise ConfigError(f'{file} is not valid JSON: {exc}') from None
    return parse_conference(data, root, folder.resolve())


def parse_conference(data: Any, root: Path = ROOT, folder: Optional[Path] = None) -> Conference:
    """Check conference.json; ConfigError lists every problem. `folder` (whose name must be the id)
    defaults to conferences/<id>."""
    v = Checker()
    obj = v.mapping(data, 'config')
    conf_id = v.text(obj, 'id')
    if conf_id and not CONFERENCE_ID.match(conf_id):
        v.fail(f'id {conf_id!r} must be lowercase letters, digits and dashes')
    if folder is not None and conf_id != folder.name:
        v.fail(f'id {conf_id!r} must be the folder name {folder.name!r}')
    name = v.text(obj, 'name')
    v.text(obj, 'shortName')
    if 'storageNamespace' in obj:
        v.text(obj, 'storageNamespace')
    output = v.text(obj, 'output')
    if output and (Path(output).is_absolute() or '..' in Path(output).parts):
        v.fail('output must be a path inside the project')

    page = v.mapping(obj.get('page'), 'page')
    for key in PAGE_FIELDS:
        v.text(page, key, 'page.')
    _check_urls(v, v.optional_mapping(obj, 'urls'))
    loc_keys = _check_locations(v, obj)
    track_keys = _check_tracks(v, obj)
    labels = v.mapping(obj.get('kindLabels'), 'kindLabels')
    if not all(isinstance(k, str) and isinstance(val, str) for k, val in labels.items()):
        v.fail('kindLabels must map kinds to labels')
    _check_day_labels(v, obj, track_keys)
    v.optional_strings(obj, 'containerKinds')
    if obj.get('genericSessionTitles'):
        v.regex(obj, 'genericSessionTitles')
    notes = v.optional_mapping(obj, 'notes')
    v.known_keys(notes, ('untimed',), 'notes')
    v.optional_text(notes, 'untimed', 'notes.')
    if obj.get('venue') is not None:
        _check_venue(v, v.mapping(obj['venue'], 'venue'), loc_keys)
    _check_theme(v, v.optional_mapping(obj, 'theme'))
    _check_home(v, v.optional_mapping(obj, 'home'), output)

    src = v.mapping(obj.get('source'), 'source')
    source_type = src.get('type')
    adapter = adapters().get(source_type) if isinstance(source_type, str) else None
    settings = None
    if adapter is None:
        v.fail(f'source.type must be one of: {", ".join(sorted(adapters()))}')
    else:
        settings = adapter.settings(src, obj, v)
    v.done()
    return Conference(id=conf_id, name=name, root=root, folder=folder or CONFERENCES_DIR / conf_id,
                      output=root / output, data=obj, adapter=adapter, source=settings)


def _check_urls(v: Checker, urls: Dict[str, Any]) -> None:
    v.known_keys(urls, URL_FIELDS, 'urls')
    for key, token in URL_FIELDS.items():
        value = v.optional_text(urls, key, 'urls.', allow_empty=True)
        if value and (token not in value or not value.startswith(('https://', 'http://'))):
            v.fail(f'urls.{key} must be an http(s) address containing {token} (or "" for no link)')


def _check_locations(v: Checker, obj: Dict[str, Any]) -> List[str]:
    keys, all_sites = [], []
    for i, loc in enumerate(v.items(obj, 'locations')):
        where = f'locations[{i}].'
        v.known_keys(loc, LOCATION_FIELDS, f'locations[{i}]')
        keys.append(v.text(loc, 'key', where))
        v.text(loc, 'name', where)
        v.text(loc, 'zone', where)
        v.text(loc, 'venue', where, allow_empty=True)
        if not -12 <= v.number(loc, 'utcOffsetHours', where) <= 14:
            v.fail(f'{where}utcOffsetHours must be between -12 and 14')
        if v.flag(loc, 'all', where):
            all_sites.append(keys[-1])
    v.unique(keys, 'location key')
    if obj.get('defaultLocation') not in keys:
        v.fail('defaultLocation must be one of the location keys')
    if len(all_sites) > 1:
        v.fail(f'only one location may be the "all" choice, not {", ".join(all_sites)}')
    if obj.get('defaultLocation') in all_sites:
        v.fail('defaultLocation may not be the "all" location')
    return keys


def _check_tracks(v: Checker, obj: Dict[str, Any]) -> List[str]:
    keys, kinds = [], []
    for i, track in enumerate(v.items(obj, 'tracks')):
        where = f'tracks[{i}].'
        v.known_keys(track, TRACK_FIELDS, f'tracks[{i}]')
        keys.append(v.text(track, 'key', where))
        v.text(track, 'label', where)
        v.text(track, 'singular', where)
        kinds.extend(v.strings(track, 'kinds', where))
        v.flag(track, 'papers', where)
    v.unique(keys, 'track key')
    v.unique(kinds, 'track kind')
    for key in v.strings(obj, 'hiddenTracks'):
        if key not in keys:
            v.fail(f'hiddenTracks: unknown track {key!r}')
    if obj.get('fallbackTrack') not in keys:
        v.fail('fallbackTrack must be one of the track keys')
    return keys


def _check_day_labels(v: Checker, obj: Dict[str, Any], track_keys: Sequence[str]) -> None:
    if obj.get('dayLabels') is None:
        return
    for i, item in enumerate(v.items(obj, 'dayLabels', allow_empty=True)):
        where = f'dayLabels[{i}].'
        v.known_keys(item, ('label', 'title', 'tracks'), f'dayLabels[{i}]')
        v.text(item, 'label', where)
        v.optional_text(item, 'title', where)
        tracks = v.strings(item, 'tracks', where)
        if 'tracks' in item and not tracks:
            v.fail(f'{where}tracks must name at least one track')
        for key in tracks:
            if key not in track_keys:
                v.fail(f'{where}tracks: unknown track {key!r}')


def _check_venue(v: Checker, venue: Dict[str, Any], location_keys: Sequence[str]) -> None:
    v.known_keys(venue, VENUE_FIELDS, 'venue')
    v.text(venue, 'name', 'venue.')
    if 'location' in venue and venue['location'] not in location_keys:
        v.fail('venue.location must be one of the location keys')
    v.optional_text(venue, 'about', 'venue.')
    buildings = set()
    for i, zone in enumerate(v.items(venue, 'zones', 'venue.')):
        where = f'venue.zones[{i}].'
        v.known_keys(zone, ('pattern', 'building', 'level', 'zone'), f'venue.zones[{i}]')
        pattern = v.regex(zone, 'pattern', where, re.IGNORECASE)
        buildings.add(v.text(zone, 'building', where))
        label = v.text(zone, 'zone', where)
        level = zone.get('level', '')
        if not (level is None or level == '$1' or (isinstance(level, (int, float)) and not isinstance(level, bool))):
            v.fail(f'{where}level must be a number, null (unknown) or "$1"')
        if (level == '$1' or '$1' in label) and pattern.groups < 1:
            v.fail(f'{where}pattern needs a capture group for "$1"')
    walk = v.mapping(venue.get('walkMinutes'), 'venue.walkMinutes')
    for key, minutes in walk.items():
        pair = key.split('|')
        if len(pair) != 2 or pair[0] >= pair[1]:
            v.fail(f'venue.walkMinutes: {key!r} must be two building names in alphabetical order, joined by "|"')
        elif not buildings.issuperset(pair):
            v.fail(f'venue.walkMinutes: {key!r} names a building that no zone has')
        if not (isinstance(minutes, (int, float)) and not isinstance(minutes, bool) and minutes >= 0):
            v.fail(f'venue.walkMinutes[{key!r}] must be a number of minutes')
    for pair in combinations(sorted(buildings - {''}), 2):
        if '|'.join(pair) not in walk:
            v.fail(f'venue.walkMinutes needs "{"|".join(pair)}"')
    for key in VENUE_MINUTES:
        v.number(venue, key, 'venue.', minimum=0)


def _check_theme(v: Checker, theme: Dict[str, Any]) -> None:
    v.known_keys(theme, ('light', 'dark'), 'theme')
    for mode in ('light', 'dark'):
        if mode in theme:
            colors = v.mapping(theme[mode], f'theme.{mode}')
            v.known_keys(colors, THEME_COLORS, f'theme.{mode}')
            for key in THEME_COLORS:
                if key in colors:
                    v.color(colors, key, f'theme.{mode}.')


def _check_home(v: Checker, home: Dict[str, Any], output: str) -> None:
    v.known_keys(home, ('listed', 'summary', 'badge'), 'home')
    if v.flag(home, 'listed', 'home.'):
        v.text(home, 'summary', 'home.')
        v.text(home, 'badge', 'home.')
        if output and (Path(output).parts[:1] != ('docs',) or len(Path(output).parts) < 2):
            v.fail('home.listed needs an output folder under docs/ (the homepage links to it)')
    else:
        v.optional_text(home, 'summary', 'home.', allow_empty=True)
        v.optional_text(home, 'badge', 'home.', allow_empty=True)
