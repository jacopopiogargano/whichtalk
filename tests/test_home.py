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
from whichtalk.home import join_names, render_home  # noqa: E402
from whichtalk.pipeline import run_home  # noqa: E402
from whichtalk.site import SiteError  # noqa: E402

CONFERENCES = ROOT / 'tests' / 'fixtures' / 'conferences'
TEMPLATE = '''<meta name="description" content="A planner.{{nowFor}}">
<div class="panel">
    <!-- @conferences -->
    <p class="soon">More soon.</p>
</div>
'''


def fixtures():
    return [load_conference(cid, conferences_dir=CONFERENCES) for cid in ('beta-2027', 'alpha-2026')]


class Render(unittest.TestCase):
    def test_cards_sorted_by_id_in_the_marker_indent(self) -> None:
        page = render_home(TEMPLATE, fixtures())
        self.assertEqual(page, '''<meta name="description" content="A planner. Now for Alpha 2026 and Beta 2027.">
<div class="panel">
    <a class="conf" href="alpha/2026/">
      <span class="yr" aria-hidden="true">’26</span>
      <span><h3>Alpha 2026</h3><p>Lisbon and New York · October 2026</p></span>
      <span class="go">Open planner</span>
    </a>
    <a class="conf" href="beta/2027/">
      <span class="yr" aria-hidden="true">’27</span>
      <span><h3>Beta 2027</h3><p>Berlin &amp; Potsdam · June 2027</p></span>
      <span class="go">Open planner</span>
    </a>
    <p class="soon">More soon.</p>
</div>
''')

    def test_unlisted_conferences_are_left_out(self) -> None:
        alpha, beta = fixtures()[1], fixtures()[0]
        data = copy.deepcopy(beta.data)
        data['home']['listed'] = False
        page = render_home(TEMPLATE, [alpha, parse_conference(data)])
        self.assertIn('Now for Alpha 2026.', page)
        self.assertNotIn('Beta', page)
        self.assertEqual(render_home(TEMPLATE, []),
                         '<meta name="description" content="A planner.">\n<div class="panel">\n'
                         '    <p class="soon">More soon.</p>\n</div>\n')

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


class RepoHomepage(unittest.TestCase):
    def test_src_home_html_lists_the_repo_conferences(self) -> None:
        listed = [c for c in (load_conference(cid) for cid in conference_ids()) if c.home['listed']]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'index.html'
            self.assertEqual(run_home(out), 0)
            page = out.read_text(encoding='utf-8')
            for conf in listed:
                self.assertIn(f'<h3>{conf.name}</h3>', page)
            self.assertNotIn('{{', page)
            self.assertNotIn('<!-- @conferences -->', page)
            for name in ('favicon.svg', 'favicon-32.png', 'icon-180.png', 'geist-latin.woff2'):
                self.assertTrue((Path(tmp) / name).is_file(), name)
            self.assertFalse((Path(tmp) / 'sw.js').exists())             # only what the page refers to


if __name__ == '__main__':
    unittest.main()
