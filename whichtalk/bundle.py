"""Bundle the ES modules under src/ into one classic script.

Modules are ordered the way a browser evaluates them: depth-first, post-order, following import
statements in source order, skipping modules already visited (so cycles are fine). Each module
loses its import statements (replaced by blank lines, so line numbers survive) and the `export`
keyword in front of its declarations; the bundle wraps them all in one strict function scope.
That only works when no two modules declare the same top-level name, so that is checked, along
with every imported name, every imported file and the few module forms the app may use:

  import { a, b } from './x.js'
  export function f / export async function f / export class C / export const a / export let b
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, List, Tuple

from .jsmodule import Module, read_module

log = logging.getLogger(__name__)


class BundleError(Exception):
    def __init__(self, problems: List[str]) -> None:
        super().__init__('the app modules cannot be bundled:\n  ' + '\n  '.join(problems))
        self.problems = problems


def link(entry: Path, root: Path) -> Tuple[List[Module], List[str]]:
    """Modules in evaluation order, and every problem found."""
    problems: List[str] = []
    modules: Dict[Path, Module] = {}
    order: List[Module] = []

    def visit(path: Path, importer: str) -> None:
        if path in modules:
            return
        if not path.is_file():
            problems.append(f'{importer}: imported file {os.path.relpath(path, root)} does not exist')
            return
        module = modules[path] = read_module(path, root, problems)
        for statement in module.imports:
            if statement.target is not None:
                visit(statement.target, f'{module.label}:{statement.line}')
        order.append(module)

    visit(entry.resolve(), 'entry')
    owners: Dict[str, List[str]] = {}
    for module in order:
        for name in module.declared:
            owners.setdefault(name, []).append(module.label)
        seen: Dict[str, str] = {}
        for statement in module.imports:
            target = modules.get(statement.target) if statement.target else None
            for name in statement.names:
                where = f'{module.label}:{statement.line}'
                if target is not None and name not in target.exports:
                    problems.append(f'{where}: `{name}` is not exported by {statement.specifier}')
                if name in seen or name in module.declared:
                    problems.append(f'{where}: `{name}` is already {"imported" if name in seen else "declared"} here')
                seen[name] = statement.specifier
    for name, labels in sorted(owners.items()):
        if len(labels) > 1:
            problems.append(f'top-level name `{name}` is declared in several modules: {", ".join(labels)}')
    return order, problems


def bundle_modules(entry: Path, root: Path) -> str:
    """The modules as one function body, or BundleError listing every problem."""
    order, problems = link(entry, root)
    if problems:
        raise BundleError(problems)
    body = []
    for module in order:
        text = module.stripped()
        body.append(f'// ---- {module.label} ----\n{text}' + ('' if text.endswith('\n') else '\n'))
    return ''.join(body)


def production_script(entry: Path, root: Path, classic: List[Path]) -> str:
    """Classic scripts first (vendor/qrcode.js defines the global `qrcode`), then the modules."""
    parts = ["'use strict'"]
    for path in classic:
        parts.append(f'// ---- {os.path.relpath(path, root)} ----\n' + path.read_text(encoding='utf-8'))
    parts.append(";(function () {\n'use strict'\n" + bundle_modules(entry, root) + '})()\n')
    return '\n'.join(parts)


def check_problems(entry: Path, root: Path) -> List[str]:
    return link(entry, root)[1]


def check_syntax(js: str) -> None:
    """Refuse a script that does not parse (node --check, when node is installed)."""
    node = shutil.which('node')
    if not node:
        log.warning('node not found: skipping the JavaScript syntax check')
        return
    fd, tmp = tempfile.mkstemp(suffix='.js', prefix='.tmp-bundle-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            fh.write(js)
        result = subprocess.run([node, '--check', tmp], capture_output=True, text=True, check=False)
        if result.returncode:
            raise BundleError(['the bundled script does not parse:\n' + result.stderr[:1200]])
    finally:
        os.unlink(tmp)
