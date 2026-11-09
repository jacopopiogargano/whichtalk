// The app shell: the rail (wordmark, section tabs, search, You), the bottom tab bar on phones, the page
// area, and the navigation actions that move between views, days and locations.
import { qs, h, fill } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { dayOf, nowSec, setZoneOffset } from '../lib/time.js'
import { count } from '../lib/text.js'
import { isGroupEvent } from '../data/catalog.js'
import { LOCATIONS } from '../data/conference.js'
import { prefs, ui, save } from '../state/store.js'
import { backupDue } from '../state/persistence.js'
import { resetHighlights, rescore } from '../search/relevance.js'
import { activeTerms, setQuery, matchesQuery, topLevel, childrenHere, locationDays, bumpGeneration } from '../plan/filters.js'
import { rebuildPersonalEvents } from '../plan/personal.js'
import { renderToday, renderPicks, planCounts } from '../views/today.js'
import { renderSchedule, renderSearch, dayPickerView } from '../views/schedule.js'
import { renderPlan, sharedPlanNotice } from '../views/plan.js'
import { importBackupFile } from '../views/settings.js'
import { observers } from './components.js'
import { renderOverlay, showPanel, hidePanel } from './overlay.js'
import { NAV_TABS, VIEW_NAMES, tabForView, writeHash } from './router.js'

const searchInput = () => qs('#search-input')

// ---------- page ----------
export function renderPage () {
  observers.page.splice(0).forEach(watcher => watcher.disconnect())
  bumpGeneration()
  const page = qs('#page')
  page.replaceChildren()
  if (ui.sharedPlan && !ui.showingShared) page.append(sharedPlanNotice())
  if (activeTerms.length) { renderSearch(page); return }
  switch (ui.view) {
    case 'schedule': renderSchedule(page); break
    case 'plan': renderPlan(page); break
    case 'foryou': renderPicks(page); break
    default: renderToday(page)
  }
}

// Short cross-fade when the view changes (reduced motion is handled in CSS).
function fadePageIn () {
  const page = qs('#page')
  page.classList.remove('is-entering')
  requestAnimationFrame(() => page.classList.add('is-entering'))
}

// Matching items per track, for the filter panel: the shown day in the Schedule, everything otherwise.
// A poster session counts its matching posters.
export function trackCounts () {
  const onShownDay = e => (prefs.day === 'tba' ? !e.start : e.start && dayOf(e.start) === prefs.day)
  const pool = ui.view === 'schedule' && !activeTerms.length ? topLevel().filter(onShownDay) : topLevel()
  const totals = {}
  const add = (track, n) => { totals[track] = (totals[track] || 0) + n }
  for (const e of pool) {
    if (isGroupEvent(e)) add(e.track, childrenHere(e).filter(matchesQuery).length)
    else if (matchesQuery(e)) add(e.track, 1)
  }
  return totals
}

// ---------- rail and tab bar ----------
function railTab (tab, index, counts) {
  const current = tabForView(ui.view) === tab.key && !activeTerms.length && !ui.searching
  const badge = tab.key === 'plan' && counts.overlaps
    ? h('span', { class: 'count is-warn', title: count(counts.overlaps, 'overlap') }, String(counts.overlaps))
    : null
  return h('button', {
    role: 'tab', 'aria-selected': current ? 'true' : 'false', 'aria-pressed': current ? 'true' : 'false', 'data-tab': tab.key,
    title: `${tab.label} (${index + 1})`, onclick: () => navigate(tab.key),
  }, icon(tab.icon), h('span', { class: 'label' }, tab.label), badge)
}

export function renderRail () {
  const counts = planCounts()
  for (const holder of [qs('#nav-tabs'), qs('#bottom-nav')]) fill(holder, NAV_TABS.map((tab, i) => railTab(tab, i, counts)))
  const searching = ui.searching || !!ui.query
  qs('#rail').classList.toggle('is-searching', searching)
  qs('#search-field').hidden = !searching
  qs('#search-clear').hidden = !ui.query
  const account = qs('#account-button')
  const due = backupDue()
  account.setAttribute('aria-pressed', ui.panel === 'you' ? 'true' : 'false')
  account.classList.toggle('has-alert', due)
  account.title = due ? 'You: interests, sync and backup (not backed up yet)' : 'You: interests, sync and backup'
}

// Account state (backup reminder) changed: refresh the rail and the You panel if it is open.
export function renderAccountState () {
  renderRail()
  if (ui.panel === 'you') renderOverlay()
}

export function renderDayPicker () {
  const current = qs('#day-select')
  if (current) current.replaceWith(dayPickerView())
}

export function renderAll () {
  renderRail()
  renderPage()
  renderOverlay()
  writeHash()
}

export function handleScoresChanged () { resetHighlights() }

// ---------- navigation ----------
function leaveSearch () {
  searchInput().value = ''
  setQuery('')
  ui.searching = false
}

export function navigate (view) {
  const next = VIEW_NAMES.includes(view) ? view : 'today'
  const changed = next !== ui.view
  ui.view = next
  if (activeTerms.length || ui.searching) leaveSearch()
  if (next !== 'plan') ui.showingShared = false
  if (ui.panel) ui.panel = null
  if (ui.selection) { ui.selection = null; ui.history = [] }
  renderAll()
  scrollTo(0, 0)
  if (changed) fadePageIn()
}

export function chooseDay (day) {
  prefs.day = day
  save()
  const previous = ui.view
  ui.view = 'schedule'
  if (activeTerms.length) leaveSearch()
  renderRail()
  renderPage()
  writeHash()
  scrollTo(0, 0)
  if (previous !== 'schedule') fadePageIn()
}

// Today if the conference runs today at this location, else its first day.
export function pickDefaultDay () {
  const days = locationDays()
  const today = dayOf(nowSec())
  return days.includes(today) ? today : days[0]
}

export function chooseLocation (key) {
  prefs.location = key
  setZoneOffset(LOCATIONS[key].tz)
  if (prefs.day !== 'tba' && !locationDays().includes(prefs.day)) prefs.day = pickDefaultDay()
  rebuildPersonalEvents()
  rescore()
  save()
  renderRail()
  renderPage()
  writeHash()
}

export function applyTheme (theme) {
  prefs.theme = theme
  document.documentElement.dataset.theme = theme
  save()
}

// ---------- search ----------
export function openSearchField () {
  ui.searching = true
  renderRail()
  const input = searchInput()
  input.focus()
  input.select()
}

export function closeSearchField () {
  ui.searching = false
  if (ui.query) setSearching('')
  else renderRail()
  searchInput().blur()
}

// Runs a search (or clears it with ''), closing whatever the overlay shows.
export function setSearching (text) {
  searchInput().value = text
  setQuery(text.trim())
  if (text) ui.searching = true
  if (ui.selection) { ui.selection = null; ui.history = [] }
  if (ui.panel) ui.panel = null
  renderRail()
  renderPage()
  renderOverlay()
  writeHash()
  scrollTo(0, 0)
}

let railSearchTimer
export function bindRailControls () {
  const input = searchInput()
  qs('#search-open').append(icon('search'))
  qs('#account-button').append(icon('user'))
  const placeholder = qs('#search-field .icon')
  if (placeholder) placeholder.replaceWith(icon('search'))
  qs('#search-clear').append(icon('x'))
  qs('#search-open').addEventListener('click', () => (ui.searching || ui.query ? closeSearchField() : openSearchField()))
  qs('#search-cancel').addEventListener('click', closeSearchField)
  qs('#search-clear').addEventListener('click', () => {
    setSearching('')
    ui.searching = true
    renderRail()
    input.focus()
  })
  qs('#account-button').addEventListener('click', () => (ui.panel === 'you' ? hidePanel() : showPanel('you')))
  qs('#home-link').addEventListener('click', () => navigate('today'))
  qs('#backup-file').addEventListener('change', ev => {
    const file = ev.target.files && ev.target.files[0]
    ev.target.value = ''
    if (file) importBackupFile(file)
  })
  // Short queries wait a little longer, so typing the first letters does not search for each one.
  input.addEventListener('input', ev => {
    clearTimeout(railSearchTimer)
    const text = ev.target.value
    railSearchTimer = setTimeout(() => { if (text.trim() !== ui.query) setSearching(text) }, activeTerms.length || text.length > 2 ? 70 : 140)
  })
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeSearchField() }
  })
}
