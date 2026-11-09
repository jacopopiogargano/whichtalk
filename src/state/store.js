// Application state in three objects:
// - prefs: settings, one localStorage key each;
// - data: the user's own content (starred, interests, people, notes...), mirrored to IndexedDB,
//   snapshotted, backed up and synced as one unit;
// - ui: runtime only.
// localStorage is read synchronously here so the first render already shows the user's plan;
// IndexedDB is reconciled later (persistence.js).
import { DEFAULT_LOCATION, DEFAULT_TRACKS, LOCATIONS, STORAGE_NAMESPACE } from '../data/conference.js'
import { notify } from '../lib/dom.js'
import { sanitizeData } from './sanitize.js'
import { askPersistentStorage, scheduleDatabaseWrite, takeSnapshot } from './persistence.js'

export const local = {
  get (key, fallback) {
    try {
      const raw = localStorage.getItem(STORAGE_NAMESPACE + key)
      return raw === null ? fallback : JSON.parse(raw)
    } catch (err) { return fallback }
  },
  set (key, value) {
    try {
      localStorage.setItem(STORAGE_NAMESPACE + key, JSON.stringify(value))
      return true
    } catch (err) { return false }
  },
}

const PLANNER_DEFAULTS = { pace: 'normal', lunch: true, lunchFrom: 720, lunchTo: 810, keepStarred: true, walking: true }
const enumOr = (value, allowed) => (allowed.includes(value) ? value : allowed[0])

function readStoredPrefs () {
  const location = local.get('location', DEFAULT_LOCATION)
  const tracks = local.get('tracks', null)
  const reminder = local.get('reminderMinutes', 10)
  const changeLog = local.get('changeLog', null)
  return {
    location: LOCATIONS[location] ? location : DEFAULT_LOCATION,
    day: local.get('day', null),
    tracks: new Set(Array.isArray(tracks) ? tracks : DEFAULT_TRACKS),
    onlyMatches: local.get('onlyMatches', false),
    hidePast: local.get('hidePast', false),
    theme: local.get('theme', 'system'),
    scheduleLayout: enumOr(local.get('scheduleLayout', 'list'), ['list', 'rooms']),
    planSection: enumOr(local.get('planSection', 'sessions'), ['sessions', 'people', 'notes', 'team']),
    planLayout: enumOr(local.get('planLayout', 'list'), ['list', 'week']),
    picksLayout: enumOr(local.get('picksLayout', 'ranked'), ['ranked', 'by-day']),
    onboarded: local.get('onboarded', false),
    syncOrigin: local.get('syncOrigin', ''),
    lastBackupAt: local.get('lastBackupAt', 0),
    reminderMinutes: [0, 5, 10, 15].includes(reminder) ? reminder : 10,
    showPersonal: local.get('showPersonal', true),
    plannerOptions: { ...PLANNER_DEFAULTS, ...(local.get('plannerOptions', null) || {}) },
    displayName: String(local.get('displayName', '') || '').slice(0, 60),
    // Shape owned by plan/changes.js.
    changeLog: changeLog && typeof changeLog === 'object' && !Array.isArray(changeLog) ? changeLog : null,
  }
}

// Prefs written by save() and included in backups; changeLog is saved but stays out of backups.
const SAVED_PREF_KEYS = ['location', 'day', 'tracks', 'onlyMatches', 'hidePast', 'theme', 'scheduleLayout', 'planSection', 'planLayout',
  'picksLayout', 'onboarded', 'syncOrigin', 'lastBackupAt', 'reminderMinutes', 'showPersonal', 'plannerOptions', 'displayName']
const USER_DATA_KEYS = ['starred', 'interests', 'votes', 'people', 'personal', 'readList', 'team', 'assignments', 'visitWindows']

// Sets in memory, sorted id arrays on disk.
function withIdSets (clean) {
  return { ...clean, starred: new Set(clean.starred), readList: new Set(clean.readList) }
}

function readStoredData () {
  const stored = {}
  for (const key of USER_DATA_KEYS) stored[key] = local.get(key, undefined)
  return withIdSets(sanitizeData(stored))
}

export const prefs = readStoredPrefs()
export const data = readStoredData()
export const ui = {
  view: 'today',
  focusInterest: null, // folded interest text used as a quick filter (Schedule filter panel)
  query: '',
  searching: false,
  selection: null,
  history: [],
  panel: null,
  sharedPlan: null,
  showingShared: false,
  review: null,
  plannerDay: null,
  plannerDraft: null,
  importOpen: false,
}

const storedPrefValue = key => (key === 'tracks' ? [...prefs.tracks] : prefs[key])

export function exportPrefs () {
  return Object.fromEntries(SAVED_PREF_KEYS.map(key => [key, storedPrefValue(key)]))
}

const ascendingIds = set => [...set].sort((a, b) => a - b)

// A plain, JSON-safe deep copy of the user data (ids sorted, so equal data gives equal JSON).
export function exportData () {
  return JSON.parse(JSON.stringify({
    starred: ascendingIds(data.starred),
    interests: data.interests,
    votes: data.votes,
    people: data.people,
    personal: data.personal,
    readList: ascendingIds(data.readList),
    team: data.team,
    assignments: data.assignments,
    visitWindows: data.visitWindows,
  }))
}

const replacedHooks = []
export function onDataReplaced (fn) { replacedHooks.push(fn) }

// Swaps in another copy of the user data (restore, sync, undo). The data object keeps its
// identity; derived state is rebuilt by the registered hooks.
export function loadData (incoming) {
  Object.assign(data, withIdSets(sanitizeData(incoming)))
  for (const fn of replacedHooks) fn()
}

export const hasUserData = () => data.starred.size > 0 || data.people.length > 0 || data.interests.length > 0 || data.personal.length > 0

let savedDataJson = JSON.stringify(exportData())
let lastAutoSnapshotAt = 0
let persistenceAsked = false

// Writes prefs, and the user data when it changed (force: even when unchanged): localStorage at
// once, IndexedDB debounced, an automatic snapshot at most every ten minutes.
export function save (force = false) {
  for (const key of SAVED_PREF_KEYS) local.set(key, storedPrefValue(key))
  local.set('changeLog', prefs.changeLog)
  const json = JSON.stringify(exportData())
  if (json === savedDataJson && !force) return
  savedDataJson = json
  const copy = JSON.parse(json)
  const at = Date.now()
  const stored = USER_DATA_KEYS.every(key => local.set(key, copy[key])) && local.set('updatedAt', at)
  if (!stored) notify('Browser storage is full or blocked. Make a backup under You.')
  scheduleDatabaseWrite(at, copy)
  if (!persistenceAsked && hasUserData()) {
    persistenceAsked = true
    askPersistentStorage()
  }
  if (at - lastAutoSnapshotAt > 10 * 60 * 1000) {
    lastAutoSnapshotAt = at
    setTimeout(() => takeSnapshot('auto'), 0)
  }
}
