"""Tests for the events-file source (whichtalk/sources/events_file.py). Run: python3 -I -m unittest discover tests"""
from __future__ import annotations

import datetime as dt
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from whichtalk.config import load_conference  # noqa: E402
from whichtalk.sources import LoadOptions, SourceError  # noqa: E402
from whichtalk.sources.events_file import parse_events  # noqa: E402

CONFERENCES = ROOT / 'tests' / 'fixtures' / 'conferences'
ALPHA = load_conference('alpha-2026', conferences_dir=CONFERENCES)


def epoch(text: str) -> int:
    return int(dt.datetime.fromisoformat(text).timestamp())


def doc(*events: Dict[str, Any]) -> Dict[str, Any]:
    return {'format': 'whichtalk-events', 'version': 1, 'events': list(events)}


def talk(event_id: int = 1, **fields: Any) -> Dict[str, Any]:
    return {'id': event_id, 'kind': 'Talk', 'title': f'Talk {event_id}', **fields}


def problems_of(data: Any) -> List[str]:
    try:
        parse_events(data, ALPHA.data)
    except SourceError as exc:
        return str(exc).split('\n  ')[1:]
    return []


class ValidFile(unittest.TestCase):
    def setUp(self) -> None:
        with self.assertLogs('whichtalk.sources.events_file', 'WARNING') as logs:
            self.program = ALPHA.adapter.load(ALPHA, LoadOptions())
        self.warnings = logs.output
        self.events = {e.id: e for e in self.program.events}

    def test_events_in_file_order(self) -> None:
        self.assertEqual([e.id for e in self.program.events], [100, 200, 201, 202, 300, 400, 500])
        self.assertEqual(self.program.source_url, 'https://alpha.example/2026/program')
        self.assertFalse(self.program.enriched)

    def test_local_time_uses_the_location_offset(self) -> None:
        self.assertEqual(self.events[100].start, epoch('2026-10-12T08:00+00:00'))           # Lisbon, UTC+1
        self.assertEqual(self.events[300].start, epoch('2026-10-12T19:00+00:00'))           # New York, UTC-5
        self.assertEqual(self.events[300].location, 'NYC')
        self.assertEqual(self.events[100].location, 'LIS')                                  # defaultLocation

    def test_explicit_offsets(self) -> None:
        self.assertEqual(self.events[201].start, epoch('2026-10-12T09:30+00:00'))           # +01:00
        self.assertEqual(self.events[202].start, epoch('2026-10-12T09:50+00:00'))           # Z
        self.assertEqual(self.events[202].duration_minutes, 20)

    def test_end_and_duration(self) -> None:
        self.assertEqual(self.events[200].duration_minutes, 90)
        self.assertEqual(self.events[201].end - self.events[201].start, 20 * 60)

    def test_untimed_and_null_fields(self) -> None:
        meetup = self.events[500]
        self.assertEqual((meetup.start, meetup.end, meetup.room, meetup.duration_minutes), (None, None, '', 0))
        self.assertNotIn(500, self.program.abstracts)

    def test_parents_and_extras(self) -> None:
        first = self.events[201]
        self.assertEqual((first.parent_id, first.parent_title), (200, 'Talk Session 1'))
        self.assertEqual(first.authors, ['Alan Turing', 'Grace Hopper'])
        self.assertEqual(first.links, [['Slides', 'https://alpha.example/slides/201']])
        self.assertEqual(first.openreview_id, 'abc-123')
        self.assertTrue(self.events[300].has_poster)
        self.assertEqual(self.events[100].institutions, ['Analytical Society'])
        self.assertEqual(self.events[100].topic, 'History')
        self.assertEqual(self.program.abstracts, {100: 'Why engines matter.', 201: 'On computable numbers.'})

    def test_kind_in_no_track_is_a_warning(self) -> None:
        self.assertEqual(len(self.warnings), 1)
        self.assertIn("fallback track 'other': Meetup (1)", self.warnings[0])

    def test_seconds_and_negative_offsets(self) -> None:
        events, _ = parse_events(doc(talk(1, start='2026-10-12T09:00:30-03:30', durationMinutes=1.5)), ALPHA.data)
        self.assertEqual(events[0].start, epoch('2026-10-12T12:30:30+00:00'))
        self.assertEqual(events[0].end - events[0].start, 90)

    def test_links_unused_without_url_template(self) -> None:
        config = dict(ALPHA.data, urls={})
        with self.assertLogs('whichtalk.sources.events_file', 'WARNING') as logs:
            parse_events(doc(talk(1, poster=True)), config)
        self.assertIn('1 events set poster: true, but urls.poster is empty', logs.output[0])


class Problems(unittest.TestCase):
    def assertProblem(self, data: Any, expected: str) -> None:
        found = problems_of(data)
        self.assertTrue(any(expected in p for p in found), f'{expected!r} not in {found}')

    def test_file_shape(self) -> None:
        self.assertProblem([], 'the file must be an object')
        self.assertProblem({'format': 'other', 'version': 1, 'events': []}, 'format must be "whichtalk-events"')
        self.assertProblem({'format': 'whichtalk-events', 'version': 2, 'events': []}, 'version must be 1')
        self.assertProblem({'format': 'whichtalk-events', 'version': 1, 'events': {}}, 'events must be a list')
        self.assertProblem({**doc(), 'meta': 1}, "the file: unknown field 'meta'")
        self.assertProblem(doc('talk'), 'events[0] must be an object')

    def test_ids(self) -> None:
        self.assertProblem(doc({'kind': 'Talk', 'title': 'x'}), 'events[0]: id must be a positive whole number')
        for bad in (0, -3, 1.5, '7', True, 2 ** 53):
            with self.subTest(bad):
                self.assertProblem(doc(talk(bad)), 'events[0]: id must be a positive whole number')
        self.assertProblem(doc(talk(4), talk(4)), 'events[1] (id 4): id 4 is already used by events[0]')

    def test_required_text(self) -> None:
        self.assertProblem(doc({'id': 3, 'title': 'x'}), 'events[0] (id 3): kind must be a non-empty string')
        self.assertProblem(doc(talk(3, title='')), 'events[0] (id 3): title must be a non-empty string')

    def test_unknown_field(self) -> None:
        self.assertProblem(doc(talk(3, abstarct='typo')), "events[0] (id 3): unknown field 'abstarct'")

    def test_location(self) -> None:
        self.assertProblem(doc(talk(3, location='PAR')), "events[0] (id 3): location 'PAR' must be one of LIS, NYC")
        self.assertProblem(doc(talk(3, location='ALL')), "location 'ALL' must be one of LIS, NYC")
        self.assertProblem(doc(talk(3, location=['LIS'])), 'must be one of LIS, NYC')

    def test_times(self) -> None:
        cases = [
            (dict(start='2026-10-12 09:00', durationMinutes=5), 'start must be a time like "2026-10-12T09:00"'),
            (dict(start='2026-10-12', durationMinutes=5), 'start must be a time like'),
            (dict(start=1791885600, durationMinutes=5), 'start must be a time like'),
            (dict(start='2026-02-30T09:00', durationMinutes=5), "start '2026-02-30T09:00' is not a valid date and time"),
            (dict(start='2026-10-12T09:00+25:00', durationMinutes=5), "start '2026-10-12T09:00+25:00' has no valid UTC offset"),
            (dict(start='2026-10-12T09:00', end='2026-10-12T09:00'), 'end must be after start'),
            (dict(start='2026-10-12T09:00', end='2026-10-12T10:00', durationMinutes=60), 'give end or durationMinutes, not both'),
            (dict(start='2026-10-12T09:00'), 'start needs an end or a durationMinutes'),
            (dict(start='2026-10-12T09:00', durationMinutes=0), 'durationMinutes must be a positive number'),
            (dict(start='2026-10-12T09:00', durationMinutes='60'), 'durationMinutes must be a positive number'),
            (dict(end='2026-10-12T09:00'), 'end needs a start'),
            (dict(durationMinutes=30), 'durationMinutes needs a start'),
            (dict(start='2026-10-12T09:00', end='10:00'), 'end must be a time like'),
        ]
        for fields, expected in cases:
            with self.subTest(fields):
                self.assertProblem(doc(talk(3, **fields)), f'events[0] (id 3): {expected}')

    def test_parents(self) -> None:
        self.assertProblem(doc(talk(3, parent=9)), 'events[0] (id 3): parent 9 is not the id of any event')
        self.assertProblem(doc(talk(3, parent=3)), 'events[0] (id 3): parent is the event itself')
        self.assertProblem(doc(talk(3, parent='1')), 'events[0] (id 3): parent must be the id of another event')
        found = problems_of(doc(talk(1, parent=3), talk(2, parent=1), talk(3, parent=2), talk(4, parent=1)))
        self.assertEqual(found, ['parents form a loop: 1 -> 3 -> 2 -> 1'])

    def test_lists_and_extras(self) -> None:
        cases = [
            (dict(authors='Ada'), 'authors must be a list of names'),
            (dict(authors=['Ada', '']), 'authors must be a list of names'),
            (dict(institutions=[1]), 'institutions must be a list of names'),
            (dict(links=[['Slides']]), 'links must be a list of ["label", "https://..."] pairs'),
            (dict(links=[['Slides', 'javascript:alert(1)']]), 'links must be a list of'),
            (dict(links=[['', 'https://x.example']]), 'links must be a list of'),
            (dict(poster='yes'), 'poster must be true or false'),
            (dict(abstract=['x']), 'abstract must be a string'),
            (dict(openreviewId=''), 'openreviewId must be a non-empty string'),
            (dict(room=3), 'room must be a string'),
            (dict(topic=False), 'topic must be a string'),
        ]
        for fields, expected in cases:
            with self.subTest(fields):
                self.assertProblem(doc(talk(3, **fields)), f'events[0] (id 3): {expected}')

    def test_every_problem_is_reported_at_once(self) -> None:
        found = problems_of(doc(talk(1, location='X'), talk(2, start='soon', durationMinutes=5), talk(2), {'id': 5}))
        self.assertEqual(len(found), 5, found)

    def test_load_reports_a_missing_or_broken_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / 'beta-2027'
            folder.mkdir()
            shutil.copy(CONFERENCES / 'beta-2027' / 'conference.json', folder)
            conf = load_conference(str(folder))
            with self.assertRaisesRegex(SourceError, 'events.json does not exist'):
                conf.adapter.load(conf, LoadOptions())
            (folder / 'events.json').write_text('{"format": "whichtalk-events",', encoding='utf-8')
            with self.assertRaisesRegex(SourceError, 'events.json is not readable JSON'):
                conf.adapter.load(conf, LoadOptions())
            (folder / 'events.json').write_text('{"version": 1, "events": []}', encoding='utf-8')
            with self.assertRaisesRegex(SourceError, 'invalid events.json:\n  format must be "whichtalk-events"'):
                conf.adapter.load(conf, LoadOptions())

if __name__ == '__main__':
    unittest.main()
