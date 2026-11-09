"""Tests for the page assembly in whichtalk/site.py: the theme override and templated static files.
Run: python3 -I -m unittest discover tests"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from whichtalk.site import SiteError, Sources, copy_static, styles_html, theme_css, write_site  # noqa: E402

SRC = Path(os.environ.get('WHICHTALK_TEST_SRC') or ROOT / 'src')
THEME = {'light': {'accent': '#047857', 'accentMark': '#059669', 'accentSoft': '#e1f3ec'},
         'dark': {'accent': '#34d399', 'accentMark': '#34d399', 'accentSoft': '#0c2a21'}}


class Theme(unittest.TestCase):
    def test_light_dark_and_system_dark(self) -> None:
        self.assertEqual(theme_css(THEME), '''\
:root {
  --color-accent: #047857;
  --color-accent-mark: #059669;
  --color-accent-soft: #e1f3ec;
}
:root[data-theme=dark] {
  --color-accent: #34d399;
  --color-accent-mark: #34d399;
  --color-accent-soft: #0c2a21;
}
@media (prefers-color-scheme: dark) {
  :root[data-theme=system] {
    --color-accent: #34d399;
    --color-accent-mark: #34d399;
    --color-accent-soft: #0c2a21;
  }
}
''')

    def test_partial_theme(self) -> None:
        self.assertEqual(theme_css({'light': {'accent': '#123456'}}), ':root {\n  --color-accent: #123456;\n}\n')

    def test_no_theme_no_css(self) -> None:
        self.assertEqual(theme_css(None), '')
        self.assertEqual(theme_css({}), '')

    def test_selectors_match_tokens_css(self) -> None:
        tokens = (SRC / 'styles' / 'tokens.css').read_text(encoding='utf-8')
        for selector in (':root {', ':root[data-theme=dark] {', '@media (prefers-color-scheme: dark)',
                         ':root[data-theme=system] {', '--color-accent:', '--color-accent-mark:', '--color-accent-soft:'):
            self.assertIn(selector, tokens)

    def test_override_follows_the_stylesheet(self) -> None:
        sources = Sources(ROOT, SRC)
        self.assertEqual(styles_html(sources, dev=True), '<link rel="stylesheet" href="src/styles/main.css">')
        self.assertEqual(styles_html(sources, dev=True, theme=THEME),
                         '<link rel="stylesheet" href="src/styles/main.css">\n<style>\n' + theme_css(THEME) + '</style>')
        inline = styles_html(sources, dev=False, theme=THEME)
        self.assertTrue(inline.startswith('<style>\n'))
        self.assertTrue(inline.endswith('</style>\n<style>\n' + theme_css(THEME) + '</style>'))
        self.assertEqual(styles_html(sources, dev=False, theme=None), inline.split('\n<style>\n:root {')[0])


class StaticFiles(unittest.TestCase):
    def test_placeholders_in_manifests_and_scripts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            static, site = Path(tmp) / 'static', Path(tmp) / 'site'
            static.mkdir()
            (static / 'manifest.webmanifest').write_text('{"name": "{{page.title}}"}', encoding='utf-8')
            (static / 'sw.js').write_text("const PREFIX = 'whichtalk-{{id}}-'\n", encoding='utf-8')
            (static / 'plain.js').write_text('const x = {a: 1}\n', encoding='utf-8')
            (static / 'icon.png').write_bytes(b'\x89PNG{{id}}')
            copy_static(static, site, {'id': 'x-2026', 'page': {'title': 'WhichTalk · "X" 2026'}})
            self.assertEqual((site / 'manifest.webmanifest').read_text(encoding='utf-8'),
                             '{"name": "WhichTalk · \\"X\\" 2026"}')
            self.assertEqual((site / 'sw.js').read_text(encoding='utf-8'), "const PREFIX = 'whichtalk-x-2026-'\n")
            self.assertEqual((site / 'plain.js').read_text(encoding='utf-8'), 'const x = {a: 1}\n')
            self.assertEqual((site / 'icon.png').read_bytes(), b'\x89PNG{{id}}')
            with self.assertRaisesRegex(SiteError, r'\{\{page.title\}\} has no value'):
                copy_static(static, site, {})

    def test_conference_static_replaces_shared_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'static').mkdir()
            (root / 'src').mkdir()
            (root / 'static' / 'og.png').write_bytes(b'shared')
            (root / 'static' / 'icon.png').write_bytes(b'icon')
            own = root / 'conferences' / 'x-2026' / 'static'
            own.mkdir(parents=True)
            (own / 'og.png').write_bytes(b'own')
            page = root / 'out' / 'index.html'
            write_site(page, '<!doctype html>', {}, Sources(root, root / 'src'), False, {'id': 'x-2026'}, own)
            self.assertEqual((page.parent / 'og.png').read_bytes(), b'own')
            self.assertEqual((page.parent / 'icon.png').read_bytes(), b'icon')


if __name__ == '__main__':
    unittest.main()
