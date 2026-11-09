"""The catalog embedded in the page, and the abstract shards next to it.

Catalog (JSON in <script type="application/json" id="catalog-data">):

  {"format": "whichtalk-catalog", "version": 1,
   "generatedAt": ISO time, "sourceUrl": where the program was read, "enriched": extra paper data used,
   "conference": Conference.catalog_subset() (config.py),
   "abstracts": {"count": abstracts published, "shards": shard count},
   "strings": ["", ...],
   "events": {"count": n, <column>: [one value per event], ...}}

Columns (all the same length):
  id, start (epoch s, 0 = TBA), durationMinutes, parentId (0 = none)          numbers
  kind, room, location, parentTitle, topic                                   index into strings
  title, openreviewId, keywords ('|'-separated)                              plain strings
  authors                                                                     list of names
  institutions                                                                list of string indexes, or 0
  links                                                                       [[label, url], ...] or 0
  hasPoster, hasAbstract                                                      0 or 1

Abstract shards: abstracts/part-<n>.js holds every abstract whose event id % shards == n, as
  window.__whichtalkAbstracts&&window.__whichtalkAbstracts(n, {"<id>": "text", ...})
so the page can load them with a classic <script>, which also works from file://.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

from .config import Conference
from .files import write_text_atomic
from .model import Program

CATALOG_FORMAT = 'whichtalk-catalog'
CATALOG_VERSION = 1
ABSTRACT_SHARDS = 64
ABSTRACTS_DIR = 'abstracts'
ABSTRACT_CALLBACK = '__whichtalkAbstracts'


class StringTable:
    """Repeated short strings stored once; index 0 is always ''."""

    def __init__(self) -> None:
        self.values: List[str] = ['']
        self._index: Dict[str, int] = {'': 0}

    def ref(self, value: str) -> int:
        value = value or ''
        found = self._index.get(value)
        if found is None:
            found = self._index[value] = len(self.values)
            self.values.append(value)
        return found


def build_catalog(conf: Conference, program: Program, keywords: Dict[int, str], generated_at: str) -> Dict[str, Any]:
    strings = StringTable()
    names = ('id', 'kind', 'title', 'authors', 'room', 'start', 'durationMinutes', 'location', 'parentId',
             'parentTitle', 'openreviewId', 'hasPoster', 'links', 'topic', 'institutions', 'keywords',
             'hasAbstract')
    columns: Dict[str, List[Any]] = {name: [] for name in names}
    for e in program.events:
        row = {
            'id': e.id,
            'kind': strings.ref(e.kind),
            'title': e.title,
            'authors': e.authors,
            'room': strings.ref(e.room),
            'start': e.start or 0,
            'durationMinutes': e.duration_minutes,
            'location': strings.ref(e.location),
            'parentId': e.parent_id or 0,
            'parentTitle': strings.ref(e.parent_title),
            'openreviewId': e.openreview_id,
            'hasPoster': int(e.has_poster),
            'links': e.links or 0,
            'topic': strings.ref(e.topic),
            'institutions': [strings.ref(name) for name in e.institutions] or 0,
            'keywords': keywords.get(e.id, ''),
            'hasAbstract': int(e.id in program.abstracts),
        }
        for name in names:
            columns[name].append(row[name])
    return {
        'format': CATALOG_FORMAT,
        'version': CATALOG_VERSION,
        'generatedAt': generated_at,
        'sourceUrl': program.source_url,
        'enriched': program.enriched,
        'conference': conf.catalog_subset(),
        'abstracts': {'count': len(program.abstracts), 'shards': ABSTRACT_SHARDS},
        'strings': strings.values,
        'events': {'count': len(program.events), **columns},
    }


def catalog_json(catalog: Dict[str, Any]) -> str:
    """Compact JSON that is safe inside <script>: '<' is escaped so no string can close the tag."""
    return json.dumps(catalog, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')


def shard_file(shard: int) -> str:
    return f'part-{shard}.js'


def shard_scripts(texts: Dict[int, str], shards: int = ABSTRACT_SHARDS) -> Dict[str, str]:
    """File name -> contents of every non-empty shard."""
    buckets: Dict[int, Dict[str, str]] = {}
    for event_id, text in texts.items():
        buckets.setdefault(event_id % shards, {})[str(event_id)] = text
    scripts = {}
    for shard in sorted(buckets):
        body = json.dumps(buckets[shard], ensure_ascii=False, separators=(',', ':'), sort_keys=True)
        scripts[shard_file(shard)] = f'window.{ABSTRACT_CALLBACK}&&window.{ABSTRACT_CALLBACK}({shard},{body})\n'
    return scripts


def write_shards(scripts: Dict[str, str], site_dir: Path) -> None:
    """Write the shards and delete stale ones (including the files of the previous format)."""
    folder = site_dir / ABSTRACTS_DIR
    folder.mkdir(parents=True, exist_ok=True)
    for name, text in scripts.items():
        write_text_atomic(folder / name, text)
    for old in folder.glob('*.js'):
        if old.name not in scripts:
            old.unlink()
