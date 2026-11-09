// What the lists show: the search query, the Schedule filters (tracks, location, finished items,
// suggestions only, interest focus) and small per-location caches over the catalog.
import { prefs, data, ui } from '../state/store.js'
import { normalize } from '../lib/text.js'
import { dayOf, nowSec } from '../lib/time.js'
import { EVENTS, childrenByParent, isNested, isGroupEvent } from '../data/catalog.js'
import { DEFAULT_TRACKS, ALL_LOCATION, DAY_LABELS } from '../data/conference.js'
import { haystack, metaText, ensureHaystack } from '../search/index.js'
import { SCORES, MATCH_BITS, focusBit, isSuggested, resetHighlights } from '../search/relevance.js'

// Normalized words of the current query; every one must appear in an event's text.
export let activeTerms = []

export function setQuery (text) {
  ui.query = text
  activeTerms = normalize(text).split(/\s+/).filter(Boolean)
  if (activeTerms.length) ensureHaystack()
  resetHighlights()
}

function hasEveryQueryTerm (e) {
  const text = haystack[e.idx] || ''
  const meta = metaText[e.idx] || ''
  return activeTerms.every(word => text.includes(word) || meta.includes(word))
}

export function isFiltering () {
  return activeTerms.length > 0 || (prefs.onlyMatches && !!SCORES) || !!focusBit
}

export function passesFocus (e) {
  if (!focusBit) return true
  return !!MATCH_BITS && (MATCH_BITS[e.idx] & focusBit) !== 0 && data.votes[e.id] !== -1
}

export function matchesQuery (e) {
  if (activeTerms.length && !hasEveryQueryTerm(e)) return false
  if (prefs.onlyMatches && SCORES && !isSuggested(e)) return false
  return passesFocus(e)
}

// Personal events belong to whatever location is selected.
export const inLocation = e => !!e && (!!e.personal || prefs.location === ALL_LOCATION || e.location === prefs.location)
export const inTracks = e => prefs.tracks.has(e.track)
export const passesPast = e => !prefs.hidePast || !e.end || e.end > nowSec()

export function tracksAreDefault () {
  return prefs.tracks.size === DEFAULT_TRACKS.length && DEFAULT_TRACKS.every(key => prefs.tracks.has(key))
}

// Results that depend only on the catalog and the location, computed once per location.
const locationMemo = new Map()
export function memo (key, compute) {
  const slot = prefs.location + ':' + key
  if (!locationMemo.has(slot)) locationMemo.set(slot, compute())
  return locationMemo.get(slot)
}

export const topLevel = () => memo('top', () => EVENTS.filter(e => inLocation(e) && !isNested(e)))
export const locationDays = () => memo('days', () => [...new Set(topLevel().filter(e => e.start).map(e => dayOf(e.start)))].sort())
export const hasUnscheduled = () => memo('tba', () => topLevel().some(e => !e.start))
export const childrenHere = session => memo('kids' + session.id, () => (childrenByParent.get(session.id) || []).filter(inLocation))

// The day's character: the DAY_LABELS entry whose tracks weigh most that day, where a session with
// children (a poster session) weighs like three other items. Ties go to the earlier entry; null when
// no entry has items that day.
function dayLabelEntry (key) {
  return memo('label' + key, () => {
    const weights = DAY_LABELS.map(() => 0)
    for (const e of topLevel()) {
      if (!e.start || dayOf(e.start) !== key) continue
      DAY_LABELS.forEach((entry, i) => { if (entry.tracks.has(e.track)) weights[i] += isGroupEvent(e) ? 3 : 1 })
    }
    let best = null
    let most = 0
    DAY_LABELS.forEach((entry, i) => { if (weights[i] > most) { most = weights[i]; best = entry } })
    return best
  })
}
export const dayShort = key => (dayLabelEntry(key) ? dayLabelEntry(key).label : '')
// Headings use the longer form.
export const dayTitle = key => (dayLabelEntry(key) ? dayLabelEntry(key).title : '')

// Each page render starts a new generation; filtered child lists are reused within one.
export let generation = 0
export function bumpGeneration () { generation++ }

const visibleChildMemo = new Map()
function visibleChildren (session) {
  const hit = visibleChildMemo.get(session.id)
  if (hit && hit.generation === generation) return hit.list
  let list = childrenHere(session).filter(inTracks)
  if (isFiltering()) list = list.filter(matchesQuery)
  visibleChildMemo.set(session.id, { generation, list })
  return list
}

// A poster session stays visible while any of its posters passes the filters.
export function visibleTopLevel (e) {
  if (!inTracks(e) || !passesPast(e)) return false
  if (!isGroupEvent(e)) return matchesQuery(e)
  if (!isFiltering()) return true
  return matchesQuery(e) || visibleChildren(e).length > 0
}
