// URL hash <-> UI state. The hash mirrors where the user is (view, day, layout, location, query,
// open event, You panel) so the page can be bookmarked or shared. Two one-shot payloads also arrive
// through the hash: a shared plan (#plan=...) and a device-to-device sync link (#sync=...).
import { qs } from '../lib/dom.js'
import { eventsById } from '../data/catalog.js'
import { LOCATIONS, DEFAULT_LOCATION } from '../data/conference.js'
import { prefs, ui } from '../state/store.js'
import { setQuery } from '../plan/filters.js'
import { parseShareLink } from '../plan/share.js'

// Three top-level destinations (keys 1-3). "foryou" is a page pushed from Today.
export const NAV_TABS = [
  { key: 'today', label: 'Today', icon: 'home' },
  { key: 'schedule', label: 'Schedule', icon: 'list' },
  { key: 'plan', label: 'My plan', icon: 'star' },
]
export const VIEW_NAMES = ['today', 'schedule', 'plan', 'foryou']
const ROUTER_PLAN_SECTIONS = ['sessions', 'people', 'notes', 'team']

export const tabForView = view => (view === 'foryou' ? 'today' : view)
export const pageUrl = () => location.href.split('#')[0]

// A sync payload is read during boot but applied only once storage has been reconciled.
let pendingSyncPayload = null
export function takePendingSync () {
  const payload = pendingSyncPayload
  pendingSyncPayload = null
  return payload
}

const clearHash = () => history.replaceState(null, '', pageUrl())

export function writeHash () {
  const params = new URLSearchParams()
  const view = ui.view
  if (view !== 'today') params.set('v', view)
  if (view === 'schedule') {
    if (prefs.day) params.set('d', prefs.day)
    if (prefs.scheduleLayout === 'rooms') params.set('m', 'rooms')
  }
  if (view === 'plan' && prefs.planSection !== 'sessions') params.set('t', prefs.planSection)
  if (prefs.location !== DEFAULT_LOCATION) params.set('s', prefs.location)
  if (ui.query) params.set('q', ui.query)
  if (ui.selection && ui.selection.type === 'event') params.set('e', ui.selection.id)
  if (ui.panel === 'you') params.set('p', 'you')
  const next = params.toString()
  if (location.hash.slice(1) !== next) history.replaceState(null, '', next ? '#' + next : pageUrl())
}

function acceptSharedPlan () {
  try {
    const ids = parseShareLink(location.hash).starred.filter(id => eventsById.has(id))
    if (ids.length) ui.sharedPlan = ids
  } catch (err) { /* not a usable plan link: open the page as usual */ }
}

export function readHash () {
  const raw = location.hash.slice(1)
  if (raw.startsWith('sync=')) {
    pendingSyncPayload = raw.slice(5)
    clearHash()
    return
  }
  const params = new URLSearchParams(raw)
  if (params.has('plan')) {
    acceptSharedPlan()
    clearHash()
    return
  }
  const where = params.get('s')
  if (where && Object.prototype.hasOwnProperty.call(LOCATIONS, where)) prefs.location = where
  const view = params.get('v')
  if (view) ui.view = VIEW_NAMES.includes(view) ? view : 'today'
  if (params.get('m') === 'rooms') prefs.scheduleLayout = 'rooms'
  const section = params.get('t')
  if (ROUTER_PLAN_SECTIONS.includes(section)) prefs.planSection = section
  const day = params.get('d')
  if (day) {
    prefs.day = day
    if (!view) ui.view = 'schedule'
  }
  const query = params.get('q')
  if (query) {
    qs('#search-input').value = query
    setQuery(query)
    ui.searching = true
  }
  if (params.get('p') === 'you') ui.panel = 'you'
  const id = Number(params.get('e'))
  if (eventsById.has(id)) {
    ui.selection = { type: 'event', id }
    ui.panel = null
  }
}
