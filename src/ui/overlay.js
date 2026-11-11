// The overlay: one <dialog> that shows an event, a group of events, or a panel (You, Filter, the day
// planner, changes since the last visit). Centred on wide screens, a bottom sheet on phones. At most
// one thing is shown; ui.selection and ui.panel decide what.
import { qs, h, fill, copyText } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { dayInfo } from '../lib/time.js'
import { count } from '../lib/text.js'
import { eventsById, kindName } from '../data/catalog.js'
import { data, ui } from '../state/store.js'
import { overlapping, overlapMinutes, clashText } from '../plan/clashes.js'
import { plannerPanel, applyDraftPlan } from '../plan/planner.js'
import { changesPanel } from '../plan/changes.js'
import { activeFilterCount, resetFilters, filterPanel } from '../views/schedule.js'
import { showAlternatives } from '../views/plan.js'
import { accountPanel } from '../views/settings.js'
import { observers } from './components.js'
import { eventDetailView, groupDetailView } from './detail.js'
import { renderRail } from './shell.js'
import { writeHash, pageUrl } from './router.js'

// Element that had focus before the overlay opened; focus returns there once it closes.
let overlayReturnFocus = null

// ---------- what is shown ----------
export function showEvent (id, opts = {}) {
  if (!eventsById.has(id)) return
  if (opts.push && ui.selection) ui.history.push(ui.selection)
  else if (!opts.keepStack) ui.history = []
  ui.panel = null
  ui.selection = { type: 'event', id }
  selectionChanged()
}

export function showGroup (title, ids) {
  ui.history = []
  ui.panel = null
  ui.selection = { type: 'group', title, ids }
  selectionChanged()
}

export function closeOverlay () {
  ui.selection = null
  ui.history = []
  selectionChanged()
}

export function goBack () {
  ui.selection = ui.history.pop() || null
  selectionChanged()
}

export function showPanel (name) {
  if (!ui.selection && !ui.panel) overlayReturnFocus = document.activeElement
  ui.selection = null
  ui.history = []
  ui.panel = name
  renderOverlay()
  renderRail()
  writeHash()
}

export function hidePanel () {
  ui.panel = null
  selectionChanged()
}

// Closes whatever the overlay shows (Esc, backdrop click, swipe down, the search shortcut).
export function dismissOverlay () {
  if (ui.selection || ui.panel) {
    ui.selection = null
    ui.history = []
    ui.panel = null
    selectionChanged()
  } else {
    qs('#overlay').close()
  }
}

export function selectionChanged () {
  document.querySelectorAll('.item.is-selected, .paper.is-selected, .block.is-selected').forEach(n => n.classList.remove('is-selected'))
  const picked = ui.selection
  if (picked && picked.id) document.querySelectorAll(`[data-id="${picked.id}"]`).forEach(n => n.classList.add('is-selected'))
  if (picked && !qs('#overlay').open) overlayReturnFocus = document.activeElement
  renderOverlay()
  renderRail()
  writeHash()
  if (!ui.selection && !ui.panel && overlayReturnFocus && overlayReturnFocus.isConnected) {
    overlayReturnFocus.focus({ preventScroll: true })
    overlayReturnFocus = null
  }
}

// ---------- head ----------
// Back buttons go before the title; any other extra control sits between the title and Close.
const overlayLeading = new WeakSet()
function overlayBackButton () {
  const button = h('button', { class: 'icon-button', 'aria-label': 'Back', onclick: goBack }, icon('back'))
  overlayLeading.add(button)
  return button
}

export function overlayHead (title, onClose, id, ...extra) {
  const controls = extra.filter(Boolean)
  return h('div', { class: 'overlay-head' },
    h('span', { class: 'overlay-handle', 'aria-hidden': 'true' }),
    controls.filter(x => overlayLeading.has(x)),
    h('h2', { id: id || null }, title),
    h('span', { class: 'fill' }),
    controls.filter(x => !overlayLeading.has(x)),
    h('button', { class: 'icon-button overlay-close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: onClose }, icon('x')))
}

// ---------- content ----------
const OVERLAY_TITLE_ID = 'overlay-title'

function panelParts (panel) {
  if (panel === 'you') return { head: overlayHead('You', hidePanel, OVERLAY_TITLE_ID), body: accountPanel() }
  if (panel === 'changes') return { head: overlayHead('Since your last visit', hidePanel, OVERLAY_TITLE_ID), body: changesPanel() }
  if (panel === 'filter') {
    const reset = activeFilterCount() > 0 ? h('button', { class: 'text-button', onclick: () => { resetFilters(); renderOverlay() } }, 'Reset') : null
    return {
      head: overlayHead('Filter', hidePanel, OVERLAY_TITLE_ID, reset),
      body: filterPanel(),
      foot: h('div', { class: 'overlay-foot' }, h('button', { class: 'button is-primary', onclick: hidePanel }, 'Done')),
    }
  }
  // The planner panel computes ui.plannerDraft, so the body is built before the Apply button.
  const head = overlayHead(`Plan ${dayInfo(ui.plannerDay).long}`, hidePanel, OVERLAY_TITLE_ID)
  const body = plannerPanel()
  // Counted in items, like the toast after applying: a poster visit adds each of its posters.
  const draft = ui.plannerDraft
  const adding = draft ? draft.add.reduce((sum, c) => sum + c.items.length, 0) : 0
  const removing = draft ? draft.remove.length : 0
  const label = [adding && `Add ${count(adding, 'item')}`, removing && `${adding ? 'remove' : 'Remove'} ${removing}`].filter(Boolean).join(', ')
  const foot = h('div', { class: 'overlay-foot' },
    h('button', { class: 'button', onclick: hidePanel }, 'Cancel'),
    h('button', { class: 'button is-primary', id: 'planner-apply', disabled: !(adding || removing) || null, onclick: () => applyDraftPlan(ui.plannerDraft) },
      label || 'Apply'))
  return { head, body, foot }
}

function selectionParts (picked) {
  const back = ui.history.length ? overlayBackButton() : null
  if (picked.type === 'group') return { head: overlayHead(picked.title, closeOverlay, OVERLAY_TITLE_ID, back), body: groupDetailView(picked) }
  const e = eventsById.get(picked.id)
  const copyLink = h('button', { class: 'icon-button', 'aria-label': 'Copy link to this item', title: 'Copy link', onclick: () => copyText(pageUrl() + '#e=' + e.id, 'Link copied') }, icon('link'))
  return {
    head: overlayHead(kindName(e), closeOverlay, OVERLAY_TITLE_ID, back, copyLink),
    body: eventDetailView(e),
  }
}

export function renderOverlay () {
  observers.overlay.splice(0).forEach(watcher => watcher.disconnect())
  const box = qs('#overlay')
  const { selection: picked, panel } = ui
  if (!picked && !panel) {
    if (box.open) box.close()
    box.replaceChildren()
    box.dataset.key = ''
    return
  }
  // Re-rendering the same content keeps its scroll position.
  const key = panel || `${picked.type}:${picked.id || picked.title}`
  const keptScroll = box.dataset.key === key ? (box.querySelector('.overlay-body') || {}).scrollTop || 0 : 0
  const parts = panel ? panelParts(panel) : selectionParts(picked)
  const scroller = h('div', { class: 'overlay-body' }, parts.body)
  fill(box, parts.head, scroller, parts.foot)
  box.setAttribute('aria-labelledby', OVERLAY_TITLE_ID)
  box.dataset.kind = panel || picked.type
  box.dataset.key = key
  if (!box.open) box.showModal()
  scroller.scrollTop = keptScroll
  if (!keptScroll && !panel) {
    const close = box.querySelector('.overlay-head .overlay-close')
    if (close) close.focus({ preventScroll: true })
  }
}

// Starred items running at the same time as e (shown in event details, refreshed on star changes).
export function clashSection (e) {
  if (!e || !e.start) return ''
  const others = [...data.starred].map(id => eventsById.get(id)).filter(o => overlapping(o, e))
  if (!others.length) return ''
  const starred = data.starred.has(e.id)
  return h('div', null,
    h('h4', { class: 'is-warn' }, starred ? `Overlaps in your plan (${others.length})` : `At the same time in your plan (${others.length})`,
      h('span', { class: 'fill' }), starred ? h('button', { class: 'inline-link', onclick: () => showAlternatives(e) }, 'Alternatives') : null),
    others.map(o => h('button', { class: 'clash-label', onclick: () => showEvent(o.id, { push: true }) },
      icon('warn'), h('span', null, clashText(o, overlapMinutes(o, e))))))
}

// ---------- dialog behaviour ----------
// All three dialogs close on Esc (native), a click on the backdrop and, on phones, a downward swipe
// that starts on the head.
function closeDialogBox (box) {
  if (box.id === 'overlay') dismissOverlay()
  else box.close()
}

function attachSwipeToClose (box) {
  let startY = null
  let offset = 0
  let pointer = null
  box.addEventListener('pointerdown', ev => {
    if (!matchMedia('(max-width: 640px)').matches) return
    if (!ev.target.closest('.overlay-head, .overlay-handle') || ev.target.closest('button, a, input')) return
    startY = ev.clientY
    offset = 0
    pointer = ev.pointerId
    box.setPointerCapture(pointer)
    box.classList.add('is-dragging')
  })
  box.addEventListener('pointermove', ev => {
    if (startY === null || ev.pointerId !== pointer) return
    offset = Math.max(0, ev.clientY - startY)
    box.style.transform = `translateY(${offset}px)`
  })
  const release = ev => {
    if (startY === null || (ev && ev.pointerId !== pointer)) return
    startY = null
    box.classList.remove('is-dragging')
    box.style.transform = ''
    if (offset > 90) closeDialogBox(box)
    offset = 0
  }
  box.addEventListener('pointerup', release)
  box.addEventListener('pointercancel', release)
  box.addEventListener('lostpointercapture', release)
}

export function bindOverlayGestures () {
  for (const box of [qs('#overlay'), qs('#dialog'), qs('#shortcuts')]) {
    // close fires asynchronously: if the overlay was reopened meanwhile, the new content stays.
    box.addEventListener('close', () => {
      if (box.id === 'overlay' && !box.open && (ui.selection || ui.panel)) {
        ui.selection = null
        ui.history = []
        ui.panel = null
        selectionChanged()
      }
    })
    box.addEventListener('click', ev => { if (ev.target === box) closeDialogBox(box) })
    attachSwipeToClose(box)
  }
}
