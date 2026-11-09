"""The program as every source adapter hands it to the build: normalized events and their abstracts."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass
class Event:
    id: int
    kind: str
    title: str
    authors: List[str] = field(default_factory=list)
    room: str = ''
    start: Optional[int] = None          # epoch seconds; None = time to be announced
    end: Optional[int] = None
    location: str = ''                   # a location key (a scraper may also use its own codes, e.g. "TBA")
    parent_id: Optional[int] = None      # the session this item belongs to
    parent_title: str = ''
    links: List[List[str]] = field(default_factory=list)   # [label, absolute url], beyond the two below
    openreview_id: str = ''
    has_poster: bool = False             # a poster image exists at urls.poster
    topic: str = ''
    institutions: List[str] = field(default_factory=list)

    @property
    def duration_minutes(self) -> int:
        return round((self.end - self.start) / 60) if self.start and self.end else 0


@dataclass
class Program:
    events: List[Event]
    abstracts: Dict[int, str]            # event id -> description or abstract (non-empty ones only)
    source_url: str                      # where the schedule was read from
    enriched: bool = False               # extra paper data (topics, institutions) was used
