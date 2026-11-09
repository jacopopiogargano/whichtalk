// Personal events (meetings, booth duty, meals, travel). The records live in data.personal; each one
// becomes an event-like object with a negative id in eventsById, so it flows through Today, My plan,
// the week grid, overlaps, .ics, share and sync like a starred item. They never leave the device on
// their own.
import { prefs, data, ui, save } from '../state/store.js'
import { h, notify, saveFile } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { newId } from '../lib/text.js'
import { dayOf, dayInfo, timeRange, duration } from '../lib/time.js'
import { eventsById } from '../data/catalog.js'
import { LOCATIONS, TRACK_BY_KEY } from '../data/conference.js'
import { sanitizePersonal } from '../state/sanitize.js'
import { openDialog, closeDialog } from '../ui/dialog.js'
import { clashSection } from '../ui/overlay.js'
import { renderAll } from '../ui/shell.js'
import { dayStart } from '../views/today.js'
import { locationDays, memo, topLevel } from './filters.js'
import { invalidateClashes } from './clashes.js'
import { walkNote } from './venue.js'
import { buildIcs } from './calendar.js'

const PERSONAL_KIND_LABELS = { meeting: 'Meeting', booth: 'Booth or talk', meal: 'Meal', travel: 'Travel', other: 'Other' }
const PERSONAL_TRACK = { key: 'personal', label: 'My events', singular: 'Personal', rank: -1, kinds: [] }

const personalByRecord = new Map() // record id -> event object
const personalIdByRecord = new Map() // record id -> negative event id, stable for the session
let nextPersonalId = -1

export const personalEvents = () => [...personalByRecord.values()]

function personalEventFrom (record, id) {
  const label = PERSONAL_KIND_LABELS[record.kind]
  const start = dayStart(record.day) + record.from * 60
  return {
    idx: -1,
    id,
    localId: record.id,
    personal: true,
    kind: record.kind === 'other' ? 'Personal' : `Personal ${label.toLowerCase()}`,
    track: 'personal',
    personalKind: record.kind,
    personalKindLabel: label,
    title: record.title,
    authors: [],
    room: record.place,
    start,
    end: start + (record.to - record.from) * 60,
    location: prefs.location,
    parentId: 0,
    parentTitle: '',
    openreviewId: '',
    hasPoster: false,
    links: null,
    topic: '',
    institutions: null,
    keywords: '',
    hasAbstract: false,
    notes: record.notes,
  }
}

// Called after data.personal, the location or the zone offset changes.
export function rebuildPersonalEvents () {
  // Sort and rank lookups treat 'personal' like a track that sorts first.
  if (!TRACK_BY_KEY.personal) TRACK_BY_KEY.personal = PERSONAL_TRACK
  for (const e of personalByRecord.values()) eventsById.delete(e.id)
  personalByRecord.clear()
  for (const record of data.personal) {
    if (!personalIdByRecord.has(record.id)) personalIdByRecord.set(record.id, nextPersonalId--)
    const e = personalEventFrom(record, personalIdByRecord.get(record.id))
    eventsById.set(e.id, e)
    personalByRecord.set(record.id, e)
  }
  invalidateClashes()
}

const personalPad2 = n => String(n).padStart(2, '0')
export const hhmm = minutes => `${personalPad2(Math.floor(minutes / 60) % 24)}:${personalPad2(minutes % 60)}`
export function parseHhmm (text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text || '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN
}

const venueRoomNames = () => memo('rooms', () => [...new Set(topLevel().filter(e => e.room).map(e => e.room))].sort())

const copyPersonalRecords = () => JSON.parse(JSON.stringify(data.personal))

function commitPersonal (records) {
  data.personal = records
  rebuildPersonalEvents()
  save()
  renderAll()
}

const personalUndo = records => ({ action: 'Undo', run: () => commitPersonal(records) })

function deletePersonalRecord (recordId) {
  const before = copyPersonalRecords()
  const sel = ui.selection
  if (sel && sel.type === 'event') {
    const open = eventsById.get(sel.id)
    if (open && open.localId === recordId) { ui.selection = null; ui.history = [] }
  }
  commitPersonal(data.personal.filter(r => r.id !== recordId))
  notify('Event deleted', personalUndo(before))
}

// Create (record null) or edit. preset = { day, from, to } (minutes) prefills a new event, for
// example from a free gap on Today.
export function openPersonalForm (record = null, preset = {}) {
  const days = locationDays()
  const day = record ? record.day : preset.day || (days.includes(prefs.day) ? prefs.day : days[0])
  const from = record ? record.from : preset.from || 720
  const to = record ? record.to : preset.to || (preset.from || 720) + 60
  const kind = record ? record.kind : 'meeting'
  const input = {
    title: h('input', { value: record ? record.title : '', placeholder: 'Coffee with a co-author', maxlength: '160' }),
    day: h('select', {}, [...new Set([...days, day])].sort().map(k => h('option', { value: k, selected: k === day }, dayInfo(k).long))),
    from: h('input', { type: 'time', value: hhmm(from), step: '300' }),
    to: h('input', { type: 'time', value: hhmm(to), step: '300' }),
    place: h('input', { value: record ? record.place : '', placeholder: 'A room, or any place', list: 'room-options' }),
    kind: h('select', {}, Object.entries(PERSONAL_KIND_LABELS).map(([key, label]) => h('option', { value: key, selected: key === kind }, label))),
    notes: h('textarea', { placeholder: 'Notes' }),
  }
  input.notes.value = record ? record.notes : ''
  const problem = h('p', { class: 'status-line is-error', 'aria-live': 'polite' })

  const submit = () => {
    const start = parseHhmm(input.from.value)
    const end = parseHhmm(input.to.value)
    if (!input.title.value.trim()) { problem.textContent = 'Add a title.'; input.title.focus(); return }
    if (!(end > start)) { problem.textContent = 'The end time must be after the start.'; input.to.focus(); return }
    const before = copyPersonalRecords()
    const next = {
      id: record ? record.id : 'p' + newId(),
      title: input.title.value,
      day: input.day.value,
      from: start,
      to: end,
      place: input.place.value.trim(),
      kind: input.kind.value,
      notes: input.notes.value,
      updated: Date.now(),
    }
    const records = record ? data.personal.map(r => (r.id === record.id ? next : r)) : [...data.personal, next]
    closeDialog()
    commitPersonal(sanitizePersonal(records))
    notify(record ? 'Event updated' : 'Event added to My plan', personalUndo(before))
  }

  const field = (label, control, wide) => h('label', { class: wide ? 'form-field is-full' : 'form-field' }, label, control)
  const body = h('div', { class: 'form-grid' },
    field('Title', input.title, true),
    field('Day', input.day),
    field('Category', input.kind),
    field('Starts', input.from),
    field('Ends', input.to),
    field('Place', [input.place, h('datalist', { id: 'room-options' }, venueRoomNames().map(room => h('option', { value: room })))], true),
    field('Notes', input.notes, true),
    h('div', { class: 'is-full' }, problem))
  const actions = [
    record ? h('button', { class: 'button is-danger', onclick: () => { closeDialog(); deletePersonalRecord(record.id) } }, 'Delete') : null,
    h('span', { class: 'fill' }),
    h('button', { class: 'button', onclick: closeDialog }, 'Cancel'),
    h('button', { class: 'button is-primary', onclick: submit }, record ? 'Save' : 'Add event'),
  ]
  openDialog(record ? 'Edit event' : 'New event', body, actions)
}

// Detail overlay body for a personal event.
export function personalDetailView (e) {
  const record = data.personal.find(r => r.id === e.localId)
  const facts = h('div', { class: 'detail-facts' },
    icon('clock'), h('div', {}, dayInfo(dayOf(e.start)).long, h('br'), `${timeRange(e)} ${LOCATIONS[prefs.location].zone}, ${duration(e)}`),
    e.room ? [icon('pin'), h('div', {}, e.room)] : null,
    icon('tag'), h('div', {}, `Personal, ${e.personalKindLabel.toLowerCase()}`))
  const actions = h('div', { class: 'link-list' },
    h('button', { class: 'button is-primary', onclick: () => openPersonalForm(record) }, icon('pen'), 'Edit'),
    h('button', { class: 'button', onclick: () => saveFile(`personal-${e.localId}.ics`, buildIcs([e]), 'text/calendar') }, icon('cal'), 'Add to calendar'),
    h('button', { class: 'button is-danger', onclick: () => deletePersonalRecord(e.localId) }, icon('trash'), 'Delete'))
  return h('div', { class: 'detail' },
    h('h2', {}, e.title),
    facts,
    walkNote(e),
    h('div', { class: 'detail-section', id: 'detail-clashes' }, clashSection(e)),
    e.notes ? h('div', { class: 'detail-section' }, h('h4', {}, 'Notes'), h('p', { class: 'personal-notes' }, e.notes)) : null,
    h('div', { class: 'detail-section' }, actions),
    h('p', { class: 'section-note' }, 'Only on this device. Included in backups, sync and your share link.'))
}
