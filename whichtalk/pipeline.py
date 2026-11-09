"""The commands behind the command line.

build: program (from the conference's source adapter) -> catalog and shards -> page -> site folder.
Everything is computed (and the app script checked) before the first file is written. A listed
conference built into docs/ also refreshes the homepage, docs/index.html.
check: the config and, where it can be read without the network, the program.
home: the homepage alone.
"""
from __future__ import annotations

import logging
import subprocess
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

from .bundle import BundleError
from .cache import now_iso
from .checks import ConfigError
from .config import CONFERENCES_DIR, ROOT, Conference, conference_ids, load_conference
from .dataset import build_catalog, catalog_json, shard_scripts
from .home import render_home, write_home
from .keywords import abstract_keywords
from .site import SiteError, Sources, page_path, render_page, write_site
from .sources import LoadOptions, SourceError

log = logging.getLogger(__name__)

HOME_TEMPLATE = 'home.html'


@dataclass
class BuildOptions:
    conference: str
    crawl: bool = True
    offline: bool = False
    max_new: Optional[int] = None
    delay: Optional[float] = None
    out: Optional[Path] = None
    dev: bool = False
    papers_export: bool = False
    open: bool = False
    src: Optional[Path] = None
    conferences_dir: Optional[Path] = None

    def scraper_flags(self) -> List[str]:
        """The options that only a scraper source uses, as given on the command line."""
        given = (('--offline', self.offline), ('--no-crawl', not self.crawl), ('--max-new', self.max_new is not None),
                 ('--delay', self.delay is not None), ('--papers-export', self.papers_export))
        return [flag for flag, on in given if on]


def run_build(opts: BuildOptions) -> int:
    conf = load_conference(opts.conference, conferences_dir=opts.conferences_dir)
    ignored = [] if conf.adapter.scraper else opts.scraper_flags()
    if ignored:
        log.warning('%s: ignoring %s (for scraper sources; this one is %s)', conf.id, ' '.join(ignored), conf.adapter.type)
    try:
        program = conf.adapter.load(conf, LoadOptions(offline=opts.offline, crawl=opts.crawl, max_new=opts.max_new,
                                                      delay=opts.delay, papers_export=opts.papers_export))
    except SourceError as exc:
        log.error('%s: %s\nnothing was written', conf.id, exc)
        return 1

    keywords = abstract_keywords(program.abstracts)
    catalog = build_catalog(conf, program, keywords, now_iso())
    shards = shard_scripts(program.abstracts)
    sources = Sources(conf.root, (opts.src or conf.root / 'src').resolve())
    values = conf.template_values()
    try:
        page = render_page(sources, values, catalog_json(catalog), opts.dev)
    except (BundleError, SiteError) as exc:
        log.error('%s\nnothing was written', exc)
        return 1

    target = page_path((opts.out or (conf.dev_output() if opts.dev else conf.output)).resolve())
    write_site(target, page, shards, sources, opts.dev, values, conf.folder / 'static')
    sites = dict(Counter(e.location for e in program.events))
    log.info('built %s: %d events %s, %d descriptions in %d shards, %d with keywords -> %s (%.1f MB)',
             conf.id, len(program.events), sites, len(program.abstracts), len(shards), len(keywords), target,
             target.stat().st_size / 1e6)
    if opts.dev:
        log.info('dev page: modules need http, so serve it with  python3 -m http.server --directory %s', target.parent)
    if opts.open:
        subprocess.run(['open', str(target)], check=False)
    docs = (conf.root / 'docs').resolve()
    if conf.home['listed'] and docs in target.parents:
        return run_home(docs / 'index.html', opts.src, opts.conferences_dir, conf.root)
    return 0


def run_check(ref: str, offline: bool = False, conferences_dir: Optional[Path] = None) -> int:
    """0 when the config (and the program, when it can be read) is usable; ConfigError otherwise
    for the config, 1 for the program."""
    conf = load_conference(ref, conferences_dir=conferences_dir)
    if conf.adapter.scraper and not offline:
        print(f'{conf.id}: config ok ({conf.adapter.type}: add --offline to also parse its cache)')
        return 0
    try:
        program = conf.adapter.load(conf, LoadOptions(offline=True, crawl=False))
    except SourceError as exc:
        log.error('%s: %s', conf.id, exc)
        return 1
    untimed = sum(1 for e in program.events if not e.start)
    print(f'{conf.id}: ok, {len(program.events)} events ({untimed} without a time), {len(program.abstracts)} abstracts')
    return 0


def run_home(out: Path, src: Optional[Path] = None, conferences_dir: Optional[Path] = None, root: Path = ROOT) -> int:
    template = (src or root / 'src') / HOME_TEMPLATE
    folder = conferences_dir or CONFERENCES_DIR
    try:
        conferences: List[Conference] = [load_conference(cid, root, folder) for cid in conference_ids(folder)]
        page = render_home(template.read_text(encoding='utf-8'), conferences)
    except (ConfigError, SiteError, OSError) as exc:
        log.error('homepage not written: %s', exc)
        return 1
    write_home(page, out, root / 'static')
    log.info('homepage: %s -> %s', ', '.join(c.id for c in conferences if c.home['listed']) or 'no listed conference', out)
    return 0
