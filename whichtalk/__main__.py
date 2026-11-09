"""Command line: python3 -I whichtalk <command> ...

  build <id>... | --all   read each program, build its site (default: the config's "output")
  check <id>... | --all   check conference.json and, for a file source, the events (--offline: a scraper's cache too)
  list                    every conference: id, name, source type, listed on the homepage, output
  new <id> --name NAME    a new conference folder from conferences/_template (or --from DIR)
  home                    the homepage, docs/index.html, from every listed conference

Exit status: 0 done, 1 a build or check failed, 2 bad arguments or an unusable conference.json.

`python3 -I -m whichtalk` cannot find the package (isolated mode leaves the working directory
off sys.path), so for an isolated run point Python at the folder instead: python3 -I whichtalk build ...
"""
import os
import sys

if not __package__:  # run as a folder: make `whichtalk` importable and drop the folder itself from the path
    _here = os.path.dirname(os.path.abspath(__file__))
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or '.') != _here]
    sys.path.insert(0, os.path.dirname(_here))

import argparse  # noqa: E402
import json  # noqa: E402
import logging  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import List, Optional  # noqa: E402

from whichtalk.checks import ConfigError  # noqa: E402
from whichtalk.config import CONFERENCES_DIR, CONFIG_FILE, ROOT, conference_ids, load_conference  # noqa: E402
from whichtalk.pipeline import BuildOptions, run_build, run_check, run_home  # noqa: E402
from whichtalk.scaffold import new_conference  # noqa: E402

log = logging.getLogger('whichtalk')


def make_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--conferences', type=Path, metavar='DIR', default=CONFERENCES_DIR,
                        help='folder of conference folders (default: conferences/)')
    parser = argparse.ArgumentParser(prog='whichtalk', description='Build WhichTalk, an offline-first conference planner.')
    commands = parser.add_subparsers(dest='command', required=True, metavar='command')

    build = commands.add_parser('build', parents=[common], help='read the program and build the site',
                                description='Read each conference program (fetching politely for a scraper source) '
                                            'and build its site.')
    _conference_args(build)
    build.add_argument('--out', type=Path, metavar='DIR',
                       help='output folder (or .html file) for one conference; default: the config "output", '
                            'or _dev/... with --dev')
    build.add_argument('--dev', action='store_true',
                       help='dev page: loads src/main.js as a module and copies src/ and vendor/ next to it')
    build.add_argument('--open', action='store_true', help='open the result in the default browser (macOS)')
    build.add_argument('--src', type=Path, metavar='DIR', help='app sources (index.html, main.js, styles/); default: src')
    scraper = build.add_argument_group('scraper sources only')
    scraper.add_argument('--offline', action='store_true', help='no network at all: build from the cache only')
    scraper.add_argument('--no-crawl', action='store_true', help='use cached details only (still fetches the schedule)')
    scraper.add_argument('--max-new', type=int, metavar='N', help='max new detail pages to fetch this run')
    scraper.add_argument('--delay', type=float, metavar='S', help='seconds between requests (at least 1.0)')
    scraper.add_argument('--papers-export', action='store_true',
                         help='opt in to fetching the papers export (disallowed by robots.txt for crawlers)')

    check = commands.add_parser('check', parents=[common], help='check conference settings and data, without building',
                                description='Check conference.json and, for an events file, every event. '
                                            'Scraper sources need --offline to also parse their cache.')
    _conference_args(check)
    check.add_argument('--offline', action='store_true', help="also parse a scraper source's cache")

    commands.add_parser('list', parents=[common], help='list the conferences')

    new = commands.add_parser('new', parents=[common], help='create a conference folder from the template',
                              description='Copy conferences/_template (or --from) to conferences/<id> and fill in '
                                          'the names, the output folder and the public address.')
    new.add_argument('id', help='conference id, e.g. yourconf-2027')
    new.add_argument('--name', required=True, help='full name with the year, e.g. "YourConf 2027"')
    new.add_argument('--short', metavar='NAME', help='series name without the year (default: the name minus the year)')
    new.add_argument('--from', dest='source', type=Path, metavar='DIR',
                     help='folder (or conference id) to copy instead of conferences/_template')

    home = commands.add_parser('home', parents=[common], help='build the homepage from the listed conferences')
    home.add_argument('--out', type=Path, metavar='FILE', default=ROOT / 'docs' / 'index.html',
                      help='where to write it (default: docs/index.html)')
    home.add_argument('--src', type=Path, metavar='DIR', help='folder with home.html and 404.html; default: src')
    return parser


def _conference_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument('ids', nargs='*', metavar='id', help='conference id (folder name under conferences/)')
    parser.add_argument('--all', action='store_true', help="every conference (folders starting with '_' are skipped)")


def _selected(parser: argparse.ArgumentParser, args: argparse.Namespace) -> List[str]:
    if args.all == bool(args.ids):
        parser.error(f'{args.command}: give conference ids or --all')
    return conference_ids(args.conferences) if args.all else args.ids


def main(argv: Optional[List[str]] = None) -> int:
    parser = make_parser()
    args = parser.parse_args(argv)
    timestamps = '%(asctime)s ' if args.command == 'build' else ''
    logging.basicConfig(level=logging.INFO, format=timestamps + '%(levelname)s %(message)s')
    try:
        if args.command == 'build':
            return _build(parser, args)
        if args.command == 'check':
            return max([_check(ref, args) for ref in _selected(parser, args)], default=0)
        if args.command == 'list':
            return _list(args.conferences)
        if args.command == 'new':
            target = new_conference(args.conferences, args.id, args.name, args.short, args.source)
            print(f'created {target}\nnext: edit its {CONFIG_FILE} and program, then run  python3 -I whichtalk check {args.id}')
            return 0
        return run_home(args.out.resolve(), args.src, args.conferences)
    except ConfigError as exc:
        log.error('%s', exc)
        return 2


def _build(parser: argparse.ArgumentParser, args: argparse.Namespace) -> int:
    ids = _selected(parser, args)
    if args.out and len(ids) != 1:
        parser.error('build: --out needs exactly one conference')
    status = 0
    for ref in ids:
        options = BuildOptions(conference=ref, crawl=not args.no_crawl, offline=args.offline, max_new=args.max_new,
                               delay=args.delay, out=args.out, dev=args.dev, papers_export=args.papers_export,
                               open=args.open, src=args.src, conferences_dir=args.conferences)
        try:
            status = max(status, run_build(options))
        except ConfigError as exc:
            log.error('%s', exc)
            status = 2
    return status


def _check(ref: str, args: argparse.Namespace) -> int:
    try:
        return run_check(ref, args.offline, args.conferences)
    except ConfigError as exc:
        log.error('%s: %s', ref, exc)
        return 2


def _list(folder: Path) -> int:
    rows = [('id', 'name', 'source', 'listed', 'output')]
    status = 0
    for cid in conference_ids(folder):
        try:
            conf = load_conference(cid, conferences_dir=folder)
            data, listed = conf.data, 'yes' if conf.home['listed'] else 'no'
        except ConfigError:
            status = 1
            try:
                data = json.loads((folder / cid / CONFIG_FILE).read_text(encoding='utf-8'))
            except ValueError:
                data = None
            data = data if isinstance(data, dict) else {}
            listed = f'invalid: run  whichtalk check {cid}'
        source = data.get('source') if isinstance(data.get('source'), dict) else {}
        rows.append((cid, str(data.get('name', '?')), str(source.get('type', '?')), listed, str(data.get('output', '?'))))
    widths = [max(len(row[n]) for row in rows) for n in range(4)]
    for row in rows:
        print('  '.join(cell.ljust(width) for cell, width in zip(row, widths)) + '  ' + row[4])
    return status


if __name__ == '__main__':
    sys.exit(main())
