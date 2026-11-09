"""Page assembly (template placeholders, styles and theme, catalog, app script) and writing the site folder."""
from __future__ import annotations

import html
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import bundle
from .dataset import write_shards
from .files import copy_file, replace_tree, write_text_atomic

log = logging.getLogger(__name__)

PLACEHOLDER = re.compile(r'\{\{\s*([A-Za-z][\w.]*)\s*\}\}')
MARKER = re.compile(r'<!--\s*@(styles|catalog|app)\s*-->')
CSS_IMPORT = re.compile(r'''^\s*@import\s+(?:url\(\s*(["']?)([^"')]+)\1\s*\)|(["'])([^"']+)\3)\s*;\s*$''')
SCRIPT_CLOSE = re.compile(r'</(script)', re.I)
# theme keys -> the tokens they override in src/styles/tokens.css
THEME_TOKENS = {'accent': '--color-accent', 'accentMark': '--color-accent-mark', 'accentSoft': '--color-accent-soft'}
# static files whose text may hold {{placeholders}} (filled with JSON-escaped values)
TEMPLATED_STATIC = ('.webmanifest', '.js', '.json')


class SiteError(RuntimeError):
    pass


@dataclass(frozen=True)
class Sources:
    """Inputs of the page: the template, the app modules and the files copied next to it."""
    root: Path
    src: Path

    @property
    def template(self) -> Path:
        return self.src / 'index.html'

    @property
    def entry(self) -> Path:
        return self.src / 'main.js'

    @property
    def stylesheet(self) -> Path:
        return self.src / 'styles' / 'main.css'

    @property
    def classic_scripts(self) -> List[Path]:
        return [self.root / 'vendor' / 'qrcode.js']

    @property
    def static(self) -> Path:
        return self.root / 'static'


def html_text(value: str) -> str:
    return html.escape(value, quote=True)


def json_text(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)[1:-1]


def fill_placeholders(template: str, values: Dict[str, Any], escape: Callable[[str], str] = html_text) -> str:
    """{{name}}, {{page.title}}, ...: config values, HTML-escaped by default. An unknown name is an error."""
    def lookup(m: 're.Match[str]') -> str:
        value: Any = values
        for part in m.group(1).split('.'):
            value = value.get(part) if isinstance(value, dict) else None
        if not isinstance(value, (str, int, float)) or isinstance(value, bool):
            raise SiteError(f'template placeholder {m.group(0)} has no value in the conference config')
        return escape(str(value))
    return PLACEHOLDER.sub(lookup, template)


def inline_css(path: Path, _seen: Optional[List[Path]] = None) -> str:
    """The stylesheet with each `@import url("x.css");` line replaced by that file, in order."""
    seen = _seen if _seen is not None else []
    if path in seen:
        raise SiteError(f'stylesheet import cycle at {path}')
    if not path.is_file():
        raise SiteError(f'stylesheet {path} does not exist')
    seen.append(path)
    out = []
    for line in path.read_text(encoding='utf-8').splitlines(keepends=True):
        m = CSS_IMPORT.match(line)
        if m:
            target = m.group(2) or m.group(4)
            if '://' in target or target.startswith('/'):
                raise SiteError(f'{path.name}: only relative @import lines can be inlined ({target})')
            out.append(inline_css((path.parent / target).resolve(), seen))
            if not out[-1].endswith('\n'):
                out.append('\n')
        elif '@import' in line and not line.lstrip().startswith(('/*', '*')):
            raise SiteError(f'{path.name}: unsupported @import form: {line.strip()}')
        else:
            out.append(line)
    seen.pop()
    return ''.join(out)


def theme_css(theme: Optional[Dict[str, Any]]) -> str:
    """The conference's accent colors over the defaults, with the selectors tokens.css uses for the
    light palette, the explicit dark theme and the system dark theme; '' without a theme."""
    def rule(selector: str, colors: Dict[str, str], indent: str = '') -> str:
        lines = ''.join(f'{indent}  {var}: {colors[key]};\n' for key, var in THEME_TOKENS.items() if colors.get(key))
        return f'{indent}{selector} {{\n{lines}{indent}}}\n' if lines else ''
    light, dark = (theme or {}).get('light') or {}, (theme or {}).get('dark') or {}
    system = rule(':root[data-theme=system]', dark, '  ')
    return (rule(':root', light) + rule(':root[data-theme=dark]', dark)
            + (f'@media (prefers-color-scheme: dark) {{\n{system}}}\n' if system else ''))


def styles_html(sources: Sources, dev: bool, theme: Optional[Dict[str, Any]] = None) -> str:
    """The stylesheet (linked for dev, inlined otherwise), then the theme override if there is one."""
    override = theme_css(theme)
    after = f'\n<style>\n{override}</style>' if override else ''
    if dev:
        return '<link rel="stylesheet" href="src/styles/main.css">' + after
    css = inline_css(sources.stylesheet.resolve())
    if re.search(r'</style', css, re.I):
        raise SiteError('the stylesheet contains "</style"')
    return f'<style>\n{css}</style>' + after


def app_html(sources: Sources, dev: bool) -> str:
    """Production: one inline script that has passed the bundler checks and `node --check`."""
    if dev:
        for problem in bundle.check_problems(sources.entry, sources.root):
            log.warning('bundle check: %s', problem)
        return '<script src="vendor/qrcode.js"></script>\n<script type="module" src="src/main.js"></script>'
    script = SCRIPT_CLOSE.sub(r'<\\/\1', bundle.production_script(sources.entry, sources.root, sources.classic_scripts))
    bundle.check_syntax(script)
    return f'<script>\n{script}</script>'


def render_page(sources: Sources, config: Dict[str, Any], catalog: str, dev: bool) -> str:
    if not sources.template.is_file():
        raise SiteError(f'page template {sources.template} does not exist')
    page = fill_placeholders(sources.template.read_text(encoding='utf-8'), config)
    found = [m.group(1) for m in MARKER.finditer(page)]
    for name in ('styles', 'catalog', 'app'):
        if found.count(name) != 1:
            raise SiteError(f'{sources.template.name} must contain <!-- @{name} --> exactly once')
    parts = {
        'styles': styles_html(sources, dev, config.get('theme')),
        'catalog': f'<script type="application/json" id="catalog-data">{catalog}</script>',
        'app': app_html(sources, dev),
    }
    return MARKER.sub(lambda m: parts[m.group(1)], page)


def copy_static(static: Path, site_dir: Path, config: Dict[str, Any], only: Optional[List[str]] = None) -> None:
    """Copy the files of static/ (or the ones named in `only`); a manifest or script holding
    {{placeholders}} gets the conference's values."""
    for item in sorted(static.iterdir()):
        if not item.is_file() or item.name.startswith('.') or (only is not None and item.name not in only):
            continue
        text = item.read_text(encoding='utf-8') if item.suffix in TEMPLATED_STATIC else ''
        if PLACEHOLDER.search(text):
            write_text_atomic(site_dir / item.name, fill_placeholders(text, config, json_text))
        else:
            copy_file(item, site_dir / item.name)


def page_path(out: Path) -> Path:
    """--out accepts a folder (index.html goes inside) or the HTML file itself."""
    return out if out.suffix == '.html' else out / 'index.html'


def write_site(page_file: Path, page: str, shards: Dict[str, str], sources: Sources, dev: bool,
               config: Optional[Dict[str, Any]] = None, own_static: Optional[Path] = None) -> None:
    """Shards first, then the page in one atomic step, then the shared static files, then the
    conference's own (conferences/<id>/static/, e.g. its og.png), which replace shared ones of the
    same name, and in dev mode the sources."""
    site_dir = page_file.parent
    write_shards(shards, site_dir)
    write_text_atomic(page_file, page)
    copy_static(sources.static, site_dir, config or {})
    if own_static is not None and own_static.is_dir():
        copy_static(own_static, site_dir, config or {})
    if dev:
        replace_tree(sources.src, site_dir / 'src')
        replace_tree(sources.root / 'vendor', site_dir / 'vendor')
        # The linked stylesheet resolves font URLs against src/styles/, not the page folder.
        for font in sorted(sources.static.glob('*.woff2')):
            copy_file(font, site_dir / 'src' / 'styles' / font.name)
