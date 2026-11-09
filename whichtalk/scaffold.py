"""`whichtalk new`: a conference folder copied from conferences/_template (or another folder), with
its names, output folder and public address filled in."""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any, Dict, Optional

from .checks import ConfigError
from .config import CONFERENCE_ID, CONFIG_FILE

TEMPLATE = '_template'
YEAR = re.compile(r'(?<!\d)((?:19|20)\d\d)(?!\d)')
PUBLIC_SITE = 'https://whichtalk.com'


def slug(text: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')


def new_conference(conferences_dir: Path, conf_id: str, name: str, short: Optional[str] = None,
                   source: Optional[Path] = None) -> Path:
    """Create conferences/<conf_id>/ and return it; ConfigError if anything is off (nothing is written)."""
    if not CONFERENCE_ID.match(conf_id):
        raise ConfigError(f'not a conference id: {conf_id!r} (lowercase letters, digits and dashes, e.g. yourconf-2027)')
    target = conferences_dir / conf_id
    if target.exists():
        raise ConfigError(f'{target} already exists: not overwriting it')
    source = source or conferences_dir / TEMPLATE
    if not source.is_dir() and (conferences_dir / str(source)).is_dir():
        source = conferences_dir / str(source)       # --from <conference id>
    if not (source / CONFIG_FILE).is_file():
        raise ConfigError(f'{source} has no {CONFIG_FILE} to copy')
    found = YEAR.search(name) or YEAR.search(conf_id)
    if not found:
        raise ConfigError('cannot tell the year: put it in the name or the id, e.g. --name "YourConf 2027"')
    year = found.group(1)
    short = (short or ' '.join(YEAR.sub(' ', name).split())).strip()
    if not slug(short):
        raise ConfigError('the short name needs letters or digits: pass --short, e.g. --short YourConf')
    try:
        data = json.loads((source / CONFIG_FILE).read_text(encoding='utf-8'))
    except ValueError as exc:
        raise ConfigError(f'{source / CONFIG_FILE} is not valid JSON: {exc}') from None
    path = f'{slug(short)}/{year}'
    _fill(data, conf_id, name, short, path, year)

    shutil.copytree(source, target, ignore=shutil.ignore_patterns('.*', '__pycache__', 'cache'))
    (target / CONFIG_FILE).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return target


def _fill(data: Dict[str, Any], conf_id: str, name: str, short: str, path: str, year: str) -> None:
    old_name = data.get('name')
    data.update(id=conf_id, name=name, shortName=short, output=f'docs/{path}')
    data.pop('storageNamespace', None)
    page = data.setdefault('page', {})
    page.update(title=f'WhichTalk · {name}', canonical=f'{PUBLIC_SITE}/{path}/')
    for key in ('description', 'ogDescription'):
        if isinstance(old_name, str) and old_name and isinstance(page.get(key), str):
            page[key] = page[key].replace(old_name, name)
    if isinstance(data.get('home'), dict) and data['home'].get('badge'):
        data['home']['badge'] = f'’{year[2:]}'
