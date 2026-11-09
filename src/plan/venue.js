// Walking-time estimates from the venue model in the config (VENUE): a room maps to a zone (building,
// level, name) by the first zone pattern that matches its name; minutes follow from the zones. Rooms
// that match no pattern, and every room when there is no model, have no estimate. All times are
// estimates and are labelled as such.
import { h } from '../lib/dom.js'
import { normalize } from '../lib/text.js'
import { dayOf } from '../lib/time.js'
import { eventsById } from '../data/catalog.js'
import { VENUE } from '../data/conference.js'
import { starredIds, visitStart, visitEnd } from './clashes.js'

// Patterns are case-insensitive; "$1" in a level or zone name stands for the first capture group.
const ZONE_RULES = VENUE ? VENUE.zones.map(rule => ({ ...rule, pattern: new RegExp(rule.pattern, 'i') })) : []

const roomZoneMemo = new Map()
function venueZoneOf (room) {
  if (!room) return null
  if (roomZoneMemo.has(room)) return roomZoneMemo.get(room)
  const name = room.trim()
  let zone = null
  for (const rule of ZONE_RULES) {
    const match = rule.pattern.exec(name)
    if (!match) continue
    const fill = text => text.replace(/\$1/g, match[1] || '')
    zone = { building: rule.building, level: typeof rule.level === 'string' ? Number(fill(rule.level)) : rule.level, zone: fill(rule.zone) }
    break
  }
  roomZoneMemo.set(room, zone)
  return zone
}

// A level of null is unknown, so a move within the building counts a partial level change.
function estimateWalkMinutes (fromRoom, toRoom) {
  if (normalize(fromRoom) === normalize(toRoom)) return 0
  const a = venueZoneOf(fromRoom)
  const b = venueZoneOf(toRoom)
  if (!a || !b) return null
  if (a.building === b.building && a.zone === b.zone) return VENUE.sameZoneMinutes
  if (a.building === b.building) {
    const levels = a.level == null || b.level == null ? VENUE.unknownLevelChange : Math.abs(a.level - b.level)
    return Math.round(VENUE.sameBuildingBaseMinutes + VENUE.minutesPerLevel * levels)
  }
  // Crossing buildings happens on the ground level: anything above it (or unknown) adds stairs.
  const between = VENUE.walkMinutes[[a.building, b.building].sort().join('|')]
  if (between == null) return null
  const climb = z => (z.level == null || z.level > 0 ? VENUE.upstairsMinutes : 0)
  return Math.round(between + climb(a) + climb(b))
}

// Estimated minutes between two rooms, or null when either is unknown (other sites, free text) or
// the venue has no model.
const walkMinutesMemo = new Map()
export function walkingMinutes (fromRoom, toRoom) {
  if (!VENUE || !fromRoom || !toRoom) return null
  const key = fromRoom + '|' + toRoom
  if (!walkMinutesMemo.has(key)) walkMinutesMemo.set(key, estimateWalkMinutes(fromRoom, toRoom))
  return walkMinutesMemo.get(key)
}

// The plan item (starred or personal) that ends last before e starts, on the same day.
function previousPlanItem (e) {
  if (!e || !e.start) return null
  const day = dayOf(e.start)
  let best = null
  for (const id of starredIds()) {
    const x = eventsById.get(id)
    if (!x || x === e || !x.start || dayOf(x.start) !== day || visitEnd(x) > visitStart(e)) continue
    if (!best || visitEnd(x) > visitEnd(best)) best = x
  }
  return best
}

// "≈8 min walk from …" under an item, flagged when the gap is shorter than the walk.
export function walkNote (e, prev = previousPlanItem(e)) {
  if (!prev) return null
  const minutes = walkingMinutes(prev.room, e.room)
  if (minutes === null || minutes === 0) return null
  const gap = Math.round((visitStart(e) - visitEnd(prev)) / 60)
  const tight = gap < minutes
  const from = prev.title.length > 48 ? prev.title.slice(0, 46) + '…' : prev.title
  return h('p', { class: tight ? 'walk-note is-warn' : 'walk-note', title: 'Estimated from an approximate venue model' },
    `≈${minutes} min walk from “${from}” (estimate)`, tight ? `, only ${Math.max(0, gap)} min between` : '')
}
