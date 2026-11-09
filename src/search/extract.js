// Interest discovery: topic autocomplete over the conference's own vocabulary, popular topics,
// and keyword extraction from free text (profile pages, paper lists, pasted text).
import { normalize } from '../lib/text.js'
import { data } from '../state/store.js'
import { diceOverlap, docFrequency, eachTerm, ensureTermIndex, mostFrequentKey, prepareAutocomplete, STOPWORDS, termIndex, trigramSet, WORD_SPLIT } from './index.js'

// How well a candidate's words cover the typed words: a prefix counts 1, otherwise a typo-tolerant
// trigram match for words of 4+ letters. Extra words in the candidate cost a little.
function wordCoverage (typed, item) {
  let total = 0
  for (const q of typed) {
    let best = 0
    for (const cw of item.words) {
      const s = cw.w.startsWith(q.w) ? 1 : q.w.length >= 4 ? diceOverlap(q.grams, cw.grams) : 0
      if (s > best) best = s
    }
    if (best >= 0.45) total += best
  }
  return (total / typed.length) * (1 - 0.06 * Math.max(0, item.words.length - typed.length))
}

function autocompleteScore (folded, typedGrams, typed, item) {
  if (item.folded.startsWith(folded)) return 1.1
  if (item.folded.includes(' ' + folded)) return 1
  if (item.folded.includes(folded)) return 0.85
  const coverage = typed.length ? wordCoverage(typed, item) : 0
  const overall = diceOverlap(typedGrams, item.grams)
  return Math.max(coverage * 0.95, overall >= 0.42 ? overall * 0.9 : 0)
}

// Topics and phrases for the interest field, skipping interests the user already has.
export function autocompleteSearch (query, limit = 8) {
  const folded = normalize(query).trim()
  if (folded.length < 2) return []
  const typedGrams = trigramSet(folded)
  const typed = folded.split(WORD_SPLIT).filter(Boolean).map(w => ({ w, grams: trigramSet(w) }))
  const owned = new Set(data.interests.map(it => normalize(it.text)))
  const ranked = []
  for (const item of prepareAutocomplete()) {
    if (owned.has(item.folded)) continue
    const s = autocompleteScore(folded, typedGrams, typed, item)
    if (s >= 0.45) ranked.push({ item, s: s * (1 + 0.04 * Math.log(1 + item.n)) * (item.kind === 'topic' ? 1.05 : 1) })
  }
  return ranked.sort((a, b) => b.s - a.s).slice(0, limit).map(r => r.item)
}

export function suggestTopics () {
  return prepareAutocomplete().filter(c => c.kind === 'topic' || c.n >= 40).sort((a, b) => b.n - a.n).map(c => c.label)
}

// Words that are everywhere on personal and lab pages but say nothing about research topics.
const WEB_STOPWORDS = ('home page homepage about contact email mail cv resume blog news post posts github twitter linkedin scholar google ' +
  'publications publication talks talk teaching student students phd ph professor prof assistant associate researcher research researchers ' +
  'interests interested interest work works working worked lab labs group groups department dept team join joined year years currently ' +
  'previously current previous university institute school college member members copyright rights reserved menu search click read more ' +
  'website site welcome hi hello am im like also recent recently new latest award awards selected service reviewer program committee jan feb ' +
  'mar apr may jun jul aug sep oct nov dec january february march april june july august september october november december 2015 2016 2017 ' +
  '2018 2019 2020 2021 2022 2023 2024 2025 2026 arxiv preprint conference proceedings journal workshop neurips icml iclr cvpr eccv iccv acl ' +
  'emnlp naacl aaai ijcai kdd pdf code slides video bibtex abstract https http www com org edu technique techniques').split(' ')

// True when the phrase `small` occurs as whole words inside `big`.
const containsPhrase = (big, small) => (' ' + big + ' ').includes(' ' + small + ' ')

// Weighted interests from text segments ({ text, weight }), TF-IDF against the conference corpus:
// terms must occur in at least two documents and not be too common; longer phrases win over the
// words inside them.
export function extractInterests (segments, limit = 18) {
  ensureTermIndex()
  const stop = new Set([...STOPWORDS, ...WEB_STOPWORDS])
  const freq = new Map()
  const forms = new Map()
  for (const seg of segments) {
    if (!seg || !seg.text) continue
    const w = seg.weight || seg.w || 1
    eachTerm(seg.text, (t, surface) => {
      freq.set(t, (freq.get(t) || 0) + w)
      let seen = forms.get(t)
      if (!seen) { seen = new Map(); forms.set(t, seen) }
      seen.set(surface, (seen.get(surface) || 0) + 1)
    }, stop, true)
  }
  const total = termIndex.n
  const candidates = []
  for (const [t, f] of freq) {
    const parts = t.split(' ')
    const size = parts.length
    if (size === 3 && f < 2) continue
    const d = size === 3 ? Math.min(docFrequency(parts[0] + ' ' + parts[1]), docFrequency(parts[1] + ' ' + parts[2])) : docFrequency(t)
    if (d < 2 || d / total > (size > 1 ? 0.2 : 0.05)) continue
    const score = (1 + Math.log(f)) * Math.log(total / d) * (size === 3 ? 1.6 : size === 2 ? 1.35 : 1)
    candidates.push({ t, d, size, score, label: mostFrequentKey(forms.get(t)) })
  }
  candidates.sort((a, b) => b.score - a.score)
  const chosen = []
  for (const c of candidates) {
    if (chosen.length >= limit) break
    if (chosen.some(x => x.size > c.size && containsPhrase(x.t, c.t))) continue
    if (c.size === 3) {
      for (let k = chosen.length - 1; k >= 0; k--) if (chosen[k].size < 3 && containsPhrase(c.t, chosen[k].t)) chosen.splice(k, 1)
    }
    chosen.push(c)
  }
  const top = chosen.length ? chosen[0].score : 1
  return chosen.map(c => ({ text: c.label, weight: Math.max(0.5, Math.min(3, Math.round((0.75 + 2.25 * c.score / top) * 4) / 4)), n: c.d }))
}

// Readable text from untrusted HTML: parsed inertly (scripts never run), boilerplate dropped.
export function htmlToText (html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, style, noscript, template, svg, iframe, object, embed, nav, footer, form, button').forEach(n => n.remove())
  const description = doc.querySelector('meta[name="description"]')
  const parts = [doc.title || '', description ? description.getAttribute('content') || '' : '']
  doc.querySelectorAll('h1, h2, h3, h4, p, li, td, dd, blockquote, a').forEach(n => parts.push(n.textContent || ''))
  if (parts.join('').trim().length < 40 && doc.body) parts.push(doc.body.textContent || '')
  return parts.map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, 200000)
}
