"""Inline LaTeX in titles and abstracts ($\\ell_p$, G$^2$TR, \\mathbf{x}) rendered as plain Unicode."""
from __future__ import annotations

import re
import unicodedata

GREEK_AND_SYMBOLS = {
    'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'Gamma': 'Γ', 'delta': 'δ', 'Delta': 'Δ', 'epsilon': 'ε',
    'varepsilon': 'ε', 'zeta': 'ζ', 'eta': 'η', 'theta': 'θ', 'Theta': 'Θ', 'kappa': 'κ', 'lambda': 'λ',
    'Lambda': 'Λ', 'mu': 'μ', 'nu': 'ν', 'xi': 'ξ', 'pi': 'π', 'Pi': 'Π', 'rho': 'ρ', 'sigma': 'σ',
    'Sigma': 'Σ', 'tau': 'τ', 'phi': 'φ', 'varphi': 'φ', 'Phi': 'Φ', 'chi': 'χ', 'psi': 'ψ', 'Psi': 'Ψ',
    'omega': 'ω', 'Omega': 'Ω', 'ell': 'ℓ',
    'infty': '∞', 'star': '⋆', 'ast': '∗', 'pm': '±', 'times': '×', 'cdot': '·', 'circ': '∘',
    'to': '→', 'rightarrow': '→', 'leftarrow': '←', 'leq': '≤', 'le': '≤', 'geq': '≥', 'ge': '≥',
    'neq': '≠', 'approx': '≈', 'sim': '∼', 'in': '∈', 'sum': 'Σ', 'prod': 'Π', 'partial': '∂',
    'nabla': '∇', 'forall': '∀', 'exists': '∃', 'cup': '∪', 'cap': '∩', 'emptyset': '∅', 'dagger': '†',
    'prime': '′', 'sqrt': '√', 'ldots': '…', 'dots': '…', 'cdots': '⋯',
    'min': 'min', 'max': 'max', 'log': 'log', 'exp': 'exp',
}
MATH_ACCENTS = {'tilde': '\u0303', 'hat': '\u0302', 'bar': '\u0304', 'vec': '\u20d7', 'dot': '\u0307'}
TEXT_ACCENTS = {'"': '\u0308', "'": '\u0301', '`': '\u0300', '^': '\u0302', '~': '\u0303'}
RAISED = str.maketrans('0123456789+-=()nikpTtx*', '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱᵏᵖᵀᵗˣ*')
LOWERED = str.maketrans('0123456789+-=()aeoxhklmnpst', '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜ')

STYLE_MACRO = re.compile(
    r'\\(?:mathbf|mathcal|mathrm|mathit|mathsf|mathtt|mathbb|mathfrak|text|textit|textbf|texttt|textrm|textsc|emph'
    r'|boldsymbol|bm|mbox|operatorname)\s*\{([^{}]*)\}')
PDF_STRING_KEEP_TEX = re.compile(r'\\texorpdfstring\{((?:[^{}]|\{[^{}]*\})*)\}\{[^{}]*\}')
PDF_STRING_KEEP_TEXT = re.compile(r'\\texorpdfstring\{[^{}]*\}\{([^{}]*)\}')
ACCENTED_LETTER = re.compile(r'\\(["\'`^~])\{?([A-Za-z])\}?')
DOLLAR = re.compile(r'(?<!\\)\$')
BRACED_SCRIPT = re.compile(r'([\^_])(\{([^{}\\]*)\})')
ANY_SCRIPT = re.compile(r'([\^_])(\{([^{}]*)\}|.)')
ACCENT_MACRO = re.compile(r'\\(tilde|hat|bar|vec|dot)\s*\{([^{}]*)\}')
SQRT_MACRO = re.compile(r'\\sqrt\s*\{([^{}]*)\}')
MATH_ESCAPE = re.compile(r'\\([&%_#{}$])')
TEXT_ESCAPE = re.compile(r'\\([&%_#$])')
NAMED_MACRO = re.compile(r'\\([A-Za-z]+)')
MACRO_SLASH = re.compile(r'\\(?=[A-Za-z])')
THIN_SPACE = re.compile(r'\\[,;! ]')
SPACES = re.compile(r'\s+')


def tex_to_text(text: str) -> str:
    if '$' not in text and '\\' not in text:
        return text
    text = PDF_STRING_KEEP_TEX.sub(r'\1', text)
    text = ACCENTED_LETTER.sub(_accented, text)
    text = text.replace('\\\\', ' ').replace('\\ ', ' ')
    pieces = DOLLAR.split(text)
    last = len(pieces) - 1
    rendered = []
    for n, piece in enumerate(pieces):
        inside_math = n % 2 == 1
        if inside_math and n < last:
            rendered.append(_render_math(piece))
        elif inside_math:  # a lone `$` with no closing partner stays literal
            rendered.append('$' + _drop_styles(piece))
        else:
            rendered.append(TEXT_ESCAPE.sub(r'\1', MACRO_SLASH.sub('', _drop_styles(piece))))
    return SPACES.sub(' ', ''.join(rendered)).strip()


def _accented(m: 're.Match[str]') -> str:
    return unicodedata.normalize('NFC', m.group(2) + TEXT_ACCENTS[m.group(1)])


def _drop_styles(piece: str) -> str:
    return STYLE_MACRO.sub(r'\1', PDF_STRING_KEEP_TEXT.sub(r'\1', piece))


def _script(m: 're.Match[str]') -> str:
    """x^{2} -> x², a_i -> aᵢ; scripts with characters that have no Unicode form keep their marker."""
    marker = m.group(1)
    body = m.group(2) if m.group(3) is None else m.group(3)
    converted = body.translate(RAISED if marker == '^' else LOWERED)
    every_char_mapped = all(new != old or new in '*' for new, old in zip(converted, body))
    if every_char_mapped or (len(body) == 1 and not body.isalnum()):
        return converted
    return marker + body


def _sqrt(m: 're.Match[str]') -> str:
    radicand = m.group(1)
    return '√' + (radicand if len(radicand) == 1 else f'({radicand})')


def _render_math(seg: str) -> str:
    seg = PDF_STRING_KEEP_TEXT.sub(r'\1', seg)
    for _ in range(3):  # innermost groups first: \mathbf{D^{3}S^{2}}
        seg = BRACED_SCRIPT.sub(_script, seg)
        seg = STYLE_MACRO.sub(r'\1', seg)
    seg = ACCENT_MACRO.sub(lambda m: m.group(2) + MATH_ACCENTS[m.group(1)], seg)
    seg = SQRT_MACRO.sub(_sqrt, seg)
    seg = MATH_ESCAPE.sub(r'\1', seg)
    seg = NAMED_MACRO.sub(lambda m: GREEK_AND_SYMBOLS.get(m.group(1), m.group(1)), seg)
    seg = ANY_SCRIPT.sub(_script, seg)
    return THIN_SPACE.sub(' ', seg).replace('{', '').replace('}', '')
