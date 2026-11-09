// Overlaps between items in the plan (starred events and personal events).
// Intervals are strict: back-to-back items (one ends as the next starts) do not overlap. A poster
// never clashes with its own poster session, nor with another poster of the same session.
// A poster with a planned visit window (data.visitWindows, set by Plan my day) occupies only that
// window of its session.
import { data } from '../state/store.js'
import { eventsById } from '../data/catalog.js'
import { clock, dayOf } from '../lib/time.js'
import { inLocation } from './filters.js'
import { personalEvents } from './personal.js'

export const visitStart = e => (data.visitWindows[e.id] ? data.visitWindows[e.id][0] : e.start)
export const visitEnd = e => (data.visitWindows[e.id] ? data.visitWindows[e.id][1] : e.end)
export const visitRange = e => `${clock(visitStart(e))}–${clock(visitEnd(e))}`

export const isStarred = e => !!e && (!!e.personal || data.starred.has(e.id))
export const starredIds = () => [...data.starred, ...personalEvents().map(e => e.id)]

function sameSessionFamily (a, b) {
  return a.parentId === b.id || b.parentId === a.id || (!!a.parentId && a.parentId === b.parentId)
}

export function overlapping (a, b) {
  if (!a || !b || a === b || !a.start || !b.start) return false
  return visitStart(a) < visitEnd(b) && visitStart(b) < visitEnd(a) && !sameSessionFamily(a, b)
}

export function overlapMinutes (a, b) {
  return Math.round((Math.min(visitEnd(a), visitEnd(b)) - Math.max(visitStart(a), visitStart(b))) / 60)
}

// id -> [{ id, min }] for every plan item that overlaps another, rebuilt lazily after changes.
let clashCache = null
export function invalidateClashes () { clashCache = null }

export function clashes () {
  if (clashCache) return clashCache
  const found = new Map()
  const note = (from, to, min) => {
    if (!found.has(from)) found.set(from, [])
    found.get(from).push({ id: to, min })
  }
  const timed = starredIds().map(id => eventsById.get(id)).filter(e => e && e.start)
    .sort((a, b) => visitStart(a) - visitStart(b))
  // Sorted by start, so the inner scan stops at the first item that starts after this one ends.
  timed.forEach((a, i) => {
    for (let j = i + 1; j < timed.length && visitStart(timed[j]) < visitEnd(a); j++) {
      const b = timed[j]
      if (!overlapping(a, b)) continue
      const min = overlapMinutes(a, b)
      note(a.id, b.id, min)
      note(b.id, a.id, min)
    }
  })
  clashCache = found
  return clashCache
}

// Each overlapping pair once, earlier item first, where at least one side passes the filter.
export function clashPairs (keep = () => true) {
  const pairs = []
  for (const [id, list] of clashes()) {
    for (const other of list) {
      if (id >= other.id) continue
      const a = eventsById.get(id)
      const b = eventsById.get(other.id)
      if (!keep(a) && !keep(b)) continue
      pairs.push(visitStart(a) <= visitStart(b) ? { a, b, min: other.min } : { a: b, b: a, min: other.min })
    }
  }
  return pairs.sort((x, y) => visitStart(x.a) - visitStart(y.a) || visitStart(x.b) - visitStart(y.b))
}

export function dayClashes (key) {
  const onDay = e => dayOf(e.start) === key
  return clashPairs(e => inLocation(e) && onDay(e)).filter(p => onDay(p.a) || onDay(p.b)).length
}

export function clashText (other, min) {
  const title = other.title.length > 70 ? other.title.slice(0, 68) + '…' : other.title
  return `Overlaps with “${title}” (${visitRange(other)}, ${min} min)`
}
