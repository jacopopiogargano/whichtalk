"""Tests for whichtalk/config.py: conference folders, checks of every field and the defaults the app reads.
Run: python3 -I -m unittest discover tests"""
from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path
from typing import Any, Callable, Dict

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from whichtalk.config import ConfigError, conference_ids, load_conference, parse_conference  # noqa: E402

CONFERENCES = ROOT / 'tests' / 'fixtures' / 'conferences'
ALPHA = json.loads((CONFERENCES / 'alpha-2026' / 'conference.json').read_text(encoding='utf-8'))


def problems(change: Callable[[Dict[str, Any]], Any]) -> str:
    """The error message for the alpha config after `change`, or '' if it is still valid."""
    data = copy.deepcopy(ALPHA)
    change(data)
    try:
        parse_conference(data, folder=CONFERENCES / 'alpha-2026')
    except ConfigError as exc:
        return str(exc)
    return ''


class Folders(unittest.TestCase):
    def test_ids_skip_underscore_folders(self) -> None:
        self.assertEqual(conference_ids(CONFERENCES), ['alpha-2026', 'beta-2027'])

    def test_load_by_id_and_by_path(self) -> None:
        by_id = load_conference('alpha-2026', conferences_dir=CONFERENCES)
        self.assertEqual(by_id.folder, (CONFERENCES / 'alpha-2026').resolve())
        by_path = load_conference(str(CONFERENCES / 'beta-2027' / 'conference.json'))
        self.assertEqual(by_path.id, 'beta-2027')

    def test_unknown_id_names_the_known_ones(self) -> None:
        with self.assertRaisesRegex(ConfigError, r"no conference 'gamma-2026'.*alpha-2026, beta-2027"):
            load_conference('gamma-2026', conferences_dir=CONFERENCES)

    def test_id_must_be_the_folder_name(self) -> None:
        with self.assertRaisesRegex(ConfigError, "must be the folder name '_template'"):
            load_conference(str(CONFERENCES / '_template'))

    def test_every_conference_in_the_repo_is_valid(self) -> None:
        for conf_id in conference_ids():
            with self.subTest(conf_id):
                self.assertEqual(load_conference(conf_id).id, conf_id)


class Defaults(unittest.TestCase):
    def test_full_config_passes_through(self) -> None:
        subset = load_conference('alpha-2026', conferences_dir=CONFERENCES).catalog_subset()
        self.assertEqual(subset['storageNamespace'], 'whichtalk:alpha-2026:')
        self.assertEqual([loc['all'] for loc in subset['locations']], [False, False, True])
        self.assertEqual([t['papers'] for t in subset['tracks']], [False, True, True, False, False])
        self.assertEqual(subset['dayLabels'][1], {'label': 'Social', 'title': 'Social', 'tracks': ['other']})
        self.assertEqual(subset['notes'], {'untimed': 'Times come later.'})
        self.assertEqual(subset['venue']['walkMinutes'], {'north|south': 5})
        self.assertEqual(subset['page']['sourceName'], 'alpha.example')
        self.assertNotIn('theme', subset)

    def test_minimal_config_gets_every_key(self) -> None:
        subset = load_conference('beta-2027', conferences_dir=CONFERENCES).catalog_subset()
        self.assertEqual(subset['urls'], {'event': '', 'poster': '', 'openreview': ''})
        self.assertEqual(subset['locations'][0]['all'], False)
        self.assertEqual((subset['dayLabels'], subset['containerKinds'], subset['genericSessionTitles']), ([], [], ''))
        self.assertTrue(subset['notes']['untimed'].startswith('Not yet in the public schedule.'))
        self.assertIsNone(subset['venue'])
        self.assertEqual(sorted(subset['page']), ['canonical', 'officialSchedule', 'organizer', 'sourceName'])

    def test_template_values_fill_defaults_and_keep_the_page(self) -> None:
        values = load_conference('beta-2027', conferences_dir=CONFERENCES).template_values()
        self.assertEqual(values['storageNamespace'], 'whichtalk:beta-2027:')
        self.assertEqual(values['page']['title'], 'WhichTalk · Beta 2027')

    def test_home_defaults_to_unlisted(self) -> None:
        data = copy.deepcopy(ALPHA)
        del data['home']
        conf = parse_conference(data)
        self.assertEqual(conf.home, {'listed': False, 'summary': '', 'badge': ''})


def drop(*path: str) -> Callable[[Dict[str, Any]], None]:
    def change(data: Dict[str, Any]) -> None:
        for key in path[:-1]:
            data = data[key]
        del data[path[-1]]
    return change


def put(value: Any, *path: Any) -> Callable[[Dict[str, Any]], None]:
    def change(data: Any) -> None:
        for key in path[:-1]:
            data = data[key]
        data[path[-1]] = value
    return change


class Problems(unittest.TestCase):
    CASES = [
        ('id', put('Alpha_2026', 'id'), "id 'Alpha_2026' must be lowercase"),
        ('id vs folder', put('alpha-2027', 'id'), "must be the folder name 'alpha-2026'"),
        ('shortName', drop('shortName'), 'shortName must be a non-empty string'),
        ('sourceName', drop('page', 'sourceName'), 'page.sourceName must be a non-empty string'),
        ('storageNamespace', put('', 'storageNamespace'), 'storageNamespace must be a non-empty string'),
        ('output', put('../elsewhere', 'output'), 'output must be a path inside the project'),
        ('url token', put('https://alpha.example/event', 'urls', 'event'), 'urls.event must be an http(s) address containing {id}'),
        ('url scheme', put('javascript:{openreviewId}', 'urls', 'openreview'), 'urls.openreview must be an http(s) address'),
        ('url key', put('x', 'urls', 'slides'), "urls: unknown field 'slides'"),
        ('two all', put(True, 'locations', 0, 'all'), 'only one location may be the "all" choice, not LIS, ALL'),
        ('all default', put('ALL', 'defaultLocation'), 'defaultLocation may not be the "all" location'),
        ('all type', put('yes', 'locations', 2, 'all'), 'locations[2].all must be true or false'),
        ('offset', put(15, 'locations', 1, 'utcOffsetHours'), 'locations[1].utcOffsetHours must be between -12 and 14'),
        ('location field', put('x', 'locations', 0, 'city'), "locations[0]: unknown field 'city'"),
        ('papers type', put(1, 'tracks', 1, 'papers'), 'tracks[1].papers must be true or false'),
        ('duplicate kind', put(['Talk'], 'tracks', 2, 'kinds'), "duplicate track kind 'Talk'"),
        ('fallback', put('nope', 'fallbackTrack'), 'fallbackTrack must be one of the track keys'),
        ('day track', put(['talk', 'nope'], 'dayLabels', 0, 'tracks'), "dayLabels[0].tracks: unknown track 'nope'"),
        ('day empty', put([], 'dayLabels', 1, 'tracks'), 'dayLabels[1].tracks must name at least one track'),
        ('day label', drop('dayLabels', 0, 'label'), 'dayLabels[0].label must be a non-empty string'),
        ('day labels type', put({}, 'dayLabels'), 'dayLabels must be a list of objects'),
        ('container kinds', put('Talk Session', 'containerKinds'), 'containerKinds must be a list of strings'),
        ('generic titles', put('Talk (Session', 'genericSessionTitles'), 'genericSessionTitles is not a valid regular expression'),
        ('notes', put(5, 'notes', 'untimed'), 'notes.untimed must be a non-empty string'),
        ('zone regex', put('^room (', 'venue', 'zones', 2, 'pattern'), 'venue.zones[2].pattern is not a valid regular expression'),
        ('zone level', put('2', 'venue', 'zones', 1, 'level'), 'venue.zones[1].level must be a number, null (unknown) or "$1"'),
        ('zone level missing', drop('venue', 'zones', 2, 'level'), 'venue.zones[2].level must be a number'),
        ('zone $1', put('^auditorium$', 'venue', 'zones', 0, 'pattern'), 'venue.zones[0].pattern needs a capture group for "$1"'),
        ('walk order', put({'south|north': 5}, 'venue', 'walkMinutes'), "'south|north' must be two building names in alphabetical order"),
        ('walk building', put({'north|south': 5, 'east|north': 3}, 'venue', 'walkMinutes'), "'east|north' names a building that no zone has"),
        ('walk pair', put({}, 'venue', 'walkMinutes'), 'venue.walkMinutes needs "north|south"'),
        ('walk minutes', put({'north|south': '5'}, 'venue', 'walkMinutes'), "venue.walkMinutes['north|south'] must be a number of minutes"),
        ('venue number', drop('venue', 'upstairsMinutes'), 'venue.upstairsMinutes must be a number of at least 0'),
        ('venue location', put('PAR', 'venue', 'location'), 'venue.location must be one of the location keys'),
        ('venue type', put([], 'venue'), 'venue must be an object'),
        ('theme color', put('green', 'theme', 'light', 'accent'), 'theme.light.accent must be a hex color'),
        ('theme key', put('#000000', 'theme', 'dark', 'accentColor'), "theme.dark: unknown field 'accentColor'"),
        ('theme mode', put({}, 'theme', 'sepia'), "theme: unknown field 'sepia'"),
        ('home summary', drop('home', 'summary'), 'home.summary must be a non-empty string'),
        ('home listed', put('yes', 'home', 'listed'), 'home.listed must be true or false'),
        ('home output', put('_site/alpha/2026', 'output'), 'home.listed needs an output folder under docs/'),
        ('source type', put('spreadsheet', 'source', 'type'), 'source.type must be one of: events-file, neurips-cc'),
        ('source path', put('../events.json', 'source', 'path'), 'source.path must be a file inside the conference folder'),
        ('source field', put('x', 'source', 'url'), "source: unknown field 'url'"),
    ]

    def test_valid_fixture(self) -> None:
        self.assertEqual(problems(lambda data: None), '')

    def test_each_problem(self) -> None:
        for name, change, expected in self.CASES:
            with self.subTest(name):
                self.assertIn(expected, problems(change))

    def test_every_problem_is_reported_at_once(self) -> None:
        def change(data: Dict[str, Any]) -> None:
            for _, case, _ in self.CASES[2:6]:
                case(data)
        message = problems(change)
        for _, _, expected in self.CASES[2:6]:
            self.assertIn(expected, message)

    def test_unlisted_conference_may_build_anywhere(self) -> None:
        self.assertEqual(problems(lambda data: data.update(output='_site/alpha/2026', home={'listed': False})), '')

    def test_venue_may_be_null(self) -> None:
        self.assertEqual(problems(put(None, 'venue')), '')


if __name__ == '__main__':
    unittest.main()
