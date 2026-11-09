"""Tests for the homepage (whichtalk/home.py, src/home.html). Run: python3 -I -m unittest discover tests"""
from __future__ import annotations

import copy
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from whichtalk.config import conference_ids, load_conference, parse_conference  # noqa: E402
from whichtalk.home import HOME_FILE, join_names, render_home, write_home  # noqa: E402
from whichtalk.pipeline import run_home  # noqa: E402
from whichtalk.site import SiteError  # noqa: E402

CONFERENCES = ROOT / 'tests' / 'fixtures' / 'conferences'
TEMPLATE = '''<meta name="description" content="A planner.{{nowFor}}">
<a class="btn" href="{{primaryHref}}">{{primaryLabel}}</a>
<ul>
    <!-- @conferences -->
    <li class="soon">More soon.</li>
</ul>
'''


def fixtures():
    return [load_conference(cid, conferences_dir=CONFERENCES) for cid in ('beta-2027', 'alpha-2026')]


class Render(unittest.TestCase):
    def test_cards_sorted_by_id_in_the_marker_indent(self) -> None:
        page = render_home(TEMPLATE, fixtures())
        self.assertEqual(page, '''<meta name="description" content="A planner. Now for Alpha 2026 and Beta 2027.">
<a class="btn" href="#conferences">Choose your conference</a>
<ul>
    <li><a class="conf" href="alpha/2026/"><span class="yr" aria-hidden="true">’26</span>'''
                         '''<span class="name">Alpha 2026</span><span class="val">Lisbon and New York · October 2026</span></a></li>
    <li><a class="conf" href="beta/2027/"><span class="yr" aria-hidden="true">’27</span>'''
                         '''<span class="name">Beta 2027</span><span class="val">Berlin &amp; Potsdam · June 2027</span></a></li>
    <li class="soon">More soon.</li>
</ul>
''')

    def test_unlisted_conferences_are_left_out(self) -> None:
        alpha, beta = fixtures()[1], fixtures()[0]
        data = copy.deepcopy(beta.data)
        data['home']['listed'] = False
        page = render_home(TEMPLATE, [alpha, parse_conference(data)])
        self.assertIn('Now for Alpha 2026.', page)
        self.assertNotIn('Beta', page)
        self.assertEqual(render_home(TEMPLATE, []),
                         '<meta name="description" content="A planner.">\n'
                         '<a class="btn" href="#conferences">Choose your conference</a>\n<ul>\n'
                         '    <li class="soon">More soon.</li>\n</ul>\n')

    def test_one_listed_conference_is_the_main_button(self) -> None:
        alpha, beta = fixtures()[1], fixtures()[0]
        data = copy.deepcopy(beta.data)
        data['home']['listed'] = False
        page = render_home(TEMPLATE, [alpha, parse_conference(data)])
        self.assertIn('<a class="btn" href="alpha/2026/">Open Alpha 2026</a>', page)

    def test_join_names(self) -> None:
        self.assertEqual(join_names([]), '')
        self.assertEqual(join_names(['A']), 'A')
        self.assertEqual(join_names(['A', 'B']), 'A and B')
        self.assertEqual(join_names(['A', 'B', 'C']), 'A, B and C')

    def test_marker_must_appear_once(self) -> None:
        with self.assertRaisesRegex(SiteError, 'exactly once'):
            render_home('<p>{{nowFor}}</p>\n', fixtures())
        with self.assertRaisesRegex(SiteError, 'exactly once'):
            render_home('<!-- @conferences -->\n<!-- @conferences -->\n', fixtures())


class WriteHome(unittest.TestCase):
    PAGE = ('<link rel="icon" href="favicon.svg"><picture><source srcset="home/a-dark.jpg">'
            '<img src="home/a.jpg"></picture><video src="home/b.mp4" poster="home/b.jpg"></video>\n')

    def static(self, root: Path) -> Path:
        static = root / 'static'
        (static / 'home').mkdir(parents=True)
        for name in ('favicon.svg', 'og.png', 'sw.js'):
            (static / name).write_bytes(name.encode())
        for name in ('a.jpg', 'a-dark.jpg', 'b.mp4', 'b.jpg', 'unused.jpg'):
            (static / 'home' / name).write_bytes(name.encode())
        return static

    def test_copies_what_the_page_refers_to(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            static, out = self.static(Path(tmp)), Path(tmp) / 'site' / 'index.html'
            write_home(self.PAGE, out, static)
            self.assertEqual(out.read_text(encoding='utf-8'), self.PAGE)
            self.assertEqual(sorted(p.name for p in out.parent.iterdir() if p.is_file()), ['favicon.svg', 'index.html', 'og.png'])
            self.assertEqual(sorted(p.name for p in (out.parent / 'home').iterdir()), ['a-dark.jpg', 'a.jpg', 'b.jpg', 'b.mp4'])

    def test_missing_media_stops_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            static, out = self.static(Path(tmp)), Path(tmp) / 'site' / 'index.html'
            with self.assertRaisesRegex(SiteError, r'home/c\.png'):
                write_home(self.PAGE + '<img src="home/c.png">\n', out, static)
            self.assertFalse(out.exists())


class RepoHomepage(unittest.TestCase):
    def test_src_home_html_lists_the_repo_conferences(self) -> None:
        listed = [c for c in (load_conference(cid) for cid in conference_ids()) if c.home['listed']]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'index.html'
            self.assertEqual(run_home(out), 0)
            page = out.read_text(encoding='utf-8')
            for conf in listed:
                self.assertIn(f'<span class="name">{conf.name}</span>', page)
            self.assertNotIn('{{', page)
            self.assertNotIn('<!-- @conferences -->', page)
            for name in ('favicon.svg', 'favicon-32.png', 'icon-180.png', 'geist-latin.woff2'):
                self.assertTrue((Path(tmp) / name).is_file(), name)
            self.assertFalse((Path(tmp) / 'sw.js').exists())             # only what the page refers to
            media = HOME_FILE.findall(page)
            self.assertTrue(media)
            for name in media:
                self.assertTrue((Path(tmp) / 'home' / name).is_file(), name)


if __name__ == '__main__':
    unittest.main()
