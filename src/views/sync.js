// Device-to-device sync without a server: the user data travels inside a URL (#sync=...), shown as
// a QR code, shared as a link or saved as a backup file. The receiving device compares, then asks
// whether to merge, replace or keep. Payload format: sync-codec.js.
/* global qrcode */
import { h, notify, copyText } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { timeAgo } from '../lib/time.js'
import { count, num, httpUrl, normalize } from '../lib/text.js'
import { CONFERENCE_NAME, CANONICAL_URL } from '../data/conference.js'
import { prefs, exportData, save } from '../state/store.js'
import { MAX_INTERESTS, sanitizeData } from '../state/sanitize.js'
import { dataCounts, replaceDataWithUndo, downloadBackup, readBackup } from '../state/persistence.js'
import { openDialog, closeDialog } from '../ui/dialog.js'
import { encodeSyncPayload, decodeSyncPayload } from './sync-codec.js'

// URL characters; larger QR codes get unreliable to scan with phone cameras.
const SYNC_QR_LIMIT = 1600
const SVG_NS = 'http://www.w3.org/2000/svg'

// The address the other device opens: this page when it is hosted, else the address the user gave.
export const syncTarget = () => (/^https?:$/.test(location.protocol) ? location.origin + location.pathname : (prefs.syncOrigin || ''))

function syncQrCode (text) {
  const code = qrcode(0, text.length > 1200 ? 'L' : 'M')
  code.addData(text, 'Byte')
  code.make()
  const size = code.getModuleCount()
  const svgNode = (tag, attrs) => {
    const node = document.createElementNS(SVG_NS, tag)
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
    return node
  }
  let path = ''
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) if (code.isDark(row, col)) path += `M${col},${row}h1v1h-1z`
  }
  const svg = svgNode('svg', { viewBox: `-4 -4 ${size + 8} ${size + 8}`, 'shape-rendering': 'crispEdges', role: 'img', 'aria-label': 'QR code for the sync link' })
  svg.append(svgNode('rect', { x: -4, y: -4, width: size + 8, height: size + 8, fill: '#fff' }), svgNode('path', { d: path, fill: '#000' }))
  return svg
}

const backupButton = label => h('button', { class: 'button', onclick: () => downloadBackup() }, icon('down'), label)

// Shown when this page is a local file: QR sync needs the hosted address.
function askForSyncOrigin (body) {
  const input = h('input', { placeholder: CANONICAL_URL, value: prefs.syncOrigin || '', 'aria-label': 'Hosted address of this planner' })
  const use = () => {
    const address = input.value.trim()
    if (!httpUrl(address)) {
      input.focus()
      return
    }
    prefs.syncOrigin = address
    save()
    openSyncPanel()
  }
  body.append(
    h('p', { class: 'helper' }, 'QR sync opens the hosted copy of this planner on the other device, so it needs that web address (this page is a local file).'),
    h('div', { class: 'autocomplete-row' }, input, h('button', { class: 'button is-primary', onclick: use }, 'Use address')),
    h('p', { class: 'helper' }, 'Or move everything with a backup file:'),
    backupButton('Download backup file'))
}

export async function openSyncPanel () {
  const body = h('div', {})
  openDialog('Sync to another device', body, [h('button', { class: 'button', onclick: () => closeDialog() }, 'Done')])
  const target = syncTarget()
  if (!target) {
    askForSyncOrigin(body)
    return
  }
  const copy = exportData()
  let payload
  try {
    payload = await encodeSyncPayload(copy)
  } catch (err) {
    body.append(h('p', { class: 'status-line is-error' }, err.message))
    return
  }
  const url = `${target}#sync=${payload}`
  const counts = dataCounts(copy)
  body.append(h('p', { class: 'helper' }, `Contains ${count(counts.starred, 'saved item')}, ${count(counts.interests, 'interest')}, ${count(counts.people, 'person', 'people')} and ${count(counts.notes, 'note')} (${num(url.length)} characters). The other device asks before changing anything.`))
  if (url.length <= SYNC_QR_LIMIT) {
    body.append(h('div', { class: 'qr-code' }, syncQrCode(url)), h('p', { class: 'helper is-centered' }, 'Scan with a phone camera. On a laptop, send the link instead.'))
  } else {
    body.append(h('div', { class: 'notice is-warn' }, icon('warn'),
      h('div', { class: 'fill' },
        h('b', {}, 'Too much data for one QR code'),
        h('div', { class: 'page-meta' }, `${num(url.length)} characters won’t scan reliably; the limit is about ${num(SYNC_QR_LIMIT)}. Send the link with AirDrop or Messages, or use a backup file. Both carry everything.`))))
  }
  const share = () => navigator.share({ title: `My ${CONFERENCE_NAME} plan on WhichTalk`, url }).catch(() => {})
  body.append(
    h('div', { class: 'actions is-centered' },
      navigator.share ? h('button', { class: 'button is-primary', onclick: share }, icon('share'), 'Share link') : null,
      h('button', { class: 'button', onclick: () => copyText(url, 'Sync link copied') }, icon('link'), 'Copy link'),
      backupButton('Backup file')),
    h('div', { class: 'privacy-note' }, icon('shield'), h('span', {}, 'The data lives in the link after “#”, which browsers never send to the server. Anyone with the link can read it, so share it only with yourself.')))
  body.dataset.url = url
}

// ---------- receiving ----------
const newestOf = (a, b, field) => ((b[field] || 0) > (a[field] || 0) ? b : a)

// Notes by id, the most recently edited copy of each, newest meeting first.
function mergeNotes (mine, theirs) {
  const notesById = new Map(mine.map(n => [n.id, n]))
  for (const n of theirs) notesById.set(n.id, notesById.has(n.id) ? newestOf(notesById.get(n.id), n, 'updated') : n)
  return [...notesById.values()].sort((a, b) => b.at - a.at)
}

// Both arguments are plain copies of the user data (exportData() / sanitizeData()). Saved items,
// reading marks and interests are unions; for the same person, notes merge note by note and the
// most recently edited profile wins; personal events and colleagues keep the newest copy; my own
// assignments and visit windows win over the incoming ones.
export function mergeUserData (mine, theirs) {
  const out = JSON.parse(JSON.stringify(mine))
  out.starred = [...new Set([...mine.starred, ...theirs.starred])]
  for (const interest of theirs.interests) {
    const have = out.interests.find(x => normalize(x.text) === normalize(interest.text))
    if (have) have.weight = Math.max(have.weight, interest.weight)
    else if (out.interests.length < MAX_INTERESTS) out.interests.push(interest)
  }
  out.votes = { ...mine.votes, ...theirs.votes }
  for (const person of theirs.people) {
    const have = out.people.find(x => normalize(x.name) === normalize(person.name))
    if (!have) {
      out.people.push(person)
      continue
    }
    const notes = mergeNotes(have.notes, person.notes || [])
    Object.assign(have, { ...newestOf(have, person, 'updated'), notes, id: have.id })
  }
  const personal = new Map(out.personal.map(r => [r.id, r]))
  for (const r of theirs.personal) personal.set(r.id, personal.has(r.id) ? newestOf(personal.get(r.id), r, 'updated') : r)
  out.personal = [...personal.values()]
  out.readList = [...new Set([...mine.readList, ...theirs.readList])]
  const team = new Map(out.team.map(m => [normalize(m.name), m]))
  for (const m of theirs.team) {
    const key = normalize(m.name)
    team.set(key, team.has(key) ? newestOf(team.get(key), m, 'addedAt') : m)
  }
  out.team = [...team.values()]
  out.assignments = { ...theirs.assignments, ...mine.assignments }
  out.visitWindows = { ...theirs.visitWindows, ...mine.visitWindows }
  return out
}

// What the incoming copy would change: { newHere, onlyHere, interests, people, notes, theirs }
// (theirs = dataCounts of the incoming copy).
export function describeDiff (mine, theirs) {
  const here = new Set(mine.starred)
  const there = new Set(theirs.starred)
  const peopleHere = new Map(mine.people.map(p => [normalize(p.name), p]))
  let people = 0
  let notes = 0
  for (const person of theirs.people) {
    const have = peopleHere.get(normalize(person.name))
    if (!have) {
      people++
      notes += (person.notes || []).length
      continue
    }
    const known = new Map(have.notes.map(n => [n.id, n]))
    for (const n of person.notes || []) if (!known.has(n.id) || (n.updated || 0) > (known.get(n.id).updated || 0)) notes++
  }
  const interestKeys = new Set(mine.interests.map(x => normalize(x.text)))
  return {
    newHere: [...there].filter(id => !here.has(id)).length,
    onlyHere: [...here].filter(id => !there.has(id)).length,
    interests: theirs.interests.filter(x => !interestKeys.has(normalize(x.text))).length,
    people,
    notes,
    theirs: dataCounts(theirs),
  }
}

// One cell of a comparison grid: a big number over its label.
export const diffStat = (n, label) => h('div', {}, h('b', {}, String(n)), label)

export async function receiveSyncLink (payload) {
  let incoming
  try {
    incoming = await decodeSyncPayload(payload)
  } catch (err) {
    openDialog('Couldn’t read the sync link', h('p', { class: 'status-line is-error' }, err.message),
      [h('button', { class: 'button is-primary', onclick: () => closeDialog() }, 'OK')])
    return
  }
  const theirs = sanitizeData(readBackup(incoming))
  const mine = exportData()
  const diff = describeDiff(mine, theirs)
  let choice = 'merge'
  const option = (value, title, detail) => h('label', {},
    h('input', { type: 'radio', name: 'sync-choice', value, checked: value === choice, onchange: () => { choice = value } }),
    h('span', {}, h('b', {}, title), h('small', {}, detail)))
  const apply = async () => {
    closeDialog()
    if (choice === 'keep') {
      notify('Kept this device’s data')
      return
    }
    if (choice === 'replace') await replaceDataWithUndo(theirs, 'Replaced with the other device’s data')
    else await replaceDataWithUndo(mergeUserData(mine, theirs), 'Merged the other device’s data')
  }
  openDialog('Data from another device',
    h('div', {},
      h('p', { class: 'helper' }, `Sent ${timeAgo(incoming.at)}. Compared with this device:`),
      h('div', { class: 'diff-grid' },
        diffStat(diff.newHere, 'saved items new here'), diffStat(diff.onlyHere, 'saved here, not there'),
        diffStat(diff.interests, 'new interests'), diffStat(diff.people, 'new people'), diffStat(diff.notes, 'notes new or changed')),
      h('div', { class: 'choice-list', role: 'radiogroup' },
        option('merge', 'Merge (recommended)', 'Union of saved items, interests and people; for notes on the same person, the newest version wins.'),
        option('replace', 'Use data from the other device', `Replace this device’s data with theirs (${count(diff.theirs.starred, 'saved item')}, ${count(diff.theirs.people, 'person', 'people')}).`),
        option('keep', 'Keep this device', 'Ignore the incoming data.')),
      h('p', { class: 'helper' }, 'A snapshot of this device is taken first, so you can restore it later under You, Snapshots.')),
    [h('button', { class: 'button', onclick: () => closeDialog() }, 'Cancel'), h('button', { class: 'button is-primary', id: 'sync-apply', onclick: apply }, 'Apply')])
}
