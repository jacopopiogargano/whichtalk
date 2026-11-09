// On-device text index. Two structures, both built lazily after the first render:
// - haystack/metaText: folded plain text per event for substring search;
// - termIndex: stems and adjacent-word phrases from title, topic, session title and abstract
//   keywords, each posting tagged with the fields it came from (weighted by FIELD_WEIGHTS).
import { EVENTS, EVENT_COUNT, isGroupEvent } from '../data/catalog.js'
import { HIDDEN_TRACKS, CONTAINER_KINDS, GENERIC_SESSION_TITLE } from '../data/conference.js'
import { normalize } from '../lib/text.js'

// Splits folded text into words; '+' and '#' stay inside words (c++, c#).
export const WORD_SPLIT = /[^a-z0-9+#]+/
const PHRASE_BREAK = /[.;:!?()[\]{}"\n,|/•·–—]+/

// Topics, rooms, kinds, institutions and session titles are shared by many events: fold each
// distinct string once.
function memoizeByText (fn) {
  const seen = new Map()
  return text => {
    let out = seen.get(text)
    if (out === undefined) { out = fn(text); seen.set(text, out) }
    return out
  }
}

export let haystack = null
export let metaText = null

export function ensureHaystack () {
  if (haystack) return
  const fold = memoizeByText(normalize)
  const hay = new Array(EVENT_COUNT)
  const meta = new Array(EVENT_COUNT)
  for (let i = 0; i < EVENT_COUNT; i++) {
    const e = EVENTS[i]
    const own = normalize(e.title + '\n' + (e.authors || []).join(' ⋅ ') + '\n' + (e.keywords || '').replace(/\|/g, ' · '))
    hay[i] = own + '\n' + fold(e.topic) + (e.institutions ? '\n' + e.institutions.map(fold).join('\n') : '')
    meta[i] = fold(e.room) + '\n' + fold(e.parentTitle) + '\n' + fold(e.kind)
  }
  haystack = hay
  metaText = meta
}

// ---------- tokenizer ----------
export const STOPWORDS = new Set(('a an the of for and or nor in on at to from by with without via using use used uses based towards toward ' +
  'through into onto over under is are was were be been being can could should would may might must do does did we our ours us you your i my ' +
  'me he she his her they them their its it this that these those as not no than then so such very more most less many much all any each ' +
  'every other some both either one two three first second also only just how what when where why which who whom whose while within across ' +
  'between beyond about above below up down out off again further once here there whether if else vs versus et al etc paper papers approach ' +
  'approaches method methods framework frameworks study studies result results show shows propose proposed toward make making made let s t').split(' '))

// Words where a trailing s is part of the stem.
const KEEP_FINAL_S = new Set(['bias', 'lens', 'atlas', 'canvas', 'chaos', 'gas', 'alias', 'its', 'this', 'was', 'has', 'does', 'gpus', 'llms', 'tpus'])

// A deliberately light stemmer: plural, -ing/-ed/-ly, -ic, -ize/-ization, -ation and final -e.
function stemWord (w) {
  if (w.length <= 3 || KEEP_FINAL_S.has(w)) return w === 'llms' ? 'llm' : w
  let s = w
  if (s.endsWith('ies') && s.length > 4) s = s.slice(0, -3) + 'y'
  else if (/(sses|shes|ches|xes|zes)$/.test(s)) s = s.slice(0, -2)
  else if (s.endsWith('s') && !/(ss|us|is|ys)$/.test(s)) s = s.slice(0, -1)

  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3)
  else if (s.length > 5 && s.endsWith('ed') && !s.endsWith('eed')) s = s.slice(0, -2)
  else if (s.length > 5 && s.endsWith('ly')) s = s.slice(0, -2)

  if (s.length > 6 && s.endsWith('ic')) s = s.slice(0, -2)

  if (s.endsWith('ization')) return s.slice(0, -7) + 'iz'
  if (s.endsWith('izer')) return s.slice(0, -4) + 'iz'
  if (s.endsWith('ize')) return s.slice(0, -3) + 'iz'
  if (s.length > 6 && s.endsWith('ation')) return s.slice(0, -3)
  if (s.length > 5 && s.endsWith('e')) return s.slice(0, -1)
  return s
}
const stemOf = memoizeByText(stemWord)

// Calls cb(token, surface) for each word stem and each pair of adjacent stems (and triples when
// asked). Punctuation, stopwords, numbers and one-letter words break phrases.
export function eachTerm (text, cb, stop = STOPWORDS, withTriples = false) {
  for (const chunk of normalize(text).split(PHRASE_BREAK)) {
    let prevStem = null
    let prevWord = null
    let olderStem = null
    let olderWord = null
    for (const word of chunk.split(WORD_SPLIT)) {
      if (!word) continue
      if (word.length < 2 || stop.has(word) || /^\d+$/.test(word)) { prevStem = null; olderStem = null; continue }
      const s = stemOf(word)
      cb(s, word)
      if (prevStem) cb(prevStem + ' ' + s, prevWord + ' ' + word)
      if (withTriples && olderStem && prevStem) cb(olderStem + ' ' + prevStem + ' ' + s, olderWord + ' ' + prevWord + ' ' + word)
      olderStem = prevStem
      olderWord = prevWord
      prevStem = s
      prevWord = word
    }
  }
}

// ---------- inverted index ----------
const IN_TITLE = 1
const IN_TOPIC = 2
const IN_PARENT = 4
const IN_KEYWORDS = 8
// Indexed by the field bitmask of a posting: the weight of its strongest field
// (title 1, topic 0.75, keywords 0.6, session title 0.4).
export const FIELD_WEIGHTS = new Float32Array([0, 1, 0.75, 1, 0.4, 1, 0.75, 1, 0.6, 1, 0.75, 1, 0.6, 1, 0.75, 1])
// Items with content of their own: not filler (hidden tracks), not a session that holds others.
export const isDocument = e => !HIDDEN_TRACKS.has(e.track) && !isGroupEvent(e) && !CONTAINER_KINDS.has(e.kind)

export let termIndex = null

export function ensureTermIndex () {
  if (termIndex) return termIndex
  const started = performance.now()
  const post = new Map()
  const docs = []
  const tokensOf = memoizeByText(text => { const list = []; eachTerm(text, t => list.push(t)); return list })
  for (const e of EVENTS) {
    if (!isDocument(e)) continue
    docs.push(e.idx)
    const fields = new Map()
    const tag = bit => t => fields.set(t, (fields.get(t) || 0) | bit)
    eachTerm(e.title, tag(IN_TITLE))
    if (e.topic) tokensOf(e.topic).forEach(tag(IN_TOPIC))
    // Generic session titles ("Poster Session 3") say nothing about content.
    if (e.parentTitle && !(GENERIC_SESSION_TITLE && GENERIC_SESSION_TITLE.test(e.parentTitle))) tokensOf(e.parentTitle).forEach(tag(IN_PARENT))
    if (e.keywords) eachTerm(e.keywords, tag(IN_KEYWORDS))
    for (const [t, mask] of fields) {
      const list = post.get(t)
      if (list) list.push(e.idx * 16 + mask)
      else post.set(t, [e.idx * 16 + mask])
    }
  }
  termIndex = { post, docs, n: docs.length, lnN: Math.log(docs.length), ms: Math.round(performance.now() - started) }
  return termIndex
}

export function docFrequency (t) {
  const list = termIndex.post.get(t)
  return list ? list.length : 0
}

// Inverse document frequency scaled to 0..1 (1 = the term occurs in a single document).
export function idf (t) {
  const d = docFrequency(t)
  return d ? Math.log(termIndex.n / d) / termIndex.lnN : 0
}

// ---------- typo tolerance: character trigrams ----------
export function trigramSet (s) {
  const padded = `  ${s} `
  const out = new Set()
  for (let k = 0; k + 3 <= padded.length; k++) out.add(padded.slice(k, k + 3))
  return out
}

export function diceOverlap (a, b) {
  let shared = 0
  for (const g of a) if (b.has(g)) shared++
  return (2 * shared) / (a.size + b.size || 1)
}

let termsByTrigram = null
function trigramLookup () {
  if (!termsByTrigram) {
    termsByTrigram = new Map()
    for (const t of termIndex.post.keys()) {
      if (t.includes(' ') || t.length < 3) continue
      for (const g of trigramSet(t)) {
        const list = termsByTrigram.get(g)
        if (list) list.push(t)
        else termsByTrigram.set(g, [t])
      }
    }
  }
  return termsByTrigram
}

// The indexed single-word term closest to tok: { tok, sim } (sim 1 when indexed as is), or null.
export function closestIndexedTerm (tok) {
  if (termIndex.post.has(tok)) return { tok, sim: 1 }
  if (tok.length < 4 || tok.includes(' ')) return null
  const lookup = trigramLookup()
  const own = trigramSet(tok)
  const shared = new Map()
  for (const g of own) for (const t of lookup.get(g) || []) shared.set(t, (shared.get(t) || 0) + 1)
  let best = null
  for (const [t, hits] of shared) {
    if (hits < 2 || Math.abs(t.length - tok.length) > 3) continue
    const sim = (2 * hits) / (own.size + trigramSet(t).size)
    if (sim < 0.62) continue
    if (!best || sim > best.sim || (sim === best.sim && docFrequency(t) > docFrequency(best.tok))) best = { tok: t, sim }
  }
  return best
}

// ---------- autocomplete vocabulary: topics, then frequent title phrases ----------
export const mostFrequentKey = counts => {
  let top = null
  let topCount = -Infinity
  for (const [key, c] of counts) if (c > topCount) { top = key; topCount = c }
  return top
}

let autocompleteItems = null

function topicEntries () {
  const byName = new Map()
  for (const e of EVENTS) {
    if (!e.topic || !isDocument(e)) continue
    for (const part of e.topic.split(' › ')) {
      if (part === 'Everything Else') continue
      const entry = byName.get(part) || { label: part, kind: 'topic', n: 0 }
      entry.n++
      byName.set(part, entry)
    }
  }
  return [...byName.values()]
}

// Two-word phrases in at least 8 documents, three-word phrases in at least 6 titles; the label
// is the most common surface form.
function phraseEntries () {
  const forms = new Map()
  const tripleDocs = new Map()
  for (const i of termIndex.docs) {
    const counted = new Set()
    eachTerm(EVENTS[i].title, (t, surface) => {
      const size = t.split(' ').length
      if (size === 1 || (size === 2 && docFrequency(t) < 8)) return
      if (size === 3) {
        if (counted.has(t)) return
        counted.add(t)
        tripleDocs.set(t, (tripleDocs.get(t) || 0) + 1)
      }
      let seen = forms.get(t)
      if (!seen) { seen = new Map(); forms.set(t, seen) }
      seen.set(surface, (seen.get(surface) || 0) + 1)
    }, STOPWORDS, true)
  }
  const entries = []
  for (const [t, seen] of forms) {
    const triple = t.split(' ').length === 3
    const n = triple ? tripleDocs.get(t) || 0 : docFrequency(t)
    if (!triple || n >= 6) entries.push({ t, label: mostFrequentKey(seen), kind: 'phrase', n })
  }
  return entries.sort((a, b) => b.n - a.n).slice(0, 900)
}

export function prepareAutocomplete () {
  if (autocompleteItems) return autocompleteItems
  ensureTermIndex()
  const labels = new Set()
  autocompleteItems = []
  for (const item of [...topicEntries(), ...phraseEntries()]) {
    const folded = normalize(item.label)
    if (labels.has(folded)) continue
    labels.add(folded)
    const words = folded.split(WORD_SPLIT).filter(Boolean).map(w => ({ w, grams: trigramSet(w) }))
    autocompleteItems.push({ ...item, folded, grams: trigramSet(folded), words })
  }
  return autocompleteItems
}
