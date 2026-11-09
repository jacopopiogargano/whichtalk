// Entry point: global listeners and boot. First render is synchronous and fast; the search index,
// interest scores, storage reconciliation, a pending sync link and change detection follow when idle.
import { BOOT_STARTED } from './lib/env.js'
import { qs, notify } from './lib/dom.js'
import { setZoneOffset, dayOf, nowSec } from './lib/time.js'
import { LOCATIONS } from './data/conference.js'
import { prefs, data, ui, onDataReplaced } from './state/store.js'
import { restoreFromDatabase, flushPendingWrite } from './state/persistence.js'
import { ensureHaystack, ensureTermIndex, termIndex, prepareAutocomplete } from './search/index.js'
import { rescore } from './search/relevance.js'
import { activeTerms, locationDays, hasUnscheduled } from './plan/filters.js'
import { invalidateClashes } from './plan/clashes.js'
import { toggleStar } from './plan/starring.js'
import { rebuildPersonalEvents } from './plan/personal.js'
import { detectChanges } from './plan/changes.js'
import { receiveSyncLink } from './views/sync.js'
import { renderAll, renderPage, navigate, chooseDay, pickDefaultDay, openSearchField, closeSearchField, bindRailControls } from './ui/shell.js'
import { bindOverlayGestures, dismissOverlay } from './ui/overlay.js'
import { readHash, takePendingSync, NAV_TABS } from './ui/router.js'

const isDialogOpen = selector => qs(selector).open
const runWhenIdle = task => (window.requestIdleCallback ? requestIdleCallback(task) : setTimeout(task, 200))

function applyPendingSync () {
  const payload = takePendingSync()
  if (payload) receiveSyncLink(payload)
}

function stepScheduleDay (direction) {
  if (ui.view !== 'schedule' || activeTerms.length) return
  const days = locationDays().concat(hasUnscheduled() ? ['tba'] : [])
  const here = days.indexOf(prefs.day)
  const target = Math.max(0, Math.min(days.length - 1, here + direction))
  if (target !== here) chooseDay(days[target])
}

// / or Cmd/Ctrl+K search, s stars the open event, Esc clears the search, arrows change the Schedule
// day, 1-3 switch sections, ? lists the shortcuts. Nothing fires while a dialog is open.
function handleShortcut (ev) {
  if (isDialogOpen('#dialog') || isDialogOpen('#shortcuts')) return
  const active = document.activeElement
  const typing = !!active && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)
  if ((ev.key === 'k' && (ev.metaKey || ev.ctrlKey)) || (ev.key === '/' && !typing)) {
    ev.preventDefault()
    if (isDialogOpen('#overlay')) dismissOverlay()
    openSearchField()
    return
  }
  if (isDialogOpen('#overlay')) {
    if (ev.key === 's' && !typing && ui.selection && ui.selection.type === 'event') toggleStar(ui.selection.id)
    return
  }
  if (ev.key === 'Escape') {
    if (ui.searching || ui.query) closeSearchField()
    return
  }
  if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return
  if (ev.key === 'ArrowLeft') stepScheduleDay(-1)
  else if (ev.key === 'ArrowRight') stepScheduleDay(1)
  else if (/^[1-3]$/.test(ev.key)) navigate(NAV_TABS[Number(ev.key) - 1].key)
  else if (ev.key === '?') qs('#shortcuts').showModal()
}

// Once a minute, redraw views that show "now" (Today, today's Schedule) unless the user is busy.
function refreshClockViews () {
  if (document.visibilityState !== 'visible' || activeTerms.length || isDialogOpen('#overlay') || isDialogOpen('#dialog')) return
  if (document.querySelector('#page input:focus, #page textarea:focus')) return
  if (ui.view === 'today' || (ui.view === 'schedule' && prefs.day === dayOf(nowSec()))) {
    const y = scrollY
    renderPage()
    scrollTo(0, y)
  }
}

// ---------- listeners ----------
// The debounced IndexedDB write must land before the page goes away.
addEventListener('pagehide', () => flushPendingWrite())
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPendingWrite() })
bindOverlayGestures()
bindRailControls()
document.addEventListener('keydown', handleShortcut)
addEventListener('hashchange', () => {
  readHash()
  renderAll()
  applyPendingSync()
})
// Hosted copies are rebuilt regularly: reload when coming back to a tab that has been open a while.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || performance.now() - BOOT_STARTED <= 30 * 60 * 1000) return
  if (!isDialogOpen('#dialog') && !isDialogOpen('#overlay')) location.reload()
})
setInterval(refreshClockViews, 60 * 1000)
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {})

// ---------- boot ----------
readHash()
setZoneOffset(LOCATIONS[prefs.location].tz)
const bootToday = dayOf(nowSec())
if (!new URLSearchParams(location.hash.slice(1)).has('d') && locationDays().includes(bootToday)) prefs.day = bootToday
if (!prefs.day || (prefs.day !== 'tba' && !locationDays().includes(prefs.day))) prefs.day = pickDefaultDay()
rebuildPersonalEvents()
onDataReplaced(() => {
  rebuildPersonalEvents()
  invalidateClashes()
  rescore()
})
renderAll()
performance.mark('app-ready')
window.__bootMs = Math.round(performance.now() - BOOT_STARTED)

runWhenIdle(async () => {
  ensureHaystack()
  ensureTermIndex()
  if (data.interests.length) { rescore(); renderAll() }
  window.__indexMs = termIndex.ms
  runWhenIdle(() => prepareAutocomplete())
  if (await restoreFromDatabase()) {
    renderAll()
    notify('Restored your data from on-device storage')
  }
  applyPendingSync()
  const seenBuild = prefs.changeLog && prefs.changeLog.to
  await detectChanges()
  if (prefs.changeLog && prefs.changeLog.to !== seenBuild && ui.view === 'today' && !activeTerms.length) renderPage()
  window.__ready = true
})
