// Interest scoring. Each interest compiles into a query over termIndex (stems, adjacent pairs,
// typo-tolerant variants, plus an exact-phrase regex for hand-typed interests); its hits add up
// per event, capped per interest. SCORES and MATCH_BITS (one bit per interest) feed suggestions,
// the "Matches ..." lines and the focus filter.
import { EVENTS, EVENT_COUNT, eventsById } from '../data/catalog.js'
import { escapeRegex, normalize } from '../lib/text.js'
import { data, prefs, save, ui } from '../state/store.js'
import { closestIndexedTerm, eachTerm, ensureHaystack, FIELD_WEIGHTS, haystack, idf, termIndex } from './index.js'
import { inLocation } from '../plan/filters.js'
import { handleScoresChanged } from '../ui/shell.js'

const PICK_THRESHOLD = 0.3

export let SCORES = null
export let MATCH_BITS = null
export let interestQueries = []
export let interestCount = []
export let focusBit = 0
let activeBits = 0
let scoreVersion = 0
let picksCache = { key: '', list: [] }
let highlightRegexCache = null

// Highlight regexes are cached per render pass by ui/components.js; scores and queries reset them.
export function highlightCache () {
  if (highlightRegexCache === null) highlightRegexCache = {}
  return highlightRegexCache
}
export function resetHighlights () { highlightRegexCache = null }

const postingsOf = tok => termIndex.post.get(tok) || []

function compileInterest (interest, slot) {
  const stems = []
  const surfaces = []
  eachTerm(interest.text, (t, w) => {
    if (t.includes(' ')) return
    stems.push(t)
    surfaces.push(w)
  })
  const fuzzy = []
  const unis = stems.map((tok, k) => {
    const near = closestIndexedTerm(tok)
    if (near && near.tok !== tok) fuzzy.push(`${surfaces[k]} read as ${near.tok}`)
    return near || { tok, sim: 0 }
  })
  // Pairs are rebuilt from the (possibly corrected) words, so "reinforcment lerning" still
  // matches the phrase "reinforcement learning".
  const grams = []
  for (let k = 0; k + 1 < unis.length; k++) {
    grams.push({ tok: unis[k].tok + ' ' + unis[k + 1].tok, sim: Math.min(unis[k].sim, unis[k + 1].sim) || 1 })
  }
  const typed = interest.source === 'manual' || interest.source === 'topic'
  const phrase = normalize(interest.text).trim()
  return {
    text: interest.text,
    weight: interest.weight,
    active: interest.active,
    bit: 1 << slot,
    unis,
    grams,
    fuzzy,
    rx: typed && phrase ? new RegExp('\\b' + escapeRegex(phrase).replace(/\s+/g, '\\s+')) : null,
  }
}

// Raw per-event evidence for one query (before the per-interest cap).
function evidenceFor (q) {
  const sums = new Map()
  const add = (idx, v) => sums.set(idx, (sums.get(idx) || 0) + v)
  if (q.grams.length === 0 && q.unis.length === 1) {
    const u = q.unis[0]
    const rarity = idf(u.tok)
    for (const x of postingsOf(u.tok)) add(x >> 4, q.weight * u.sim * rarity * FIELD_WEIGHTS[x & 15])
  } else if (q.grams.length) {
    // Multi-word interests: documents must contain at least half of the pairs; coverage counts
    // superlinearly. Distinctive single words add a little on top.
    const pairs = q.grams.length
    const pairHits = new Map()
    for (const g of q.grams) {
      const rarity = Math.max(idf(g.tok), 0.35)
      for (const x of postingsOf(g.tok)) {
        const idx = x >> 4
        let hit = pairHits.get(idx)
        if (!hit) { hit = { n: 0, s: 0 }; pairHits.set(idx, hit) }
        hit.n++
        hit.s += rarity * FIELD_WEIGHTS[x & 15] * g.sim
      }
    }
    const needed = Math.ceil(pairs / 2)
    for (const [idx, hit] of pairHits) {
      if (hit.n >= needed) add(idx, q.weight * (hit.s / pairs) * Math.pow(hit.n / pairs, 1.5) * 1.15)
    }
    for (const u of q.unis) {
      const rarity = idf(u.tok)
      if (rarity < 0.45) continue
      for (const x of postingsOf(u.tok)) add(x >> 4, q.weight * 0.3 * rarity * FIELD_WEIGHTS[x & 15] * u.sim)
    }
  }
  if (q.rx) for (const idx of termIndex.docs) if (q.rx.test(haystack[idx])) add(idx, q.weight * 0.75)
  return sums
}

// Adds one query's capped contribution; returns how many events here it matches.
function applyQuery (q) {
  let here = 0
  for (const [idx, raw] of evidenceFor(q)) {
    const gain = Math.min(raw, q.weight * 1.2)
    SCORES[idx] += gain
    if (gain >= 0.12) {
      MATCH_BITS[idx] |= q.bit
      if (inLocation(EVENTS[idx])) here++
    }
  }
  return here
}

export function rescore () {
  highlightRegexCache = null
  activeBits = 0
  interestQueries = []
  interestCount = data.interests.map(() => 0)
  focusBit = 0
  scoreVersion++
  if (!data.interests.length || !termIndex) {
    SCORES = null
    MATCH_BITS = null
    return
  }
  ensureHaystack()
  interestQueries = data.interests.map(compileInterest)
  SCORES = new Float32Array(EVENT_COUNT)
  MATCH_BITS = new Uint32Array(EVENT_COUNT)
  interestQueries.forEach((q, slot) => {
    if (!q.active) return
    activeBits |= q.bit
    interestCount[slot] = applyQuery(q)
  })
  // A thumbs-down hides the event; a thumbs-up nudges it above the threshold.
  for (const id in data.votes) {
    const e = eventsById.get(Number(id))
    if (!e) continue
    if (data.votes[id] < 0) SCORES[e.idx] = 0
    else SCORES[e.idx] += 0.2
  }
  const focused = ui.focusInterest && interestQueries.find(q => q.active && normalize(q.text) === ui.focusInterest)
  focusBit = focused ? focused.bit : 0
  if (!focused) ui.focusInterest = null
  scoreVersion++
  handleScoresChanged()
}

export const isSuggested = e => !!SCORES && SCORES[e.idx] >= PICK_THRESHOLD && data.votes[e.id] !== -1

export function matchedInterests (e) {
  const bits = MATCH_BITS ? MATCH_BITS[e.idx] & activeBits : 0
  if (!bits) return []
  return interestQueries.filter(q => bits & q.bit).sort((a, b) => b.weight - a.weight).map(q => q.text)
}

export const matchStrength = e => (SCORES ? 1 - Math.exp(-SCORES[e.idx] * 1.4) : 0)

export function rankedPicks (accept = () => true) {
  if (!SCORES) return []
  const picks = []
  for (const idx of termIndex.docs) {
    const e = EVENTS[idx]
    if (SCORES[idx] >= PICK_THRESHOLD && data.votes[e.id] !== -1 && accept(e)) picks.push(e)
  }
  return picks.sort((a, b) => SCORES[b.idx] - SCORES[a.idx] || a.title.localeCompare(b.title))
}

// Every pick at the current location, cached until the scores or the location change.
export function allPicks () {
  if (!SCORES) return []
  const key = scoreVersion + ':' + prefs.location
  if (picksCache.key !== key) picksCache = { key, list: rankedPicks(inLocation) }
  return picksCache.list
}

// Thumbs up/down (v = 1 or -1; repeating a vote clears it) also moves the weight of every
// interest that explains the event by a quarter step.
export function vote (e, v) {
  const before = data.votes[e.id] || 0
  const next = before === v ? 0 : v
  const explaining = interestQueries.filter(q => MATCH_BITS && (MATCH_BITS[e.idx] & q.bit))
  for (const q of explaining) {
    const interest = data.interests.find(it => it.text === q.text)
    if (!interest) continue
    const step = (next - before) * 0.25
    interest.weight = Math.min(3, Math.max(0.25, Math.round((interest.weight + step) * 4) / 4))
  }
  if (next) data.votes[e.id] = next
  else delete data.votes[e.id]
  save()
  rescore()
  return { next, terms: explaining.map(q => q.text) }
}
