// Schedule: the day as time slots (or the rooms grid), the day picker, the filter panel and the
// search results page, which spans every day.
import { h, qs } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { nowSec, dayOf, minuteOfDay, clockFromMinutes, timeRange, dayInfo, isOngoing } from '../lib/time.js'
import { num, count, normalize } from '../lib/text.js'
import { isGroupEvent } from '../data/catalog.js'
import { LOCATIONS, TRACKS, DEFAULT_TRACKS, DEFAULT_LOCATION, ALL_LOCATION, HAS_LOCATION_CHOICE, UNTIMED_NOTE } from '../data/conference.js'
import { prefs, data, ui, save } from '../state/store.js'
import { SCORES, interestCount, rescore, isSuggested } from '../search/relevance.js'
import {
  activeTerms, isFiltering, matchesQuery, inTracks, passesPast, tracksAreDefault, topLevel, locationDays,
  hasUnscheduled, childrenHere, dayTitle, dayShort, visibleTopLevel,
} from '../plan/filters.js'
import { dayClashes } from '../plan/clashes.js'
import { personalEvents } from '../plan/personal.js'
import { eventItem, paperItem, lazyList, pageHead, emptyState } from '../ui/components.js'
import { showEvent, showPanel, renderOverlay } from '../ui/overlay.js'
import { renderPage, renderAll, chooseDay, chooseLocation, setSearching, trackCounts } from '../ui/shell.js'
import { choiceGroup, nowRule } from './today.js'
import { renderRoomsGrid, trackOrder } from './rooms.js'

// Top-level items of a day (or of 'tba') that pass the filters, plus my own events when shown.
function scheduleDayItems (day) {
  const own = prefs.showPersonal && day !== 'tba' && !activeTerms.length
    ? personalEvents().filter(e => dayOf(e.start) === day)
    : []
  const onDay = e => (day === 'tba' ? !e.start : !!e.start && dayOf(e.start) === day)
  return topLevel().filter(e => onDay(e) && visibleTopLevel(e)).concat(own)
}

// ---------- filters ----------
export function activeFilterLabels () {
  const labels = []
  if (!tracksAreDefault()) labels.push(`${prefs.tracks.size} of ${TRACKS.length} types`)
  if (prefs.onlyMatches && data.interests.length) labels.push('Suggestions only')
  if (ui.focusInterest) {
    const focused = data.interests.find(it => normalize(it.text) === ui.focusInterest)
    if (focused) labels.push(`“${focused.text}”`)
  }
  if (prefs.hidePast) labels.push('Hiding finished')
  if (prefs.location !== DEFAULT_LOCATION) labels.push(LOCATIONS[prefs.location].name)
  return labels
}

export const activeFilterCount = () => activeFilterLabels().length

export function resetFilters () {
  prefs.tracks = new Set(DEFAULT_TRACKS)
  prefs.onlyMatches = false
  prefs.hidePast = false
  ui.focusInterest = null
  rescore()
  save()
  renderAll()
}

// Filter panel body: session types, suggestions only, one interest, hide finished, location (when there
// is a choice).
export function filterPanel () {
  const counts = trackCounts()
  const redraw = () => { renderPage(); renderOverlay() }
  const body = (label, meta) => h('span', { class: 'item-body' }, h('span', { class: 'item-title' }, label), meta ? h('span', { class: 'item-meta' }, meta) : null)
  const option = (checked, label, n, pick, meta) => h('button', { class: 'item is-option', role: 'menuitemcheckbox', 'aria-checked': checked ? 'true' : 'false', onclick: pick },
    body(label, meta),
    n === undefined ? null : h('span', { class: 'item-count' }, n ? num(n) : ''),
    h('span', { class: 'check-mark' }, checked ? icon('check') : null))
  const toggle = (on, label, meta, flip) => h('button', { class: 'item is-option', role: 'switch', 'aria-checked': on ? 'true' : 'false', onclick: flip },
    body(label, meta), h('span', { class: 'toggle' }))
  const block = (heading, ...rows) => h('div', { class: 'overlay-section' }, h('h3', {}, heading), h('div', { class: 'panel' }, rows))
  const hasInterests = data.interests.length > 0

  const types = TRACKS.map(track => option(prefs.tracks.has(track.key), track.label, counts[track.key] || 0, () => {
    if (prefs.tracks.has(track.key)) prefs.tracks.delete(track.key)
    else prefs.tracks.add(track.key)
    save()
    redraw()
  }))
  const show = [
    toggle(prefs.onlyMatches, 'Only suggestions for you', hasInterests ? null : 'Add interests first', () => {
      if (!hasInterests) { showPanel('you'); return }
      prefs.onlyMatches = !prefs.onlyMatches
      save()
      redraw()
    }),
    toggle(prefs.hidePast, 'Hide finished sessions', null, () => { prefs.hidePast = !prefs.hidePast; save(); redraw() }),
    data.personal.length ? toggle(prefs.showPersonal, 'Show my own events', null, () => { prefs.showPersonal = !prefs.showPersonal; save(); redraw() }) : null,
  ]
  const interests = hasInterests ? [
    option(!ui.focusInterest, 'Any interest', undefined, () => { ui.focusInterest = null; rescore(); redraw() }),
    ...data.interests.map((it, i) => {
      const key = normalize(it.text)
      return option(ui.focusInterest === key, it.text, interestCount[i] || 0, () => {
        ui.focusInterest = ui.focusInterest === key ? null : key
        if (!it.active) { it.active = true; save() }
        rescore()
        redraw()
      })
    }),
  ] : null
  const places = HAS_LOCATION_CHOICE ? Object.entries(LOCATIONS).map(([key, loc]) => option(prefs.location === key, loc.name, undefined,
    () => { chooseLocation(key); renderOverlay() },
    key === DEFAULT_LOCATION ? 'Main conference' : key === ALL_LOCATION ? null : 'Satellite')) : null
  return [
    block('Session types', types),
    block('Show', show),
    interests ? block('Interest', interests) : null,
    places ? block('Location', places) : null,
  ]
}

// ---------- day picker ----------
export function dayPickerView () {
  const todayKey = dayOf(nowSec())
  const days = locationDays().concat(hasUnscheduled() ? ['tba'] : [])
  return h('div', { class: 'toggle-group day-picker', id: 'day-select', role: 'group', 'aria-label': 'Day' }, days.map(k => {
    const pressed = prefs.day === k ? 'true' : 'false'
    if (k === 'tba') {
      return h('button', { 'aria-pressed': pressed, onclick: () => chooseDay(k), 'aria-label': 'Time not yet published' }, h('span', {}, 'TBA'))
    }
    const info = dayInfo(k)
    const overlaps = dayClashes(k)
    return h('button', {
      'aria-pressed': pressed,
      class: k === todayKey ? 'is-today' : null,
      onclick: () => chooseDay(k),
      'aria-label': overlaps ? `${info.long}, ${count(overlaps, 'overlap')}` : info.long,
    }, h('span', { class: 'day-name' }, info.weekday), h('span', { class: 'day-num' }, String(info.date)))
  }))
}

// ---------- the day ----------
function scheduleScrollToNow () {
  const rule = qs('#now-rule')
  if (rule) rule.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

// Items grouped under their start time; the "Now" rule goes before the first slot still to come.
function scheduleSlots (container, items, isToday) {
  const slots = new Map()
  for (const e of items) {
    const minute = minuteOfDay(e.start)
    if (!slots.has(minute)) slots.set(minute, [])
    slots.get(minute).push(e)
  }
  const t = nowSec()
  let ruleDone = !isToday
  for (const [minute, list] of [...slots].sort((a, b) => a[0] - b[0])) {
    if (!ruleDone && list[0].start > t) { container.append(nowRule(t)); ruleDone = true }
    list.sort((a, b) => trackOrder(a) - trackOrder(b) || isSuggested(b) - isSuggested(a) || a.title.localeCompare(b.title))
    const live = list.some(e => isOngoing(e))
    const label = clockFromMinutes(minute)
    container.append(h('section', { class: 'timeslot', 'aria-label': label },
      h('h2', { class: 'timeslot-head' + (live ? ' is-live' : '') }, label, live ? h('span', { class: 'chip' }, 'Now') : null),
      h('div', { class: 'panel' }, list.map(e => eventItem(e)))))
  }
  if (!ruleDone) container.append(nowRule(t))
}

export function renderSchedule (container) {
  const day = prefs.day
  const items = scheduleDayItems(day)
  const starred = items.filter(e => data.starred.has(e.id)).length
  const filters = activeFilterLabels()
  const rooms = prefs.scheduleLayout === 'rooms'
  const showNow = day !== 'tba' && items.length > 0 && !rooms && day === dayOf(nowSec())
  const when = day === 'tba' ? 'Time not yet published' : `${dayInfo(day).long}${dayShort(day) ? ', ' + dayTitle(day) : ''}`
  container.append(pageHead('Schedule', [when, count(items.length, 'session'), starred && `${starred} saved`, LOCATIONS[prefs.location].zone],
    showNow ? h('button', { class: 'button', onclick: scheduleScrollToNow }, 'Now') : null,
    choiceGroup('View', [['list', 'List'], ['rooms', 'By room']], rooms ? 'rooms' : 'list', value => { prefs.scheduleLayout = value; save(); renderPage() }),
    h('button', { class: 'button' + (filters.length ? ' is-on' : ''), id: 'filter-open', onclick: () => showPanel('filter') },
      icon('filter'), filters.length ? `Filter (${filters.length})` : 'Filter')))
  container.append(dayPickerView())
  if (filters.length) {
    container.append(h('p', { class: 'filter-summary' }, h('span', {}, filters.join(', ')), h('button', { class: 'text-button', onclick: resetFilters }, 'Clear')))
  }
  if (day === 'tba') {
    container.append(h('p', { class: 'section-note' }, UNTIMED_NOTE))
    if (!items.length) { container.append(emptyState('Nothing here', 'No untimed items match the filter.')); return }
    const box = h('div', { class: 'panel' })
    lazyList(box, items, e => paperItem(e), 'page')
    container.append(h('section', { class: 'section' }, box))
    return
  }
  if (!items.length) {
    const filtered = isFiltering() || filters.length > 0
    container.append(emptyState('Nothing here', filtered ? 'No sessions match the filter on this day.' : 'No sessions on this day.',
      filters.length ? h('button', { class: 'button', onclick: resetFilters }, 'Clear filter') : null))
    return
  }
  if (rooms) renderRoomsGrid(container, day, items)
  else scheduleSlots(container, items, day === dayOf(nowSec()))
}

// ---------- search results ----------
// Matches by day: [[day or 'tba', { items, sessions: [{ session, papers }] }], …], untimed last.
// A poster session with matching posters is listed with them; otherwise it can match on its own.
function scheduleSearchByDay () {
  const days = new Map()
  const dayGroup = k => {
    if (!days.has(k)) days.set(k, { items: [], sessions: [] })
    return days.get(k)
  }
  for (const e of topLevel()) {
    if (!inTracks(e) || !passesPast(e)) continue
    const k = e.start ? dayOf(e.start) : 'tba'
    const papers = isGroupEvent(e) ? childrenHere(e).filter(x => inTracks(x) && matchesQuery(x)) : []
    if (papers.length) dayGroup(k).sessions.push({ session: e, papers })
    else if (matchesQuery(e)) dayGroup(k).items.push(e)
  }
  return [...days].sort((a, b) => (a[0] === 'tba') - (b[0] === 'tba') || a[0].localeCompare(b[0]))
}

function scheduleSessionBlock (session, papers) {
  const FIRST = 24
  const list = h('div', { class: 'panel' })
  const facts = [session.start && timeRange(session), session.room, count(papers.length, 'match', 'matches')].filter(Boolean).join(', ')
  papers.slice(0, FIRST).forEach(p => list.append(paperItem(p)))
  if (papers.length > FIRST) {
    const more = h('button', {
      class: 'item is-more',
      onclick: () => { more.remove(); lazyList(list, papers.slice(FIRST), p => paperItem(p), 'page', 80) },
    }, `Show ${num(papers.length - FIRST)} more`)
    list.append(more)
  }
  return h('section', { class: 'section session-block' },
    h('div', { class: 'section-head' }, h('h3', {}, session.title), h('span', { class: 'section-aside' }, facts),
      h('button', { class: 'text-button', onclick: () => showEvent(session.id) }, 'Open session')),
    list)
}

export function renderSearch (container) {
  const groups = scheduleSearchByDay()
  let sessionCount = 0
  let paperCount = 0
  const blocks = []
  for (const [k, g] of groups) {
    g.items.sort((a, b) => (a.start - b.start) || (trackOrder(a) - trackOrder(b)))
    g.sessions.sort((a, b) => a.session.start - b.session.start)
    const papers = g.sessions.reduce((n, s) => n + s.papers.length, 0)
    sessionCount += g.items.length
    paperCount += papers
    blocks.push({ day: k, text: [g.items.length && count(g.items.length, 'session'), papers && count(papers, 'paper')].filter(Boolean).join(', ') })
    if (g.items.length) blocks.push({ items: g.items })
    for (const s of g.sessions) blocks.push({ session: s })
  }
  container.append(pageHead(`Results for “${ui.query}”`,
    [`${count(sessionCount, 'session')} and ${count(paperCount, 'paper')}`, 'All days', LOCATIONS[prefs.location].name, prefs.onlyMatches && SCORES && 'Suggestions only'],
    h('button', { class: 'button', onclick: () => setSearching('') }, 'Clear')))
  if (!sessionCount && !paperCount) {
    container.append(emptyState('No matches', 'Try fewer words, an author’s last name, an affiliation or a room.'))
    return
  }
  lazyList(container, blocks, b => {
    if (b.day) return h('div', { class: 'day-head' }, h('h2', {}, b.day === 'tba' ? 'Time not yet published' : dayInfo(b.day).long), h('span', {}, b.text))
    if (b.items) return h('div', { class: 'panel' }, b.items.map(e => eventItem(e, { time: true })))
    return scheduleSessionBlock(b.session.session, b.session.papers)
  }, 'page', 8)
}
