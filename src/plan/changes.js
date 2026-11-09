// What changed since the last visit. Each visit stores a compact fingerprint of the schedule (start,
// duration, room and a title hash per event, plus the starred ids) in IndexedDB. When a newer build
// is loaded the two are compared: changes to starred items (new time, new room, removed, newly
// scheduled) come first, then counts across the schedule. The first visit only stores.
//
// prefs.changeLog = { from, to, at, mine: [{ id, kinds, was, now }], global: { scheduled, removed,
// added, moved, rooms }, seen: [ids], dismissed? }
import { prefs, data, save } from '../state/store.js'
import { h } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { count, num } from '../lib/text.js'
import { dayOf, dayInfo, clock, timeAgo } from '../lib/time.js'
import { EVENTS, eventsById, kindName, catalogInfo } from '../data/catalog.js'
import { storageStatus, dbGet, dbPut } from '../state/persistence.js'
import { showEvent, hidePanel } from '../ui/overlay.js'

const FINGERPRINT_KEY = 'schedule-fingerprint'

// A stored log that lost its shape counts as no log.
function currentChangeLog () {
  const log = prefs.changeLog
  return log && Array.isArray(log.mine) && log.global && Array.isArray(log.seen) ? log : null
}

// 32-bit FNV-1a, enough to notice a retitled event.
function fingerprintHash (text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

const lengthInMinutes = e => (e.start ? Math.round((e.end - e.start) / 60) : 0)

function scheduleFingerprint () {
  const rooms = []
  const roomIndex = new Map()
  const indexOfRoom = room => {
    if (!roomIndex.has(room)) { roomIndex.set(room, rooms.length); rooms.push(room) }
    return roomIndex.get(room)
  }
  const fp = { at: catalogInfo.generatedAt, ids: [], starts: [], minutes: [], roomOf: [], titleHashes: [], kinds: [], rooms, starred: [...data.starred], titles: {} }
  for (const e of EVENTS) {
    fp.ids.push(e.id)
    fp.starts.push(e.start || 0)
    fp.minutes.push(lengthInMinutes(e))
    fp.roomOf.push(indexOfRoom(e.room || ''))
    fp.titleHashes.push(fingerprintHash(e.title))
    fp.kinds.push(e.kind)
  }
  for (const id of data.starred) {
    const e = eventsById.get(id)
    if (e) fp.titles[id] = e.title
  }
  return fp
}

function changeKindsFor (before, e, minutesBefore) {
  if (!e || e.personal) return ['removed']
  const kinds = []
  if (!before.start && e.start) kinds.push('scheduled')
  else if (before.start && !e.start) kinds.push('unscheduled')
  else if (before.start !== (e.start || 0) || minutesBefore !== lengthInMinutes(e)) kinds.push('time')
  if (before.room && e.room && e.room !== before.room) kinds.push('room')
  return kinds
}

function compareFingerprint (prev) {
  const indexById = new Map(prev.ids.map((id, i) => [id, i]))
  const starredBefore = new Set(prev.starred || [])
  const mine = []
  const global = { scheduled: {}, removed: 0, added: 0, moved: 0, rooms: 0 }
  for (const [id, i] of indexById) {
    const e = eventsById.get(id)
    const was = { start: prev.starts[i], end: prev.starts[i] + prev.minutes[i] * 60, room: prev.rooms[prev.roomOf[i]], title: (prev.titles || {})[id] || '' }
    const kinds = changeKindsFor(was, e, prev.minutes[i])
    if (!kinds.length) continue
    if (kinds.includes('removed')) global.removed++
    if (kinds.includes('scheduled')) { const label = kindName(e); global.scheduled[label] = (global.scheduled[label] || 0) + 1 }
    if (kinds.includes('time')) global.moved++
    if (kinds.includes('room')) global.rooms++
    if (starredBefore.has(id) || data.starred.has(id)) {
      mine.push({ id, kinds, was, now: e ? { start: e.start, end: e.end, room: e.room, title: e.title } : null })
    }
  }
  for (const e of EVENTS) if (!indexById.has(e.id)) global.added++
  return { from: prev.at, to: catalogInfo.generatedAt, at: Date.now(), mine, global, seen: [] }
}

const changeLogWorthShowing = log => log.mine.length > 0 || Object.keys(log.global.scheduled).length > 0 ||
  log.global.removed > 0 || log.global.moved > 0 || log.global.rooms > 0

// Runs once per load, after boot, off the critical path. Best effort.
export async function detectChanges () {
  if (!storageStatus.ready) return
  try {
    const prev = await dbGet('kv', FINGERPRINT_KEY)
    if (prev && prev.at !== catalogInfo.generatedAt && Array.isArray(prev.ids)) {
      const log = compareFingerprint(prev)
      if (changeLogWorthShowing(log)) { prefs.changeLog = log; save() }
    }
    await dbPut('kv', scheduleFingerprint(), FINGERPRINT_KEY)
  } catch (err) { /* change detection never blocks the app */ }
}

export function changedEventIds () {
  const log = currentChangeLog()
  if (!log) return new Set()
  return new Set(log.mine.filter(c => !log.seen.includes(c.id)).map(c => c.id))
}

export function markChangesSeen (ids) {
  const log = currentChangeLog()
  if (!log) return
  const fresh = ids.filter(id => !log.seen.includes(id))
  if (!fresh.length) return
  log.seen.push(...fresh)
  save()
}

const slotsAssignedText = (kind, n) => `${num(n)} ${n === 1 ? kind.toLowerCase() : kind.toLowerCase() + 's'} got time slots`

// One line for Today, or null when there is nothing (left) to say.
export function changeSummary () {
  const log = currentChangeLog()
  if (!log || log.dismissed) return null
  const parts = []
  if (log.mine.length) parts.push(`${count(log.mine.length, 'change')} in your plan`)
  const busiest = Object.entries(log.global.scheduled).sort((a, b) => b[1] - a[1]).slice(0, 2)
  for (const [kind, n] of busiest) parts.push(slotsAssignedText(kind, n))
  if (!log.mine.length && log.global.moved) parts.push(`${num(log.global.moved)} moved`)
  return parts.length ? `Since your last visit: ${parts.join(', ')}` : null
}

const changeSlotText = x => (x && x.start ? `${dayInfo(dayOf(x.start)).weekday} ${clock(x.start)}–${clock(x.end)}` : 'no time yet')

function describePlanChange (c) {
  const lines = []
  if (c.kinds.includes('removed')) lines.push('Removed from the schedule')
  if (c.kinds.includes('scheduled')) lines.push(`Now scheduled: ${changeSlotText(c.now)}`)
  if (c.kinds.includes('unscheduled')) lines.push('Time withdrawn')
  if (c.kinds.includes('time')) lines.push(`Moved from ${changeSlotText(c.was)} to ${changeSlotText(c.now)}`)
  if (c.kinds.includes('room')) lines.push(`Room: ${c.was.room} to ${c.now.room}`)
  return lines.join('. ')
}

function planChangeRow (c) {
  const e = eventsById.get(c.id)
  const body = h('div', { class: 'item-body' },
    h('div', { class: 'item-title' }, (e && e.title) || c.was.title || 'An item you had saved'),
    h('div', { class: 'item-meta text-clash' }, describePlanChange(c)))
  if (!e) return h('div', { class: 'item' }, body)
  return h('button', { class: 'item item-link', onclick: () => showEvent(c.id) }, body, h('span', { class: 'item-chevron' }, icon('chev')))
}

// Overlay body for 'changes'. Opening it marks every listed plan change as seen.
export function changesPanel () {
  const log = currentChangeLog()
  if (!log) return [h('p', { class: 'section-note' }, 'No changes since your last visit.')]
  const g = log.global
  const across = [
    ...Object.entries(g.scheduled).map(([kind, n]) => slotsAssignedText(kind, n)),
    g.moved && `${num(g.moved)} moved to another time`,
    g.rooms && `${num(g.rooms)} changed room`,
    g.removed && `${num(g.removed)} removed`,
    g.added && `${num(g.added)} added`,
  ].filter(Boolean)
  const out = [h('p', { class: 'section-note' }, `Compared with the schedule you last saw (synced ${timeAgo(Date.parse(log.from))}).`)]
  if (log.mine.length) {
    out.push(h('div', { class: 'overlay-section' }, h('h3', {}, 'Your plan'), h('div', { class: 'panel' }, log.mine.map(planChangeRow))))
  }
  if (across.length) {
    out.push(h('div', { class: 'overlay-section' }, h('h3', {}, 'Across the schedule'), h('ul', { class: 'bullets' }, across.map(line => h('li', {}, line)))))
  }
  out.push(h('div', { class: 'actions' }, h('button', {
    class: 'button',
    onclick: () => { log.dismissed = true; save(); hidePanel() },
  }, 'Hide this summary')))
  markChangesSeen(log.mine.map(c => c.id))
  return out
}
