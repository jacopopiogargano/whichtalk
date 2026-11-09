"""A small JavaScript tokenizer for the bundler.

It only has to be right about where tokens start and end, so that module-level import/export
statements and declarations are found and nothing inside a string, template, comment or regular
expression is mistaken for code. A `/` is read as the start of a regular expression unless the
previous token ends an expression (the usual heuristic; it is wrong only after `) /re/`, which
no code here writes).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Tuple

IDENTIFIER = re.compile(r'[A-Za-z_$\u0080-￿][\w$\u0080-￿]*')
NUMBER = re.compile(r'0[xX][\da-fA-F_]+n?|0[oO][0-7_]+n?|0[bB][01_]+n?'
                    r'|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?')
REGEX_FLAGS = re.compile(r'[A-Za-z]*')
PUNCTUATORS = sorted('''>>>= ... === !== **= <<= >>= >>> &&= ||= ??= => == != <= >= && || ?? ?. ++ --
+= -= *= /= %= &= |= ^= ** << >> { } ( ) [ ] ; , < > + - * / % & | ^ ! ~ ? : = . @'''.split(),
                     key=len, reverse=True)
LINE_BREAKS = '\n\r  '
SPACES = ' \t\f\v﻿\xa0'
# After these words an expression starts, so a following `/` opens a regular expression.
EXPRESSION_KEYWORDS = frozenset('return typeof instanceof in of new delete void throw case do else yield await extends'.split())
# Token kinds after which an expression is complete.
VALUE_KINDS = frozenset({'number', 'string', 'regex', 'template', 'template-tail', 'private'})


class LexError(ValueError):
    pass


@dataclass
class Token:
    kind: str           # name, private, number, string, regex, punct, template, template-head/-middle/-tail
    text: str
    start: int
    end: int
    line: int
    newline_before: bool

    def is_punct(self, *texts: str) -> bool:
        return self.kind == 'punct' and self.text in texts

    def is_name(self, *texts: str) -> bool:
        return self.kind == 'name' and self.text in texts


def ends_expression(tok: Token) -> bool:
    if tok.kind == 'name':
        return tok.text not in EXPRESSION_KEYWORDS
    return tok.kind in VALUE_KINDS or tok.is_punct(')', ']', '}', '++', '--')


def tokenize(src: str) -> List[Token]:
    tokens: List[Token] = []
    stack: List[str] = []   # '{' for braces, '${' for template substitutions
    pos, line, newline = 0, 1, False
    if src.startswith('#!'):
        pos = _line_end(src, 0)
    size = len(src)
    while pos < size:
        ch = src[pos]
        if ch in SPACES:
            pos += 1
            continue
        if ch in LINE_BREAKS:
            if not (ch == '\n' and pos and src[pos - 1] == '\r'):
                line += 1
            newline = True
            pos += 1
            continue
        if src.startswith('//', pos):
            pos = _line_end(src, pos)
            continue
        if src.startswith('/*', pos):
            close = src.find('*/', pos + 2)
            if close < 0:
                raise LexError(f'line {line}: unterminated comment')
            breaks = _count_lines(src[pos:close])
            line, newline, pos = line + breaks, newline or breaks > 0, close + 2
            continue
        start, start_line = pos, line
        if IDENTIFIER.match(src, pos):
            kind, pos = 'name', IDENTIFIER.match(src, pos).end()  # type: ignore[union-attr]
        elif ch == '#' and IDENTIFIER.match(src, pos + 1):
            kind, pos = 'private', IDENTIFIER.match(src, pos + 1).end()  # type: ignore[union-attr]
        elif ch.isdigit() or (ch == '.' and src[pos + 1:pos + 2].isdigit()):
            kind, pos = 'number', NUMBER.match(src, pos).end()  # type: ignore[union-attr]
        elif ch in '\'"':
            kind, pos = 'string', _string_end(src, pos, line)
        elif ch == '`':
            pos, closed = _template_end(src, pos + 1, line)
            kind = 'template' if closed else 'template-head'
            if not closed:
                stack.append('${')
        elif ch == '}' and stack and stack[-1] == '${':
            stack.pop()
            pos, closed = _template_end(src, pos + 1, line)
            kind = 'template-tail' if closed else 'template-middle'
            if not closed:
                stack.append('${')
        elif ch == '/' and _regex_allowed(tokens):
            kind, pos = 'regex', _regex_end(src, pos, line)
        else:
            kind, pos = 'punct', pos + _punct_length(src, pos, line)
            text = src[start:pos]
            if text == '{':
                stack.append('{')
            elif text == '}' and stack:
                stack.pop()
        tokens.append(Token(kind, src[start:pos], start, pos, start_line, newline))
        line += _count_lines(src[start:pos])
        newline = False
    return tokens


def _line_end(src: str, pos: int) -> int:
    ends = [i for i in (src.find(c, pos) for c in LINE_BREAKS) if i >= 0]
    return min(ends) if ends else len(src)


def _count_lines(text: str) -> int:
    return text.count('\n') + text.count('\r') - text.count('\r\n') + text.count(' ') + text.count(' ')


def _regex_allowed(tokens: List[Token]) -> bool:
    return not tokens or not ends_expression(tokens[-1])


def _string_end(src: str, pos: int, line: int) -> int:
    quote, i = src[pos], pos + 1
    while i < len(src):
        ch = src[i]
        if ch == '\\':
            i += 3 if src.startswith('\r\n', i + 1) else 2
        elif ch == quote:
            return i + 1
        elif ch in '\n\r':
            break
        else:
            i += 1
    raise LexError(f'line {line}: unterminated string')


def _template_end(src: str, i: int, line: int) -> Tuple[int, bool]:
    """Scan template text from i: (position after the closing ` or the ${, closed?)."""
    while i < len(src):
        ch = src[i]
        if ch == '\\':
            i += 2
        elif ch == '`':
            return i + 1, True
        elif ch == '$' and src.startswith('${', i):
            return i + 2, False
        else:
            i += 1
    raise LexError(f'line {line}: unterminated template literal')


def _regex_end(src: str, pos: int, line: int) -> int:
    i, in_class = pos + 1, False
    while i < len(src):
        ch = src[i]
        if ch == '\\':
            i += 2
            continue
        if ch in LINE_BREAKS:
            break
        if ch == '[':
            in_class = True
        elif ch == ']':
            in_class = False
        elif ch == '/' and not in_class:
            return REGEX_FLAGS.match(src, i + 1).end()  # type: ignore[union-attr]
        i += 1
    raise LexError(f'line {line}: unterminated regular expression')


def _punct_length(src: str, pos: int, line: int) -> int:
    for punct in PUNCTUATORS:
        if src.startswith(punct, pos):
            if punct == '?.' and src[pos + 2:pos + 3].isdigit():
                continue  # `a ?.5 : b` is a conditional, not optional chaining
            return len(punct)
    raise LexError(f'line {line}: unexpected character {src[pos]!r}')
