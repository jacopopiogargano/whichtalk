"""The whichtalk.com homepage: src/home.html with a card for every conference whose home.listed is true.

The template has `<!-- @conferences -->` on its own line where the rows go (inside a list), and
these placeholders:
- {{nowFor}}: " Now for A, B and C." from the listed names, or nothing when none is listed;
- {{primaryHref}}, {{primaryLabel}}: the page's main button, which opens the planner when one
  conference is listed and points to the list otherwise.
Rows are sorted by conference id and link to each conference's output folder relative to docs/.
The static files the page refers to are copied next to it: icons and fonts by plain file name from
static/, pictures and video as home/<name> from static/home/ (kept apart so conference sites do
not get them).

The same build writes the site's other root files: 404.html (src/404.html, filled the same way),
robots.txt, and sitemap.xml with the homepage and each listed conference's canonical address.
"""
from __future__ import annotations

import html
import re
from pathlib import Path
from typing import Dict, Iterable, List, Optional

from .config import Conference
from .files import write_text_atomic
from .site import SiteError, copy_static, fill_placeholders

DOCS = 'docs'
MARKER = re.compile(r'^([ \t]*)<!--\s*@conferences\s*-->[ \t]*\n', re.M)
LOCAL_FILE = re.compile(r'''(?:href|src|poster)="([^"/:?#]+)"|url\(([^)"'/:]+)\)''')
HOME_FILE = re.compile(r'''(?:href|src|srcset|poster)="home/([^"/:?#\s]+)"''')
LIST_ANCHOR = '#conferences'
SITE = 'https://whichtalk.com'
ROBOTS = f'User-agent: *\nAllow: /\n\nSitemap: {SITE}/sitemap.xml\n'


def listed(conferences: Iterable[Conference]) -> List[Conference]:
    return sorted((c for c in conferences if c.home['listed']), key=lambda c: c.id)


def join_names(names: List[str]) -> str:
    """'A', 'A and B', 'A, B and C'."""
    return f'{", ".join(names[:-1])} and {names[-1]}' if len(names) > 1 else ''.join(names)


def href(conf: Conference) -> str:
    return Path(conf.data['output']).relative_to(DOCS).as_posix() + '/'


def card(conf: Conference, indent: str) -> str:
    home = conf.home
    return (f'{indent}<li><a class="conf" href="{html.escape(href(conf))}">'
            f'<span class="yr" aria-hidden="true">{html.escape(home["badge"])}</span>'
            f'<span class="name">{html.escape(conf.name)}</span>'
            f'<span class="val">{html.escape(home["summary"])}</span></a></li>\n')


def render_home(template: str, conferences: Iterable[Conference]) -> str:
    shown = listed(conferences)
    names = join_names([c.name for c in shown])
    one = shown[0] if len(shown) == 1 else None
    page = fill_placeholders(template, {
        'nowFor': f' Now for {names}.' if names else '',
        'primaryHref': href(one) if one else LIST_ANCHOR,
        'primaryLabel': f'Open {one.name}' if one else 'Choose your conference',
    })
    if len(MARKER.findall(page)) != 1:
        raise SiteError('the homepage template must contain <!-- @conferences --> exactly once, on a line of its own')
    return MARKER.sub(lambda m: ''.join(card(c, m.group(1)) for c in shown), page)


def sitemap(conferences: Iterable[Conference]) -> str:
    urls = [f'{SITE}/'] + [c.data['page']['canonical'] for c in listed(conferences)]
    rows = ''.join(f'  <url><loc>{html.escape(url)}</loc></url>\n' for url in urls)
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{rows}</urlset>\n'


def write_home(page: str, out: Path, static: Path, extra: Optional[Dict[str, str]] = None) -> None:
    """The page and the extra files (name: text, written next to it), then the static files they
    refer to by a plain file name, plus og.png (link previews need an absolute URL, so the page
    names it as https://whichtalk.com/og.png), then their pictures and video from static/home/."""
    files = {out.name: page, **(extra or {})}
    text = ''.join(files.values())
    media = sorted(set(HOME_FILE.findall(text)))
    missing = [name for name in media if not (static / 'home' / name).is_file()]
    if missing:
        raise SiteError(f'the homepage refers to {", ".join("home/" + m for m in missing)}, not found in {static / "home"}')
    for name, content in files.items():
        write_text_atomic(out.parent / name, content)
    names = {a or b for a, b in LOCAL_FILE.findall(text)} | {'og.png'}
    copy_static(static, out.parent, {}, only=sorted(names))
    if media:
        copy_static(static / 'home', out.parent / 'home', {}, only=media)
