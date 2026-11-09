"""Source adapters: where a conference's program comes from. `source.type` in conference.json picks one.

An adapter is a module (or subpackage) of this package that defines ADAPTER, an object with:

  type      the `source.type` it reads
  scraper   True when it fetches web pages: --offline, --no-crawl, --max-new, --delay and
            --papers-export apply to it, and `check` reads its cache only with --offline
  settings(source, config, checker) -> settings
            checks the rest of `source` (problems go to the checker) and returns the adapter's
            own settings object, kept as Conference.source
  load(conference, options) -> model.Program
            the normalized program; raises SourceError when there is nothing usable to build from

Adapters register themselves by being here: no list to edit.
"""
from __future__ import annotations

import importlib
import pkgutil
from dataclasses import dataclass
from functools import lru_cache
from typing import TYPE_CHECKING, Any, Dict, Optional, Protocol

if TYPE_CHECKING:
    from ..checks import Checker
    from ..config import Conference
    from ..model import Program


class SourceError(RuntimeError):
    """The program could not be read; nothing is written and the previous site stays as it is."""


@dataclass(frozen=True)
class LoadOptions:
    offline: bool = False                # no network: read the cache only
    crawl: bool = True                   # fetch new detail pages
    max_new: Optional[int] = None        # detail pages per run (None: the adapter's default)
    delay: Optional[float] = None        # seconds between requests (None: the adapter's default)
    papers_export: bool = False          # opt-in extra download


class Adapter(Protocol):
    type: str
    scraper: bool

    def settings(self, source: Dict[str, Any], config: Dict[str, Any], checker: Checker) -> Any: ...

    def load(self, conf: Conference, options: LoadOptions) -> Program: ...


@lru_cache(maxsize=None)
def adapters() -> Dict[str, Adapter]:
    """source.type -> adapter, for every module here that defines ADAPTER."""
    found = {}
    for info in pkgutil.iter_modules(__path__):
        adapter = getattr(importlib.import_module(f'{__name__}.{info.name}'), 'ADAPTER', None)
        if adapter is not None:
            found[adapter.type] = adapter
    return found
