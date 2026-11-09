// The You panel: interests and imports, conference site (when there is a choice) and appearance, sync
// and backup, storage status, snapshots, device notes and About. Also restoring from a backup file.
// Everything here is stored on this device only.
import { h, qs, notify } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { timeAgo, stamp } from '../lib/time.js'
import { count } from '../lib/text.js'
import { catalogInfo } from '../data/catalog.js'
import { LOCATIONS, DEFAULT_LOCATION, ALL_LOCATION, HAS_LOCATION_CHOICE, ORGANIZER, SOURCE_NAME, OFFICIAL_SCHEDULE_URL } from '../data/conference.js'
import { prefs, exportData, save } from '../state/store.js'
import { sanitizeData } from '../state/sanitize.js'
import {
  storageStatus, storageReport, listSnapshots, dataCounts, replaceDataWithUndo, downloadBackup, backupDue,
  askPersistentStorage, readBackup,
} from '../state/persistence.js'
import { openDialog, closeDialog } from '../ui/dialog.js'
import { hidePanel, renderOverlay } from '../ui/overlay.js'
import { chooseLocation, applyTheme } from '../ui/shell.js'
import { interestSections } from './profile.js'
import { openSyncPanel, mergeUserData, diffStat } from './sync.js'

const REMINDER_CHOICES = [[0, 'Off'], [5, '5 min'], [10, '10 min'], [15, '15 min']]
const THEME_CHOICES = ['system', 'light', 'dark']

const contentsLine = c => `${count(c.starred, 'saved item')}, ${count(c.interests, 'interest')}, ${count(c.people, 'person', 'people')}, ${count(c.notes, 'note')}`

export async function importBackupFile (file) {
  try {
    const parsed = JSON.parse(await file.text())
    const theirs = sanitizeData(readBackup(parsed))
    const mine = exportData()
    const incoming = dataCounts(theirs)
    const restore = (next, label) => async () => {
      closeDialog()
      await replaceDataWithUndo(next(), label)
    }
    openDialog('Restore from a backup file',
      h('div', {},
        h('p', { class: 'helper' }, `${file.name}${parsed.exportedAt ? ', exported ' + timeAgo(Date.parse(parsed.exportedAt)) : ''}`),
        h('div', { class: 'diff-grid' },
          diffStat(incoming.starred, 'saved items'), diffStat(incoming.interests, 'interests'),
          diffStat(incoming.people, 'people'), diffStat(incoming.notes, 'notes'))),
      [
        h('button', { class: 'button', onclick: () => closeDialog() }, 'Cancel'),
        h('button', { class: 'button', onclick: restore(() => mergeUserData(mine, theirs), 'Merged the backup into this device') }, 'Merge'),
        h('button', { class: 'button is-primary', onclick: restore(() => theirs, 'Restored the backup') }, 'Replace'),
      ])
  } catch (err) {
    notify('Couldn’t read that file: ' + err.message)
  }
}

async function restoreSnapshot (snapshot) {
  if (!confirm(`Restore the snapshot from ${stamp(snapshot.at)}? This device’s current data is snapshotted first.`)) return
  await replaceDataWithUndo(snapshot.data, `Restored snapshot from ${stamp(snapshot.at)}`)
}

function deleteAllData () {
  if (!confirm('Delete your plan, interests, people and notes on this device? A snapshot is kept under Snapshots.')) return
  replaceDataWithUndo(sanitizeData({}), 'Everything cleared')
}

// ---------- building blocks ----------
const accountSection = (title, ...kids) => h('div', { class: 'overlay-section' }, title ? h('h3', {}, title) : null, kids)
const accountRowBody = (title, meta, metaClass) => h('span', { class: 'item-body' },
  h('span', { class: 'item-title' }, title),
  meta ? h('span', { class: metaClass ? `item-meta ${metaClass}` : 'item-meta' }, meta) : null)
const accountChevron = name => h('span', { class: 'item-chevron' }, icon(name))
const accountAction = (title, meta, iconName, run, metaClass) => h('button', { class: 'item is-option', onclick: run },
  accountRowBody(title, meta, metaClass), accountChevron(iconName))

// Buttons with aria-pressed, one per choice.
function accountToggles (label, choices, current, pick) {
  return h('div', { class: 'toggle-group', role: 'group', 'aria-label': label }, choices.map(([value, text]) =>
    h('button', { 'aria-pressed': value === current ? 'true' : 'false', onclick: () => pick(value) }, text)))
}

function locationLabel (key) {
  const place = LOCATIONS[key]
  if (key === DEFAULT_LOCATION) return `${place.name} (main)`
  return key === ALL_LOCATION ? place.name : `${place.name} (satellite)`
}

function appearanceSection () {
  const pickLocation = ev => { chooseLocation(ev.target.value); renderOverlay() }
  const pickReminder = minutes => { prefs.reminderMinutes = minutes; save(); renderOverlay() }
  const pickTheme = theme => { applyTheme(theme); renderOverlay() }
  return accountSection('Conference and appearance', h('div', { class: 'panel' },
    HAS_LOCATION_CHOICE ? h('label', { class: 'item is-option' }, accountRowBody('Location'),
      h('select', { class: 'site-select', 'aria-label': 'Conference site', onchange: pickLocation },
        Object.keys(LOCATIONS).map(key => h('option', { value: key, selected: key === prefs.location }, locationLabel(key))))) : null,
    h('div', { class: 'item is-option' }, accountRowBody('Calendar reminders', 'Added to exported .ics files'),
      accountToggles('Calendar reminders', REMINDER_CHOICES, prefs.reminderMinutes, pickReminder)),
    h('div', { class: 'item is-option' }, accountRowBody('Appearance'),
      accountToggles('Theme', THEME_CHOICES.map(t => [t, t[0].toUpperCase() + t.slice(1)]), prefs.theme, pickTheme))))
}

function storageFacts (status) {
  const usage = status.usage && status.usage.usage
    ? `${(status.usage.usage / 1e6).toFixed(1)} MB of ${(status.usage.quota / 1e9).toFixed(1)} GB`
    : 'unknown'
  const persistent = status.persisted === 'granted' ? 'Granted'
    : status.persisted === 'unsupported' ? 'Not supported here'
      : 'Not granted; installing or bookmarking helps'
  return [
    h('dt', {}, 'Stored in'), h('dd', {}, status.ready ? 'IndexedDB, mirrored to localStorage' : `localStorage only (IndexedDB ${status.error || 'blocked'})`),
    h('dt', {}, 'Persistent'), h('dd', {}, persistent),
    h('dt', {}, 'Usage'), h('dd', {}, usage),
    h('dt', {}, 'Contents'), h('dd', {}, contentsLine(dataCounts(exportData()))),
  ]
}

function syncSection () {
  const facts = h('dl', { class: 'key-values' }, h('dt', {}, 'Status'), h('dd', {}, 'Checking…'))
  storageReport().then(status => { if (facts.isConnected) facts.replaceChildren(...storageFacts(status)) })
  const lastBackup = prefs.lastBackupAt ? `Last backup ${timeAgo(prefs.lastBackupAt)}` : 'Not backed up yet'
  const askPersistence = async () => { await askPersistentStorage(); renderOverlay() }
  return accountSection('Sync and backup',
    h('p', { class: 'section-note' }, 'No account and no server. Your plan, interests, people and notes live in this browser, with automatic snapshots. Make a backup before you travel.'),
    h('div', { class: 'panel' },
      accountAction('Sync to another device', 'QR code or link', 'chev', () => openSyncPanel()),
      accountAction('Download backup', lastBackup, 'down', () => downloadBackup(), backupDue() ? 'text-clash' : ''),
      accountAction('Restore from a backup file', '', 'up', () => qs('#backup-file').click()),
      accountAction('Ask for persistent storage', '', 'shield', askPersistence)),
    facts)
}

function snapshotRow (snapshot) {
  const c = snapshot.counts
  return h('div', { class: 'item is-snapshot' },
    h('div', { class: 'item-body' },
      h('div', { class: 'item-title' }, stamp(snapshot.at)),
      h('div', { class: 'item-meta' }, `${snapshot.reason}: ${count(c.starred, 'saved', 'saved')}, ${count(c.interests, 'interest')}, ${count(c.people, 'person', 'people')}, ${count(c.notes, 'note')}`)),
    h('button', { class: 'button is-small', onclick: () => restoreSnapshot(snapshot) }, 'Restore'))
}

function snapshotsSection () {
  const list = h('div', { class: 'panel' }, h('div', { class: 'item' }, h('div', { class: 'is-skeleton' })))
  listSnapshots().then(snapshots => {
    if (!list.isConnected) return
    if (!storageStatus.ready) list.replaceChildren(h('p', { class: 'section-note' }, 'Snapshots need IndexedDB, which this browser blocks here. Backup files still work.'))
    else if (!snapshots.length) list.replaceChildren(h('p', { class: 'section-note' }, 'No snapshots yet. They appear once you save something.'))
    else list.replaceChildren(...snapshots.map(snapshotRow))
  })
  return h('details', { class: 'overlay-section expander' }, h('summary', {}, 'Snapshots'),
    h('p', { class: 'section-note' }, 'Taken automatically: at most every 10 minutes while you edit, once a day, and before any restore, sync or clear. The last 20 are kept, plus one per day.'),
    list)
}

function devicesSection () {
  const address = /^https?:$/.test(location.protocol) ? location.origin : 'this local file'
  return h('details', { class: 'overlay-section expander' }, h('summary', {}, 'Phones, tablets and addresses'),
    h('ul', { class: 'bullets' },
      h('li', {}, h('b', {}, 'iPhone and iPad. '), 'Safari may delete a website’s data after about 7 days without a visit. Add the hosted planner to your Home Screen (Share, then Add to Home Screen) to keep it. The Home Screen app has its own storage, so sync or restore a backup into it once.'),
      h('li', {}, h('b', {}, 'The address matters. '), `Data belongs to this exact address (${address}). A different URL, a renamed repository or a local copy starts empty, so back up or sync first.`),
      h('li', {}, h('b', {}, 'Several devices. '), 'Use Sync (QR code or link) to move data between laptop and phone in either direction. The receiving device asks before changing anything.')))
}

function aboutSection () {
  const showShortcuts = () => { hidePanel(); qs('#shortcuts').showModal() }
  return accountSection('About',
    h('div', { class: 'panel' },
      h('a', { class: 'item is-option', href: OFFICIAL_SCHEDULE_URL, target: '_blank', rel: 'noopener' },
        accountRowBody('Official schedule', `Synced ${timeAgo(new Date(catalogInfo.generatedAt).getTime())}`), accountChevron('ext')),
      h('button', { class: 'item is-option', onclick: showShortcuts }, accountRowBody('Keyboard shortcuts'), accountChevron('chev'))),
    h('p', { class: 'section-note' }, `WhichTalk is an unofficial, community-built planner, not affiliated with or endorsed by ${ORGANIZER}. Data from ${SOURCE_NAME}.`))
}

// Body of the You overlay panel (an array of nodes).
export function accountPanel () {
  return [
    ...interestSections(),
    appearanceSection(),
    syncSection(),
    snapshotsSection(),
    devicesSection(),
    aboutSection(),
    accountSection('', h('button', { class: 'button is-danger', onclick: deleteAllData }, 'Delete my data on this device')),
  ]
}
