// Durability behind the store: IndexedDB as the primary copy of the user data (localStorage is
// the fast mirror read at boot), automatic snapshots, persistent-storage requests and backup files.
import { CONFERENCE_ID, STORAGE_NAMESPACE } from '../data/conference.js'
import { notify, saveFile } from '../lib/dom.js'
import { exportData, exportPrefs, hasUserData, loadData, local, prefs, save } from './store.js'
import { renderAccountState, renderAll } from '../ui/shell.js'

export const storageStatus = { db: null, ready: false, error: '', persisted: 'unknown', usage: null }
const describeError = err => String((err && err.message) || err)
const DATA_RECORD_KEY = 'data'

// ---------- IndexedDB ----------
function openDatabase () {
  if (storageStatus.db) return Promise.resolve(storageStatus.db)
  return new Promise((resolve, reject) => {
    let request
    try { request = indexedDB.open(STORAGE_NAMESPACE.replace(/:$/, ''), 1) } catch (err) { reject(err); return }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv')
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true })
    }
    // "blocked" only means another tab still holds an old connection: give it a moment first.
    const giveUp = setTimeout(() => reject(new Error('IndexedDB blocked by another tab')), 4000)
    request.onsuccess = () => {
      clearTimeout(giveUp)
      const db = request.result
      db.onversionchange = () => {
        db.close()
        storageStatus.db = null
        storageStatus.ready = false
      }
      storageStatus.db = db
      storageStatus.ready = true
      resolve(db)
    }
    request.onerror = () => {
      clearTimeout(giveUp)
      reject(request.error || new Error('IndexedDB unavailable'))
    }
  })
}

// Runs one request in its own transaction; resolves with its result once the transaction commits.
function withStore (name, mode, makeRequest) {
  return openDatabase().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode)
    const request = makeRequest(tx.objectStore(name))
    tx.oncomplete = () => resolve(request && 'result' in request ? request.result : undefined)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  }))
}

export const dbGet = (store, key) => withStore(store, 'readonly', s => s.get(key))
export const dbPut = (store, value, key) => withStore(store, 'readwrite', s => (key === undefined ? s.put(value) : s.put(value, key)))
const dbAll = store => withStore(store, 'readonly', s => s.getAll())
const dbDelete = (store, key) => withStore(store, 'readwrite', s => s.delete(key))

// Writes are debounced; main.js flushes on pagehide and when the page is hidden.
let pendingRecord = null
let pendingTimer
export function scheduleDatabaseWrite (updatedAt, copy) {
  pendingRecord = { updatedAt, data: copy }
  clearTimeout(pendingTimer)
  pendingTimer = setTimeout(flushPendingWrite, 120)
}

export function flushPendingWrite () {
  clearTimeout(pendingTimer)
  if (!pendingRecord) return Promise.resolve()
  const record = pendingRecord
  pendingRecord = null
  return dbPut('kv', record, DATA_RECORD_KEY).catch(err => { storageStatus.error = describeError(err) })
}

// After boot: whichever copy (IndexedDB or localStorage) is newer wins, and the other is brought
// up to date. Resolves true when the in-memory data was replaced from IndexedDB.
export async function restoreFromDatabase () {
  try { await openDatabase() } catch (err) {
    storageStatus.error = describeError(err)
    return false
  }
  let restored = false
  try {
    const record = await dbGet('kv', DATA_RECORD_KEY)
    const localAt = local.get('updatedAt', 0)
    if (record && record.data && record.updatedAt > localAt) {
      loadData(record.data)
      save(true)
      restored = true
    } else if (localAt || hasUserData()) {
      await dbPut('kv', { updatedAt: localAt || Date.now(), data: exportData() }, DATA_RECORD_KEY)
    }
    await takeSnapshot('daily', { onlyIfNoneToday: true })
  } catch (err) { storageStatus.error = describeError(err) }
  return restored
}

// ---------- snapshots: the last 20, plus the newest of every day ----------
const isoToday = () => new Date().toISOString().slice(0, 10)

export const dataCounts = d => ({
  personal: (d.personal || []).length,
  starred: (d.starred || []).length,
  interests: (d.interests || []).length,
  people: (d.people || []).length,
  notes: (d.people || []).reduce((n, p) => n + (p.notes || []).length, 0),
})

async function pruneSnapshots () {
  const newestFirst = (await dbAll('snapshots')).sort((a, b) => b.at - a.at)
  const keep = new Set(newestFirst.slice(0, 20).map(s => s.id))
  const daysKept = new Set()
  for (const s of newestFirst) {
    if (daysKept.has(s.day)) continue
    daysKept.add(s.day)
    keep.add(s.id)
  }
  for (const s of newestFirst) if (!keep.has(s.id)) await dbDelete('snapshots', s.id)
}

export async function takeSnapshot (reason, opts = {}) {
  if (!storageStatus.ready || !hasUserData()) return null
  try {
    if (opts.onlyIfNoneToday && (await dbAll('snapshots')).some(s => s.day === isoToday())) return null
    const copy = exportData()
    const id = await dbPut('snapshots', { at: Date.now(), day: isoToday(), reason, data: copy, counts: dataCounts(copy) })
    await pruneSnapshots()
    return id
  } catch (err) {
    storageStatus.error = describeError(err)
    return null
  }
}

export async function listSnapshots () {
  if (!storageStatus.ready) return []
  try { return (await dbAll('snapshots')).sort((a, b) => b.at - a.at) } catch (err) { return [] }
}

// Replace the user data with a safety net: a snapshot first, and an in-memory copy for Undo.
export async function replaceDataWithUndo (next, label) {
  const before = exportData()
  await takeSnapshot('before ' + label)
  loadData(next)
  save()
  renderAll()
  notify(label, {
    action: 'Undo',
    run: () => {
      loadData(before)
      save()
      renderAll()
      notify('Undone')
    },
  })
}

// ---------- persistent storage ----------
export async function askPersistentStorage () {
  if (!navigator.storage || !navigator.storage.persist) {
    storageStatus.persisted = 'unsupported'
    return storageStatus.persisted
  }
  try {
    const granted = (await navigator.storage.persisted()) || (await navigator.storage.persist())
    storageStatus.persisted = granted ? 'granted' : 'not granted'
  } catch (err) { storageStatus.persisted = 'unsupported' }
  return storageStatus.persisted
}

export async function storageReport () {
  if (navigator.storage && navigator.storage.persisted) {
    try { storageStatus.persisted = (await navigator.storage.persisted()) ? 'granted' : 'not granted' } catch (err) {}
  }
  if (navigator.storage && navigator.storage.estimate) {
    try { storageStatus.usage = await navigator.storage.estimate() } catch (err) {}
  }
  return storageStatus
}

// ---------- backup files ----------
export function buildBackup () {
  return { format: 'whichtalk-backup', version: 1, conference: CONFERENCE_ID, exportedAt: new Date().toISOString(), data: exportData(), prefs: exportPrefs() }
}

export function downloadBackup () {
  saveFile(`whichtalk-${CONFERENCE_ID}-backup-${isoToday()}.json`, JSON.stringify(buildBackup(), null, 2), 'application/json')
  prefs.lastBackupAt = Date.now()
  save()
  notify('Backup downloaded')
  renderAccountState()
}

export const backupDue = () => hasUserData() && Date.now() - (prefs.lastBackupAt || 0) > 3 * 86400000

// The user data inside a backup file (or a whichtalk sync payload); anything else is rejected.
export function readBackup (obj) {
  const ours = obj && typeof obj === 'object' && typeof obj.format === 'string' && obj.format.startsWith('whichtalk-')
  if (!ours || !obj.data || typeof obj.data !== 'object') throw new Error('Not a backup file')
  return obj.data
}
