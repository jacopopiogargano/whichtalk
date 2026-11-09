"""Small file helpers. Every write goes through a temp file in the target folder and os.replace,
so a reader (an open browser tab, a concurrent build) never sees a half-written file."""
from __future__ import annotations

import contextlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Union

PathLike = Union[str, Path]


def write_bytes_atomic(path: PathLike, data: bytes, mode: int = 0o644) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix='.tmp-', suffix=target.suffix)
    try:
        with os.fdopen(fd, 'wb') as fh:
            fh.write(data)
        os.chmod(tmp, mode)
        os.replace(tmp, target)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def write_text_atomic(path: PathLike, text: str) -> None:
    write_bytes_atomic(path, text.encode('utf-8'))


def write_json_atomic(path: PathLike, data: Any) -> None:
    """Compact, key-sorted JSON (the format of the cached details.json and papers.json)."""
    text = json.dumps(data, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    write_text_atomic(path, text)


def read_json(path: PathLike) -> Any:
    return json.loads(Path(path).read_text(encoding='utf-8'))


def copy_file(src: PathLike, dst: PathLike) -> None:
    """Copy through a temp file so the destination is replaced in one step."""
    target = Path(dst)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix='.tmp-', suffix=target.suffix)
    os.close(fd)
    try:
        shutil.copyfile(src, tmp)
        os.chmod(tmp, 0o644)
        os.replace(tmp, target)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def replace_tree(src: PathLike, dst: PathLike) -> None:
    """Make dst an exact copy of src (used for the dev build's src/ and vendor/ folders)."""
    target = Path(dst)
    staging = target.with_name(f'.tmp-{target.name}')
    if staging.exists():
        shutil.rmtree(staging)
    shutil.copytree(src, staging, ignore=shutil.ignore_patterns('.*', '__pycache__'))
    if target.exists():
        shutil.rmtree(target)
    os.replace(staging, target)

