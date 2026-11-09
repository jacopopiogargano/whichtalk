// Every copy of user data that enters the app (localStorage at boot, IndexedDB, backup files, sync
// links, share links) passes through these cleaners: unknown fields go, lengths are capped, enums
// fall back to defaults, and ids that are not in this catalog are dropped.
import { eventsById } from '../data/catalog.js'
import { httpUrl, newId } from '../lib/text.js'

export const MAX_INTERESTS = 30
export const PERSONAL_KINDS = ['meeting', 'booth', 'meal', 'travel', 'other']
const CONTACT_FIELDS = ['email', 'phone', 'linkedin', 'web', 'other']
const PERSON_STATUSES = ['to-meet', 'met', 'skipped']

const listOrEmpty = value => (Array.isArray(value) ? value : [])
const cappedString = (value, max) => String(value || '').slice(0, max)
const clampTo = (value, lo, hi) => Math.min(hi, Math.max(lo, value))
const epochOr = (value, fallback) => Number(value) || fallback
const hasNonBlank = (obj, field) => !!obj && typeof obj[field] === 'string' && !!obj[field].trim()

export function sanitizeInterests (list) {
  return listOrEmpty(list).filter(it => hasNonBlank(it, 'text')).map(it => ({
    text: it.text.trim().slice(0, 80),
    weight: clampTo(Number(it.weight) || 1, 0.25, 3),
    active: it.active !== false,
    source: it.source || 'manual',
  })).slice(0, MAX_INTERESTS)
}

function sanitizeNote (note) {
  const contact = note.contact || {}
  return {
    id: String(note.id || newId()),
    at: epochOr(note.at, Date.now()),
    where: cappedString(note.where, 200),
    text: cappedString(note.text, 8000),
    todos: listOrEmpty(note.todos).map(todo => ({ text: cappedString(todo.text, 300), done: !!todo.done })).filter(todo => todo.text),
    tags: listOrEmpty(note.tags).map(String).slice(0, 12),
    contact: Object.fromEntries(CONTACT_FIELDS.map(field => [field, cappedString(contact[field], 200)])),
    updated: Number(note.updated) || Number(note.at) || Date.now(),
  }
}

export function sanitizePeople (list) {
  return listOrEmpty(list).filter(p => hasNonBlank(p, 'name')).map(p => ({
    id: String(p.id || newId()),
    name: p.name.trim().slice(0, 120),
    affiliation: cappedString(p.affiliation, 160),
    reason: cappedString(p.reason, 500),
    links: listOrEmpty(p.links).map(String).filter(httpUrl).slice(0, 6),
    priority: [1, 2, 3].includes(p.priority) ? p.priority : 2,
    status: PERSON_STATUSES.includes(p.status) ? p.status : 'to-meet',
    source: String(p.source || 'manual'),
    kind: p.kind === 'org' ? 'org' : 'person',
    created: epochOr(p.created, Date.now()),
    updated: epochOr(p.updated, Date.now()),
    notes: listOrEmpty(p.notes).map(sanitizeNote),
  }))
}

// Personal events: { id, title, day: 'YYYY-MM-DD', from, to (minutes after midnight, conference
// time), place, kind, notes, updated }. An event lasts at least five minutes and ends by midnight.
export function sanitizePersonal (list) {
  return listOrEmpty(list).filter(r => hasNonBlank(r, 'title') && /^\d{4}-\d{2}-\d{2}$/.test(r.day || '')).map(r => {
    const from = clampTo(Math.round(Number(r.from) || 0), 0, 1439)
    const to = Math.max(from + 5, Math.min(1440, Math.round(Number(r.to) || from + 60)))
    return {
      id: String(r.id || 'p' + newId()),
      title: r.title.trim().slice(0, 160),
      day: r.day,
      from,
      to,
      place: cappedString(r.place, 120),
      kind: PERSONAL_KINDS.includes(r.kind) ? r.kind : 'other',
      notes: cappedString(r.notes, 4000),
      updated: epochOr(r.updated, Date.now()),
    }
  }).slice(0, 300)
}

const isNumericKey = key => Number.isFinite(Number(key))

export function sanitizeIdMap (obj, accept) {
  if (!obj || typeof obj !== 'object') return {}
  return Object.fromEntries(Object.entries(obj).filter(([key, value]) => isNumericKey(key) && accept(value)))
}

// Teammates imported from share links: { id, name, starred: [ids], assignments: { id: name },
// busy: [[day, from, to]], active, addedAt }.
export function sanitizeTeam (list) {
  return listOrEmpty(list).filter(m => hasNonBlank(m, 'name')).map(m => ({
    id: String(m.id || newId()),
    name: m.name.trim().slice(0, 60),
    starred: listOrEmpty(m.starred).map(Number).filter(Number.isFinite).slice(0, 3000),
    assignments: m.assignments && typeof m.assignments === 'object'
      ? Object.fromEntries(Object.entries(m.assignments).filter(([key, value]) => isNumericKey(key) && typeof value === 'string').slice(0, 2000))
      : {},
    busy: listOrEmpty(m.busy).filter(b => Array.isArray(b) && b.length === 3).slice(0, 200),
    active: m.active !== false,
    addedAt: epochOr(m.addedAt, Date.now()),
  })).slice(0, 30)
}

export function sanitizeData (raw) {
  const d = raw || {}
  return {
    starred: listOrEmpty(d.starred).map(Number).filter(id => id > 0 && eventsById.has(id)),
    interests: sanitizeInterests(d.interests),
    votes: d.votes && typeof d.votes === 'object' ? d.votes : {},
    people: sanitizePeople(d.people),
    personal: sanitizePersonal(d.personal),
    readList: listOrEmpty(d.readList).map(Number).filter(id => eventsById.has(id)),
    team: sanitizeTeam(d.team),
    assignments: sanitizeIdMap(d.assignments, v => typeof v === 'string' && v.length < 61),
    visitWindows: sanitizeIdMap(d.visitWindows, v => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)),
  }
}
