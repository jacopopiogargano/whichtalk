"""Reading neurips.cc pages: the schedule (one card per event) and event detail pages."""
from __future__ import annotations

import datetime as dt
import html
import re
from dataclasses import dataclass
from typing import List, Optional, Tuple
from urllib.parse import urlsplit

from ...tex import tex_to_text
from .settings import LocationRules, SourceSettings

CARD_START = re.compile(r'<div class="maincard[^"]*" id="maincard_')
CARD_ID = re.compile(r'(\d+)"')
CARD_KIND = re.compile(r"maincardType'>(.*?)</div>", re.S)
CARD_HEADER = re.compile(r'<div class="maincardHeader">(.*?)</div>', re.S)
CARD_TITLE = re.compile(r'<div class="maincardBody">(.*?)</div>', re.S)
CARD_PEOPLE = re.compile(r'<div class="maincardFooter">(.*?)</div>', re.S)
CARD_PARENT = re.compile(r'showParentSession=(\d+)">\s*(.*?)</a>', re.S)
CARD_LINK = re.compile(r'<a href="([^"]+)"[^>]*title="([^"]*)"')
TAG = re.compile(r'<[^>]+>')
WHITESPACE = re.compile(r'\s+')
TIME_FORMAT = '%Y %b %d %I:%M %p'


@dataclass
class ScheduleEvent:
    id: int
    kind: str
    title: str
    people: str                 # the card footer: authors or speakers joined by ' ⋅ '
    room: str
    start: Optional[int]        # epoch seconds, None when the card has no time yet
    end: Optional[int]
    location: str
    parent_id: Optional[int]
    parent_title: str
    links: List[List[str]]      # [label, absolute url]

    @property
    def authors(self) -> List[str]:
        return [name.strip() for name in self.people.split(' ⋅ ') if name.strip()]


def clean_html(fragment: Optional[str]) -> str:
    """Text of an HTML fragment: tags dropped, entities decoded, whitespace collapsed."""
    return WHITESPACE.sub(' ', html.unescape(TAG.sub(' ', fragment or ''))).strip()


def unescape_repeatedly(text: str) -> str:
    """Some sources escape several times over (&amp;amp;lt;); decode until nothing changes."""
    for _ in range(8):
        decoded = html.unescape(text)
        if decoded == text:
            return decoded
        text = decoded
    return text


def _first(pattern: 're.Pattern[str]', chunk: str) -> str:
    m = pattern.search(chunk)
    return clean_html(m.group(1) if m else '')


def _header_pattern(zone_label: str) -> 're.Pattern[str]':
    return re.compile(
        r'^\w{3} (\w{3}) (\d{1,2}) (\d{1,2}:\d{2} [AP]M) -- (\d{1,2}:\d{2} [AP]M) \(' + re.escape(zone_label) + r'\)'
        r'\s*(?:@\s*(.*?))?\s*(?:None)?$')


def parse_schedule(page: str, source: SourceSettings) -> List[ScheduleEvent]:
    zone = dt.timezone(dt.timedelta(hours=source.utc_offset_hours))
    header_re = _header_pattern(source.zone_label)
    parts = urlsplit(source.schedule_url)
    origin = f'{parts.scheme}://{parts.netloc}'
    events = []
    for chunk in CARD_START.split(page)[1:]:
        chunk = chunk.split('<div class="showDetailBtn"', 1)[0].split('<script', 1)[0]
        id_match = CARD_ID.match(chunk)
        if not id_match:
            continue
        kind = _first(CARD_KIND, chunk)
        title = tex_to_text(_first(CARD_TITLE, chunk))
        parent = CARD_PARENT.search(chunk)
        parent_id, parent_title = (int(parent.group(1)), clean_html(parent.group(2))) if parent else (None, '')
        start = end = None
        room = ''
        header = header_re.match(_first(CARD_HEADER, chunk))
        if header:
            start, end = _times(source.year, zone, *header.group(1, 2, 3, 4))
            room = (header.group(5) or '').strip()
        events.append(ScheduleEvent(
            id=int(id_match.group(1)), kind=kind, title=title, people=_first(CARD_PEOPLE, chunk), room=room,
            start=start, end=end, location=assign_location(source.rules, zone, kind, title, parent_title, room, start),
            parent_id=parent_id, parent_title=parent_title, links=_card_links(chunk, origin),
        ))
    return events


def _times(year: int, zone: dt.tzinfo, month: str, day: str, begins: str, ends: str) -> Tuple[int, int]:
    """Epoch seconds; an end at or before the start means the event runs past midnight."""
    start = dt.datetime.strptime(f'{year} {month} {day} {begins}', TIME_FORMAT).replace(tzinfo=zone)
    end = dt.datetime.strptime(f'{year} {month} {day} {ends}', TIME_FORMAT).replace(tzinfo=zone)
    if end <= start:
        end += dt.timedelta(days=1)
    return int(start.timestamp()), int(end.timestamp())


def _card_links(chunk: str, origin: str) -> List[List[str]]:
    links = []
    for href, label in CARD_LINK.findall(chunk.split('maincardFooter', 1)[-1]):
        href = html.unescape(href)
        if href.startswith('/'):
            href = origin + href
        if href.startswith(('https://', 'http://')):
            links.append([clean_html(label) or 'Link', href])
    return links


def assign_location(rules: LocationRules, zone: dt.tzinfo, kind: str, title: str, parent: str, room: str,
                    start: Optional[int]) -> str:
    """A location named in the kind or parent session wins, then the room, then the local start time."""
    named_in = f'{kind} {parent} ' + (title if kind in rules.title_kinds else '')
    for word, key in rules.names:
        if re.search(rf'\b{re.escape(word)}\b', named_in):
            return key
    if room:
        for key, pattern in rules.venues:
            if pattern.search(room):
                return key
    if start is None:
        return rules.untimed.get(kind, rules.untimed_default)
    local = dt.datetime.fromtimestamp(start, zone)
    hour = local.hour + local.minute / 60
    return rules.hours_location if rules.hours_from <= hour < rules.hours_until else rules.hours_otherwise


# ---------------------------------------------------------------- detail pages
DETAIL_BOX = (re.compile(r'<div class="abstract-text-inner">'), re.compile(r'<div id="abstractExample">'))
DIV_TAG = re.compile(r'<(/?)div\b[^>]*>')
ABSTRACT_LABEL = re.compile(r'(?is)^\s*<span[^>]*>\s*Abstract:?\s*</span>')
SCRIPT_OR_STYLE = re.compile(r'(?s)<(script|style)[^>]*>.*?</\1>')
LINE_BREAK = re.compile(r'(?i)<br\s*/?>')
BLOCK_END = re.compile(r'(?i)</(p|li|div|h\d)>')
LIST_ITEM = re.compile(r'(?i)<li[^>]*>')
PARAGRAPH_GAP = re.compile(r'\n\s*\n')
INLINE_SPACE = re.compile(r'[ \t\r\f\v]+')
MAX_DETAIL_CHARS = 8000


def parse_detail(page: str) -> str:
    """The description or abstract as plain paragraphs separated by blank lines ('' if none).
    Paper and tutorial pages use .abstract-text-inner; expo and older pages use #abstractExample."""
    opening = DETAIL_BOX[0].search(page) or DETAIL_BOX[1].search(page)
    if not opening:
        return ''
    inner = _div_contents(page, opening.end())
    inner = ABSTRACT_LABEL.sub('', inner)
    inner = SCRIPT_OR_STYLE.sub('', inner)
    inner = LINE_BREAK.sub('\n', inner)
    inner = BLOCK_END.sub('\n\n', inner)
    inner = LIST_ITEM.sub('• ', inner)
    text = unescape_repeatedly(TAG.sub(' ', inner))
    paragraphs = (tex_to_text(INLINE_SPACE.sub(' ', p).strip()) for p in PARAGRAPH_GAP.split(text))
    return '\n\n'.join(p for p in paragraphs if p)[:MAX_DETAIL_CHARS]


def _div_contents(page: str, start: int) -> str:
    """Inner HTML of the <div> whose opening tag ends at `start` (to the end if never closed)."""
    depth, reached = 1, start
    for tag in DIV_TAG.finditer(page, start):
        depth += -1 if tag.group(1) else 1
        if depth == 0:
            return page[start:tag.start()]
        reached = tag.end()
    return page[start:reached]
