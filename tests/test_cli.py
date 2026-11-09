"""End-to-end tests of the command line (python3 -I whichtalk ...): build, check, list and new, on the
fixture conferences. The build uses the app in src/, or in $WHICHTALK_TEST_SRC when that is set.
Run: python3 -I -m unittest discover tests"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict

ROOT = Path(__file__).resolve().parents[1]
CONFERENCES = ROOT / 'tests' / 'fixtures' / 'conferences'
SRC = Path(os.environ.get('WHICHTALK_TEST_SRC') or ROOT / 'src')


def whichtalk(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, '-I', str(ROOT / 'whichtalk'), *args],
                          capture_output=True, text=True, check=False, cwd=ROOT)


def catalog(page: Path) -> Dict[str, Any]:
    m = re.search(r'<script type="application/json" id="catalog-data">(.*?)</script>', page.read_text(encoding='utf-8'), re.S)
    assert m, 'no catalog in the page'
    return json.loads(m.group(1))


class Build(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name) / 'alpha' / '2026'
        cls.result = whichtalk('build', 'alpha-2026', '--conferences', str(CONFERENCES), '--src', str(SRC),
                               '--out', str(cls.out))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def setUp(self) -> None:
        self.assertEqual(self.result.returncode, 0, self.result.stderr)

    def test_catalog(self) -> None:
        data = catalog(self.out / 'index.html')
        self.assertEqual((data['format'], data['version']), ('whichtalk-catalog', 1))
        self.assertEqual(data['sourceUrl'], 'https://alpha.example/2026/program')
        self.assertFalse(data['enriched'])
        self.assertEqual(data['conference']['id'], 'alpha-2026')
        self.assertEqual(data['abstracts'], {'count': 2, 'shards': 64})
        events, strings = data['events'], data['strings']
        self.assertEqual(events['count'], 7)
        self.assertEqual(events['id'], [100, 200, 201, 202, 300, 400, 500])
        row = {key: values[2] for key, values in events.items() if key != 'count'}
        self.assertEqual(row['start'], 1791797400)                      # 2026-10-12 10:30 in Lisbon (UTC+1)
        self.assertEqual(row['durationMinutes'], 20)
        self.assertEqual((row['parentId'], strings[row['parentTitle']]), (200, 'Talk Session 1'))
        self.assertEqual((strings[row['kind']], strings[row['room']], strings[row['location']]), ('Talk', 'Room 1.1', 'LIS'))
        self.assertEqual(row['links'], [['Slides', 'https://alpha.example/slides/201']])
        self.assertEqual((row['openreviewId'], row['hasAbstract'], row['hasPoster']), ('abc-123', 1, 0))
        self.assertEqual(events['hasPoster'][4], 1)
        self.assertEqual((events['start'][6], events['durationMinutes'][6], events['links'][6]), (0, 0, 0))
        self.assertEqual([strings[i] for i in events['institutions'][0]], ['Analytical Society'])

    def test_abstract_shards(self) -> None:
        shards = sorted(p.name for p in (self.out / 'abstracts').glob('*.js'))
        self.assertEqual(shards, ['part-36.js', 'part-9.js'])            # 100 % 64, 201 % 64
        self.assertIn('{"100":"Why engines matter."}', (self.out / 'abstracts' / 'part-36.js').read_text(encoding='utf-8'))

    def test_page(self) -> None:
        page = (self.out / 'index.html').read_text(encoding='utf-8')
        self.assertIn('<title>WhichTalk · Alpha 2026</title>', page)
        self.assertIn('whichtalk:alpha-2026:', page)                     # the storageNamespace default
        self.assertRegex(page, r'</style>\n<style>\n:root \{\n  --color-accent: #047857;')
        self.assertTrue((self.out / 'favicon.svg').is_file())
        self.assertNotIn('homepage', self.result.stderr)                 # --out outside docs/: homepage untouched


class Commands(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.conferences = Path(self.tmp.name) / 'conferences'
        shutil.copytree(CONFERENCES, self.conferences)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_in(self, *args: str) -> subprocess.CompletedProcess:
        return whichtalk(*args, '--conferences', str(self.conferences))

    def test_check(self) -> None:
        result = self.run_in('check', '--all')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('alpha-2026: ok, 7 events (1 without a time), 2 abstracts', result.stdout)
        self.assertIn('beta-2027: ok', result.stdout)

    def test_check_reports_bad_events_with_status_1(self) -> None:
        (self.conferences / 'beta-2027' / 'events.json').write_text(
            '{"format": "whichtalk-events", "version": 1, "events": [{"id": 1, "kind": "Talk"}]}', encoding='utf-8')
        result = self.run_in('check', 'beta-2027')
        self.assertEqual(result.returncode, 1)
        self.assertIn('events[0] (id 1): title must be a non-empty string', result.stderr)

    def test_check_reports_bad_config_with_status_2(self) -> None:
        path = self.conferences / 'beta-2027' / 'conference.json'
        path.write_text(path.read_text(encoding='utf-8').replace('"shortName": "Beta",', ''), encoding='utf-8')
        result = self.run_in('check', 'alpha-2026', 'beta-2027')
        self.assertEqual(result.returncode, 2)
        self.assertIn('alpha-2026: ok', result.stdout)
        self.assertIn('shortName must be a non-empty string', result.stderr)

    def test_build_with_bad_events_writes_nothing(self) -> None:
        (self.conferences / 'beta-2027' / 'events.json').write_text('[]', encoding='utf-8')
        out = Path(self.tmp.name) / 'out'
        result = self.run_in('build', 'beta-2027', '--src', str(SRC), '--out', str(out), '--max-new', '5')
        self.assertEqual(result.returncode, 1)
        self.assertIn('ignoring --max-new (for scraper sources; this one is events-file)', result.stderr)
        self.assertIn('nothing was written', result.stderr)
        self.assertFalse(out.exists())

    def test_usage_errors(self) -> None:
        self.assertEqual(self.run_in('build').returncode, 2)
        self.assertEqual(self.run_in('check', 'alpha-2026', '--all').returncode, 2)
        self.assertEqual(self.run_in('build', 'alpha-2026', 'beta-2027', '--out', self.tmp.name).returncode, 2)
        missing = self.run_in('check', 'gamma-2026')
        self.assertEqual(missing.returncode, 2)
        self.assertIn("no conference 'gamma-2026'", missing.stderr)

    def test_list(self) -> None:
        result = self.run_in('list')
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(lines[0].split(), ['id', 'name', 'source', 'listed', 'output'])
        self.assertEqual(lines[1].split(), ['alpha-2026', 'Alpha', '2026', 'events-file', 'yes', 'docs/alpha/2026'])
        self.assertEqual(len(lines), 3)                                  # _template is not a conference

    def test_new_from_the_template(self) -> None:
        result = self.run_in('new', 'gamma-2028', '--name', 'Gamma Conf 2028')
        self.assertEqual(result.returncode, 0, result.stderr)
        folder = self.conferences / 'gamma-2028'
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ['conference.json', 'events.json'])
        data = json.loads((folder / 'conference.json').read_text(encoding='utf-8'))
        self.assertEqual((data['id'], data['name'], data['shortName']), ('gamma-2028', 'Gamma Conf 2028', 'Gamma Conf'))
        self.assertEqual(data['output'], 'docs/gamma-conf/2028')
        self.assertEqual(data['page']['title'], 'WhichTalk · Gamma Conf 2028')
        self.assertEqual(data['page']['canonical'], 'https://whichtalk.com/gamma-conf/2028/')
        self.assertEqual(data['page']['description'], 'A planner for the Gamma Conf 2028 program.')
        self.assertEqual(data['home']['badge'], '’28')
        self.assertNotIn('storageNamespace', data)
        self.assertEqual(self.run_in('check', 'gamma-2028').returncode, 0)

    def test_new_short_name_year_from_id_and_from_another_conference(self) -> None:
        (self.conferences / 'alpha-2026' / 'cache').mkdir()
        result = self.run_in('new', 'omega-2030', '--name', 'Omega', '--short', 'OMEGA Sym', '--from', 'alpha-2026')
        self.assertEqual(result.returncode, 0, result.stderr)
        folder = self.conferences / 'omega-2030'
        self.assertFalse((folder / 'cache').exists())
        data = json.loads((folder / 'conference.json').read_text(encoding='utf-8'))
        self.assertEqual((data['shortName'], data['output']), ('OMEGA Sym', 'docs/omega-sym/2030'))
        self.assertEqual(data['venue']['name'], 'Congress Centre')
        self.assertTrue((folder / 'events.json').is_file())

    def test_new_refuses_to_overwrite_or_guess(self) -> None:
        before = (self.conferences / 'beta-2027' / 'conference.json').read_bytes()
        result = self.run_in('new', 'beta-2027', '--name', 'Beta 2027')
        self.assertEqual(result.returncode, 2)
        self.assertIn('already exists: not overwriting it', result.stderr)
        self.assertEqual((self.conferences / 'beta-2027' / 'conference.json').read_bytes(), before)
        no_year = self.run_in('new', 'delta', '--name', 'Delta')
        self.assertEqual(no_year.returncode, 2)
        self.assertIn('cannot tell the year', no_year.stderr)
        self.assertEqual(self.run_in('new', 'Delta_2027', '--name', 'Delta 2027').returncode, 2)
        self.assertFalse((self.conferences / 'delta').exists())


if __name__ == '__main__':
    unittest.main()
