"""The whichtalk.com homepage: src/home.html with a card for every conference whose home.listed is true.

The template has `<!-- @conferences -->` on its own line where the cards go, and {{nowFor}} in its
descriptions (" Now for A, B and C." from the listed names, or nothing when none is listed). Cards
are sorted by conference id and link to each conference's output folder relative to docs/. The
static files the page refers to (icons, fonts) are copied next to it.
"""
from __future__ import annotations

import html
import re
from pathlib import Path
from typing import Iterable, List

from .config import Conference
from .files import write_text_atomic
from .site import SiteError, copy_static, fill_placeholders

DOCS = 'docs'
MARKER = re.compile(r'^([ \t]*)<!--\s*@conferences\s*-->[ \t]*\n', re.M)
LOCAL_FILE = re.compile(r'''(?:href|src)="([^"/:?#]+)"|url\(([^)"'/:]+)\)''')


def listed(conferences: Iterable[Conference]) -> List[Conference]:
    return sorted((c for c in conferences if c.home['listed']), key=lambda c: c.id)


def join_names(names: List[str]) -> str:
    """'A', 'A and B', 'A, B and C'."""
    return f'{", ".join(names[:-1])} and {names[-1]}' if len(names) > 1 else ''.join(names)


def card(conf: Conference, indent: str) -> str:
    href = Path(conf.data['output']).relative_to(DOCS).as_posix() + '/'
    home = conf.home
    return (f'{indent}<a class="conf" href="{html.escape(href)}">\n'
            f'{indent}  <span class="yr" aria-hidden="true">{html.escape(home["badge"])}</span>\n'
            f'{indent}  <span><h3>{html.escape(conf.name)}</h3><p>{html.escape(home["summary"])}</p></span>\n'
            f'{indent}  <span class="go">Open planner</span>\n'
            f'{indent}</a>\n')


def render_home(template: str, conferences: Iterable[Conference]) -> str:
    shown = listed(conferences)
    names = join_names([c.name for c in shown])
    page = fill_placeholders(template, {'nowFor': f' Now for {names}.' if names else ''})
    if len(MARKER.findall(page)) != 1:
        raise SiteError('the homepage template must contain <!-- @conferences --> exactly once, on a line of its own')
    return MARKER.sub(lambda m: ''.join(card(c, m.group(1)) for c in shown), page)


def write_home(page: str, out: Path, static: Path) -> None:
    """The page, then the static files it refers to by a plain file name, plus og.png (link
    previews need an absolute URL, so the page names it as https://whichtalk.com/og.png)."""
    write_text_atomic(out, page)
    names = {a or b for a, b in LOCAL_FILE.findall(page)} | {'og.png'}
    copy_static(static, out.parent, {}, only=sorted(names))
