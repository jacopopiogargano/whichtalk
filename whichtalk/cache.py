"""A scraper's cache folder (conferences/<id>/cache/): what earlier builds fetched, so later builds
can skip (or avoid) the network.

  cache/schedule.html  the last schedule page that parsed (written by every online build)
  cache/details.json   {"<event id>": {"s": status, "t": ISO time, "a": text, "v": parser version}}
  cache/papers.json    {"fetchedAt": ISO time, "papers": {"<id>": [topic, [institutions]]}}

details.json took thousands of polite requests to fill. It is only ever rewritten whole, with
every entry it was read with, and never when it could not be read.
"""
from __future__ import annotations

import datetime as dt
import logging
from pathlib import Path
from typing import Any, Dict, List, Tuple

from .files import read_json, write_json_atomic, write_text_atomic

log = logging.getLogger(__name__)

Papers = Dict[int, Tuple[str, List[str]]]


class CacheError(RuntimeError):
    pass


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


class BuildCache:
    def __init__(self, folder: Path) -> None:
        self.folder = folder
        self.schedule_path = folder / 'schedule.html'
        self.details_path = folder / 'details.json'
        self.papers_path = folder / 'papers.json'
        self._details_floor = 0
        self.details_writable = True

    # schedule page
    def read_schedule(self) -> str:
        if not self.schedule_path.is_file():
            raise CacheError(f'{self.schedule_path} is missing: run one online build first')
        return self.schedule_path.read_text(encoding='utf-8')

    def save_schedule(self, page: str) -> None:
        write_text_atomic(self.schedule_path, page)

    # detail pages
    def load_details(self) -> Dict[str, Any]:
        if not self.details_path.exists():
            return {}
        try:
            details = read_json(self.details_path)
            if not isinstance(details, dict):
                raise ValueError('top level is not an object')
        except (OSError, ValueError) as exc:
            self.details_writable = False
            log.error('%s is unreadable (%s): building without descriptions and leaving the file untouched',
                      self.details_path, exc)
            return {}
        self._details_floor = len(details)
        return details

    def save_details(self, details: Dict[str, Any]) -> None:
        if not self.details_writable:
            raise CacheError(f'refusing to overwrite the unreadable {self.details_path}')
        if len(details) < self._details_floor:
            raise CacheError(f'refusing to shrink {self.details_path} from {self._details_floor} '
                             f'to {len(details)} entries')
        write_json_atomic(self.details_path, details)
        self._details_floor = len(details)

    # papers export (topics, institutions)
    def load_papers(self) -> Papers:
        if not self.papers_path.exists():
            return {}
        try:
            rows = read_json(self.papers_path).get('papers') or {}
            return {int(key): (value[0], list(value[1])) for key, value in rows.items()}
        except (OSError, ValueError, AttributeError, TypeError, IndexError) as exc:
            log.warning('ignoring unreadable %s: %s', self.papers_path.name, exc)
            return {}

    def save_papers(self, rows: Dict[str, List[Any]]) -> None:
        write_json_atomic(self.papers_path, {'fetchedAt': now_iso(), 'papers': rows})
