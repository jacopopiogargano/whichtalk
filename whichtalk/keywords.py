"""Distinctive keywords picked from each abstract (TF-IDF over the conference's abstracts), for search
and suggestions."""
from __future__ import annotations

import math
import re
from typing import Dict, List

STOPWORDS = frozenset('''
a able about above achieve achieves achieving across again al all allows also an and any approach
approaches are art as at based be because been being below between beyond both by can could demonstrate
demonstrates despite did different do does down due each either else enable enables et etc even every
existing experiments extensive few first for framework frameworks from further furthermore general given
he her here high his how however i if improve improved improves in into introduce introduces is it its
just key large lead leads less like low made make makes making many may me method methods might more
moreover most much must my new no nor not novel number of off often on once one only onto or order other
our ours out over paper papers performance present presents prior problem problems propose proposed
proposes provide provides recent recently remain remains result results second set sets several she
should show shown shows significant significantly since small so some specific state still strong
studies study such task tasks than that the their them then there therefore these they this those three
through thus to toward towards two under up us use used uses using various versus very via vs was way
ways we well were what when where whether which while who whom whose why with within without work works
would yet you your
'''.split())
CLAUSE_BREAK = re.compile(r'[.;:!?()\[\]\n,]')
WORD = re.compile(r'[a-z0-9][a-z0-9+#-]*[a-z0-9+#]|[a-z0-9]')
KEYWORDS_PER_ABSTRACT = 8
MAX_SHARE = {False: 0.12, True: 0.25}     # drop terms found in more than this share of abstracts
PHRASE_BOOST = 1.4


def _term_counts(text: str) -> Dict[str, int]:
    """Words and adjacent-word pairs; a pair never spans a clause break or a stopword."""
    counts: Dict[str, int] = {}
    for clause in CLAUSE_BREAK.split(text.lower()):
        previous = None
        for word in WORD.findall(clause):
            if word in STOPWORDS or len(word) < 3 or word.isdigit():
                previous = None
                continue
            counts[word] = counts.get(word, 0) + 1
            if previous:
                pair = f'{previous} {word}'
                counts[pair] = counts.get(pair, 0) + 1
            previous = word
    return counts


def abstract_keywords(texts: Dict[int, str], limit: int = KEYWORDS_PER_ABSTRACT) -> Dict[int, str]:
    """Up to `limit` distinctive terms per abstract, joined by '|'."""
    counts = {key: _term_counts(text) for key, text in texts.items()}
    doc_freq: Dict[str, int] = {}
    for terms in counts.values():
        for term in terms:
            doc_freq[term] = doc_freq.get(term, 0) + 1
    total = max(1, len(counts))
    picked: Dict[int, str] = {}
    for key, terms in counts.items():
        ranked = []
        for term, freq in terms.items():
            df = doc_freq.get(term, 1)
            phrase = ' ' in term
            if df < 2 or df / total > MAX_SHARE[phrase]:
                continue
            ranked.append(((1 + math.log(freq)) * math.log(total / df) * (PHRASE_BOOST if phrase else 1.0), term))
        ranked.sort(reverse=True)
        chosen: List[str] = []
        for _, term in ranked:
            if len(chosen) >= limit:
                break
            if ' ' not in term and any(term in c.split() for c in chosen if ' ' in c):
                continue  # already covered by a chosen phrase
            chosen.append(term)
        if chosen:
            picked[key] = '|'.join(chosen)
    return picked
