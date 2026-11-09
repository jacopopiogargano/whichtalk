// Read-only share links. Everything travels in the URL fragment, so nothing reaches a server:
// <page url>#plan=<base64url JSON { v: 1, name, starred, assignments, busy }>, empty fields left out.
// starred: ids in base36, ascending, joined with '.'; assignments: id -> colleague name, '@' for
// the sharer; busy: [day, fromMinute, toMinute] of personal events (titles stay private).
import { prefs, data } from '../state/store.js'
import { copyText } from '../lib/dom.js'
import { count, toBase64Url, fromBase64Url } from '../lib/text.js'
import { eventsById } from '../data/catalog.js'
import { sanitizeIdMap } from '../state/sanitize.js'
import { pageUrl } from '../ui/router.js'

const SHARE_FORMAT_VERSION = 1
const NOT_A_SHARE_LINK = 'That is not a share link. In their copy, My plan, Share copies one.'

export function shareLink () {
  const payload = { v: SHARE_FORMAT_VERSION }
  if (prefs.displayName) payload.name = prefs.displayName
  if (data.starred.size) payload.starred = [...data.starred].sort((a, b) => a - b).map(id => id.toString(36)).join('.')
  const assigned = Object.entries(data.assignments)
  if (assigned.length) payload.assignments = Object.fromEntries(assigned.map(([id, who]) => [id, who === 'me' ? '@' : who]))
  if (data.personal.length) payload.busy = data.personal.map(r => [r.day, r.from, r.to])
  return pageUrl() + '#plan=' + toBase64Url(JSON.stringify(payload))
}

export function shareMyPlan () {
  copyText(shareLink(), `Share link copied, ${count(data.starred.size, 'item')}. It is read-only.`)
}

function readSharePayload (text) {
  const raw = String(text || '').trim()
  const hash = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : raw
  const encoded = new URLSearchParams(hash).get('plan')
  if (!encoded) return null
  try {
    const payload = JSON.parse(fromBase64Url(encoded))
    return payload && typeof payload === 'object' && payload.v === SHARE_FORMAT_VERSION ? payload : null
  } catch (err) {
    return null
  }
}

// Accepts a full URL or just its fragment; returns only events this catalog knows.
export function parseShareLink (text) {
  const payload = readSharePayload(text)
  if (!payload) throw new Error(NOT_A_SHARE_LINK)
  const starred = String(payload.starred || '').split('.').filter(Boolean)
    .map(part => parseInt(part, 36))
    .filter(id => id > 0 && eventsById.has(id))
  const assignments = sanitizeIdMap(payload.assignments, who => typeof who === 'string')
  const busy = (Array.isArray(payload.busy) ? payload.busy : [])
    .filter(slot => Array.isArray(slot) && slot.length === 3)
    .slice(0, 200)
  const name = typeof payload.name === 'string' ? payload.name.slice(0, 60) : ''
  return { starred, assignments, busy, name }
}
