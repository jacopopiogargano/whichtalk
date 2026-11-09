"""One ES module's top level, read with the jslex tokenizer: its import statements, its exports,
every name it declares at the top level, and the cuts that turn it into plain script code
(import statements become blank lines, `export ` in front of a declaration disappears)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .jslex import LexError, Token, ends_expression, tokenize

DECLARATION_WORDS = ('function', 'async', 'class', 'const', 'let', 'var')
OPENERS, CLOSERS = ('(', '[', '{'), (')', ']', '}')
NOT_CONTINUING = ('{', '!', '~', '++', '--', '...', ';', '@')


@dataclass
class ImportStatement:
    names: List[str]
    specifier: str
    target: Optional[Path]
    line: int


@dataclass
class Module:
    path: Path
    label: str
    source: str
    imports: List[ImportStatement] = field(default_factory=list)
    exports: Dict[str, int] = field(default_factory=dict)       # name -> line
    declared: Dict[str, int] = field(default_factory=dict)      # every top-level name -> line
    cuts: List[Tuple[int, int, str]] = field(default_factory=list)

    def stripped(self) -> str:
        out, last = [], 0
        for start, end, replacement in sorted(self.cuts):
            out.append(self.source[last:start])
            out.append(replacement)
            last = end
        out.append(self.source[last:])
        return ''.join(out)


class _ModuleReader:
    """Reads one module's top level: imports, exports and declarations."""

    def __init__(self, module: Module, problems: List[str]) -> None:
        self.m, self.problems = module, problems
        self.toks = tokenize(module.source)

    def fail(self, tok: Optional[Token], message: str) -> None:
        line = tok.line if tok else (self.toks[-1].line if self.toks else 1)
        self.problems.append(f'{self.m.label}:{line}: {message}')

    def tok(self, i: int) -> Optional[Token]:
        return self.toks[i] if 0 <= i < len(self.toks) else None

    def read(self) -> None:
        for i, t in enumerate(self.toks):
            nxt = self.tok(i + 1)
            if t.is_name('import') and not self.after_dot(i) and nxt and nxt.is_punct('(', '.'):
                self.fail(t, 'dynamic import() and import.meta are not supported')
        depth, i = 0, 0
        while i < len(self.toks):
            t = self.toks[i]
            if t.is_name('import') and not self.after_dot(i) and depth == 0:
                nxt = self.tok(i + 1)
                if not (nxt and nxt.is_punct('(', '.')):
                    i = self.read_import(i)
                    continue
            elif t.is_name('export') and not self.after_dot(i) and depth == 0:
                i = self.read_export(i)
                continue
            elif depth == 0 and t.is_name(*DECLARATION_WORDS) and self.starts_statement(i):
                i = self.read_declaration(i, exported=False)
                continue
            if t.is_punct(*OPENERS) or t.kind == 'template-head':
                depth += 1
            elif t.is_punct(*CLOSERS) or t.kind == 'template-tail':
                depth -= 1
            i += 1

    def after_dot(self, i: int) -> bool:
        return i > 0 and self.toks[i - 1].is_punct('.', '?.')

    def starts_statement(self, i: int) -> bool:
        t, prev = self.toks[i], self.tok(i - 1)
        if t.is_name('async') and not (self.tok(i + 1) and self.toks[i + 1].is_name('function')
                                       and not self.toks[i + 1].newline_before):
            return False
        return prev is None or prev.is_punct(';', '}') or (t.newline_before and ends_expression(prev))

    def declare(self, tok: Optional[Token], exported: bool) -> None:
        if tok is None or tok.kind != 'name':
            self.fail(tok, 'expected a name')
            return
        if tok.text in self.m.declared:
            self.fail(tok, f'`{tok.text}` is declared twice in this module')
        self.m.declared[tok.text] = tok.line
        if exported:
            self.m.exports[tok.text] = tok.line

    def read_import(self, i: int) -> int:
        start = self.toks[i]
        j = i + 1
        if not (self.tok(j) and self.toks[j].is_punct('{')):
            self.fail(start, "unsupported import: use import { a, b } from './file.js'")
            return j
        names: List[str] = []
        j += 1
        while self.tok(j) and not self.toks[j].is_punct('}'):
            t = self.toks[j]
            if t.kind == 'name':
                if self.tok(j + 1) and self.toks[j + 1].is_name('as'):
                    self.fail(t, f'`import {{ {t.text} as … }}` renames are not supported: use the exported name')
                    j += 2
                names.append(t.text)
            elif not t.is_punct(','):
                self.fail(t, f'unexpected {t.text!r} in an import list')
            j += 1
        source = self.tok(j + 2)
        if not (self.tok(j + 1) and self.toks[j + 1].is_name('from') and source and source.kind == 'string'):
            self.fail(start, "unsupported import: use import { a, b } from './file.js'")
            return j + 1
        end = source.end
        semicolon = self.tok(j + 3)
        if semicolon and semicolon.is_punct(';') and not semicolon.newline_before:
            end = semicolon.end
        specifier = source.text[1:-1]
        target = None
        if not (specifier.startswith(('./', '../')) and specifier.endswith('.js')):
            self.fail(source, f"import from {specifier!r}: only relative paths ending in .js are supported")
        else:
            target = (self.m.path.parent / specifier).resolve()
        self.m.imports.append(ImportStatement(names, specifier, target, start.line))
        removed = self.m.source[start.start:end]
        self.m.cuts.append((start.start, end, '\n' * removed.count('\n')))
        return (j + 4) if end != source.end else (j + 3)

    def read_export(self, i: int) -> int:
        word, nxt = self.toks[i], self.tok(i + 1)
        allowed = nxt and (nxt.is_name('function', 'class', 'const', 'let')
                           or (nxt.is_name('async') and self.tok(i + 2) and self.toks[i + 2].is_name('function')))
        if not allowed:
            shown = nxt.text if nxt else 'end of file'
            self.fail(word, f'unsupported export form `export {shown}`: export function/class/const/let only')
            return i + 1
        end = word.end
        while end < len(self.m.source) and self.m.source[end] in ' \t':
            end += 1
        self.m.cuts.append((word.start, end, ''))
        return self.read_declaration(i + 1, exported=True)

    def read_declaration(self, i: int, exported: bool) -> int:
        word = self.toks[i]
        if word.is_name('async'):
            i, word = i + 1, self.toks[i + 1]
        if word.is_name('function', 'class'):
            j = i + 1
            if word.text == 'function' and self.tok(j) and self.toks[j].is_punct('*'):
                j += 1
            self.declare(self.tok(j), exported)
            return j + 1
        j = i + 1
        while True:
            j = self.read_binding(j, exported)
            if self.tok(j) and self.toks[j].is_punct('='):
                j = self.skip_expression(j + 1)
            if self.tok(j) and self.toks[j].is_punct(','):
                j += 1
                continue
            return j

    def read_binding(self, j: int, exported: bool) -> int:
        t = self.tok(j)
        if t is not None and t.is_punct('{', '['):
            return self.read_pattern(j, exported)
        self.declare(t, exported)
        return j + 1

    def read_pattern(self, j: int, exported: bool) -> int:
        """Names bound by a destructuring pattern ({ a, b: c, ...d } or [a, , b = 1])."""
        closer = '}' if self.toks[j].text == '{' else ']'
        j += 1
        while self.tok(j) and not self.toks[j].is_punct(closer):
            t = self.toks[j]
            if t.is_punct(','):
                j += 1
                continue
            if t.is_punct('...'):
                j = self.read_binding(j + 1, exported)
            elif closer == ']':
                j = self.read_binding(j, exported)
            else:
                key_end = self.skip_balanced(j) if t.is_punct('[') else j + 1
                if self.tok(key_end) and self.toks[key_end].is_punct(':'):
                    j = self.read_binding(key_end + 1, exported)
                else:
                    self.declare(t, exported)
                    j = key_end
            if self.tok(j) and self.toks[j].is_punct('='):
                j = self.skip_expression(j + 1)
        return j + 1

    def skip_balanced(self, j: int) -> int:
        depth = 0
        while self.tok(j):
            t = self.toks[j]
            if t.is_punct(*OPENERS) or t.kind == 'template-head':
                depth += 1
            elif t.is_punct(*CLOSERS) or t.kind == 'template-tail':
                depth -= 1
                if depth == 0:
                    return j + 1
            j += 1
        return j

    def skip_expression(self, j: int) -> int:
        """Index of the first token after an initializer: a `,` or `;` at its own level, an unmatched
        closer, or a token on a new line that cannot continue it (automatic semicolon insertion)."""
        depth, first = 0, j
        while self.tok(j):
            t = self.toks[j]
            if depth == 0:
                if t.is_punct(',', ';') or t.is_punct(*CLOSERS):
                    return j
                if j > first and t.newline_before and ends_expression(self.toks[j - 1]) and not _continues(t):
                    return j
            if t.is_punct(*OPENERS) or t.kind == 'template-head':
                depth += 1
            elif t.is_punct(*CLOSERS) or t.kind == 'template-tail':
                depth -= 1
            j += 1
        return j


def _continues(tok: Token) -> bool:
    """Can this token, at the start of a line, continue the expression on the line before?"""
    if tok.kind == 'punct':
        return tok.text not in NOT_CONTINUING
    if tok.kind in ('template', 'template-head'):
        return True  # a tagged template
    return tok.is_name('in', 'instanceof')


def read_module(path: Path, root: Path, problems: List[str]) -> Module:
    label = os.path.relpath(path, root)
    module = Module(path=path, label=label, source=path.read_text(encoding='utf-8'))
    try:
        _ModuleReader(module, problems).read()
    except LexError as exc:
        problems.append(f'{label}: {exc}')
    return module
