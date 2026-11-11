// My plan: the Agenda section (a list by day with walking estimates, or a week grid), the banner
// and read-only view for a plan opened from a share link, alternatives, clear and print. The
// People, Notes and Team sections live in people.js and team.js.
import { h, notify } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { nowSec, dayOf, minuteOfDay, dayInfo, whenLabel, isOver } from '../lib/time.js'
import { count } from '../lib/text.js'
import { eventsById, kindName, locationName } from '../data/catalog.js'
import { prefs, data, ui, save, exportData, loadData } from '../state/store.js'
import { takeSnapshot } from '../state/persistence.js'
import { inLocation, locationDays } from '../plan/filters.js'
import { visitStart, visitEnd, visitRange, overlapMinutes, invalidateClashes, clashes, dayClashes, clashText } from '../plan/clashes.js'
import { alternativesFor } from '../plan/starring.js'
import { shareMyPlan } from '../plan/share.js'
import { personalEvents, openPersonalForm } from '../plan/personal.js'
import { walkNote } from '../plan/venue.js'
import { openPlanner } from '../plan/planner.js'
import { eventItem, pageHead, emptyState, section, laneLayout, timeGrid } from '../ui/components.js'
import { openDialog, closeDialog } from '../ui/dialog.js'
import { showEvent } from '../ui/overlay.js'
import { renderPage, renderAll, navigate } from '../ui/shell.js'
import { writeHash } from '../ui/router.js'
import { planCounts, choiceGroup } from './today.js'
import { renderPeopleSection, renderNotesSection } from './people.js'
import { renderTeamSection } from './team.js'
import { openExportPanel } from './reading.js'

const MY_PLAN_TABS = [['sessions', 'Agenda'], ['people', 'People'], ['notes', 'Notes'], ['team', 'Team']]

// ui.sharedPlan holds the event ids carried by a #plan= link (an array, or the parsed link's `starred`).
function myPlanSharedIds () {
  const shared = ui.sharedPlan
  const ids = Array.isArray(shared) ? shared : (shared && shared.starred) || []
  return ids.filter(id => eventsById.has(id))
}

const myPlanViewingShared = () => !!(ui.showingShared && ui.sharedPlan)

// Put the starred set back to an earlier copy (the Undo of merge and swap).
function myPlanRestoreStarred (ids) {
  data.starred.clear()
  for (const id of ids) data.starred.add(id)
  invalidateClashes()
  save()
  renderAll()
}

function myPlanMergeShared () {
  const before = new Set(data.starred)
  for (const id of myPlanSharedIds()) data.starred.add(id)
  invalidateClashes()
  save()
  const added = data.starred.size - before.size
  ui.sharedPlan = null
  ui.showingShared = false
  prefs.planSection = 'sessions'
  navigate('plan')
  notify(`Added ${count(added, 'item')} to My plan`, { action: 'Undo', run: () => myPlanRestoreStarred(before) })
}

export function sharedPlanNotice () {
  const n = myPlanSharedIds().length
  const view = () => { ui.showingShared = true; prefs.planSection = 'sessions'; navigate('plan') }
  const dismiss = () => { ui.sharedPlan = null; ui.showingShared = false; renderAll() }
  return h('div', { class: 'notice' },
    h('div', { class: 'fill' }, h('b', {}, 'Shared plan'),
      h('div', { class: 'page-meta' }, `${count(n, 'item')}, carried in the link itself. Nothing was sent to a server.`)),
    h('button', { class: 'button', onclick: view }, 'View'),
    h('button', { class: 'button is-primary', onclick: myPlanMergeShared }, 'Add all to My plan'),
    h('button', { class: 'button', onclick: dismiss }, 'Dismiss'))
}

// What My plan lists: the shared plan while viewing it, else starred items plus my own events.
export function planEvents () {
  if (myPlanViewingShared()) return myPlanSharedIds().map(id => eventsById.get(id))
  return [...data.starred].map(id => eventsById.get(id)).filter(Boolean).concat(personalEvents())
}

export function renderPlan (container) {
  if (myPlanViewingShared()) {
    container.append(pageHead('Shared plan', null))
    myPlanAgenda(container, true)
    return
  }
  const n = planCounts()
  container.append(pageHead('My plan', [
    count(n.starred, 'saved item'),
    n.overlaps && h('span', { class: 'text-clash' }, count(n.overlaps, 'overlap')),
    n.toMeet && `${count(n.toMeet, 'person', 'people')} to meet`,
    n.notes && count(n.notes, 'note'),
  ]))
  container.append(h('div', { class: 'toggle-group is-wide', role: 'tablist', 'aria-label': 'My plan' }, MY_PLAN_TABS.map(([key, label]) => {
    const current = prefs.planSection === key ? 'true' : 'false'
    return h('button', {
      role: 'tab',
      'aria-pressed': current,
      'aria-selected': current,
      onclick: () => { prefs.planSection = key; save(); renderPage(); writeHash() },
    }, label)
  })))
  const sectionName = prefs.planSection
  if (sectionName === 'sessions') myPlanAgenda(container, false)
  else if (sectionName === 'people') renderPeopleSection(container)
  else if (sectionName === 'team') renderTeamSection(container)
  else renderNotesSection(container)
}

// Layout, share and export only once there is something to show; syncing lives under You, and
// Clear at the end of the list.
function myPlanControls (items, layout) {
  return [
    items.length ? choiceGroup('Layout', [['list', 'List'], ['week', 'Week']], layout, value => { prefs.planLayout = value; save(); renderPage() }) : null,
    h('button', { class: 'button', id: 'add-personal', onclick: () => openPersonalForm(null) }, icon('plus'), 'Event'),
    h('span', { class: 'fill' }),
    items.length ? h('button', { class: 'text-button', onclick: () => shareMyPlan() }, 'Share') : null,
    items.length ? h('button', { class: 'text-button', onclick: () => openExportPanel() }, 'Export') : null,
  ]
}

const myPlanSharedControls = () => [
  h('button', { class: 'button is-primary', onclick: myPlanMergeShared }, 'Add all to My plan'),
  h('button', { class: 'button', onclick: () => { ui.showingShared = false; renderPage() } }, 'Back to mine'),
]

function myPlanAgenda (container, shared) {
  const all = planEvents()
  const items = all.filter(e => inLocation(e))
  const elsewhere = all.length - items.length
  const layout = prefs.planLayout === 'week' ? 'week' : 'list'
  container.append(h('div', { class: 'controls' }, shared ? myPlanSharedControls() : myPlanControls(items, layout)))
  if (elsewhere) {
    container.append(h('p', { class: 'section-note' }, `${count(elsewhere, 'saved item')} at other conference sites. Change the location in the Schedule filter to see them.`))
  }
  if (!items.length) {
    container.append(emptyState('Nothing saved yet', 'Star sessions in the Schedule or in your suggestions. They appear here by day, with overlaps marked.',
      h('button', { class: 'button is-primary', onclick: () => navigate('schedule') }, 'Open the Schedule'),
      data.interests.length ? h('button', { class: 'button', onclick: () => navigate('foryou') }, 'See suggestions') : null))
    return
  }
  const timed = items.filter(e => e.start)
  const untimed = items.filter(e => !e.start)
  if (layout === 'week' && timed.length) container.append(myPlanWeek(timed, shared))
  else myPlanDays(container, timed, shared)
  if (untimed.length) container.append(section('Time not yet published', null, untimed.map(e => eventItem(e, { time: true, plan: !shared }))))
  if (!shared && data.starred.size) container.append(h('p', { class: 'plan-end' }, h('button', { class: 'text-button is-danger', onclick: myPlanClear }, 'Clear My plan')))
}

function myPlanWeekBlock (e, overlapsWith) {
  const other = overlapsWith.length ? eventsById.get(overlapsWith[0].id) : null
  const minutes = other ? overlapMinutes(e, other) : 0
  return {
    s: visitStart(e),
    e: visitEnd(e),
    m: minuteOfDay(visitStart(e)),
    dur: (visitEnd(e) - visitStart(e)) / 60,
    id: e.id,
    cflabel: overlapsWith.length > 0,
    cls: [overlapsWith.length && 'is-clash', isOver(e) && 'is-past', e.personal && 'is-personal'].filter(Boolean).join(' '),
    top: `${visitRange(e)}${other ? `, overlaps ${minutes} min` : ''}`,
    title: e.title,
    sub: e.personal ? [e.personalKindLabel, e.room].filter(Boolean).join(', ') : e.room,
    tip: `${e.title}\n${visitRange(e)}, ${e.room}${other ? `\n${clashText(other, minutes)}` : ''}`,
    onclick: () => showEvent(e.id),
  }
}

// Week timetable: one column per conference day (plus any other day with an item).
function myPlanWeek (timed, shared) {
  const clashing = shared ? new Map() : clashes()
  const days = locationDays()
  const extra = [...new Set(timed.map(e => dayOf(e.start)))].filter(k => !days.includes(k))
  const todayKey = dayOf(nowSec())
  const columns = [...days, ...extra].sort().map(k => {
    const onDay = timed.filter(e => dayOf(e.start) === k)
    const overlaps = shared ? 0 : dayClashes(k)
    const info = dayInfo(k)
    const blocks = laneLayout(onDay.map(e => myPlanWeekBlock(e, clashing.get(e.id) || [])))
    return {
      title: `${info.weekday} ${info.date}`,
      note: onDay.length ? String(onDay.length) : '',
      warn: overlaps ? count(overlaps, 'overlap') : '',
      today: k === todayKey,
      mark: k === todayKey,
      blocks,
      lanes: Math.max(1, ...blocks.map(b => b.lanes || 1)),
    }
  })
  return timeGrid(columns, { px: 0.95, colMin: 112, maxLanes: 3, minHour: 9, maxHour: 18 })
}

// List by day. Between two consecutive items: the estimated walk, flagged when the gap is shorter.
function myPlanDays (container, timed, shared) {
  const byDay = new Map()
  for (const e of [...timed].sort((a, b) => visitStart(a) - visitStart(b) || a.id - b.id)) {
    const k = dayOf(e.start)
    if (!byDay.has(k)) byDay.set(k, [])
    byDay.get(k).push(e)
  }
  for (const [k, list] of byDay) {
    const overlaps = shared ? 0 : dayClashes(k)
    const rows = []
    list.forEach((e, i) => {
      const prev = list[i - 1]
      const walk = prev && !shared && visitEnd(prev) <= visitStart(e) ? walkNote(e, prev) : null
      if (walk) rows.push(h('div', { class: 'walk-item' }, walk))
      rows.push(eventItem(e, { time: true, plan: !shared }))
    })
    const aside = overlaps ? `${count(list.length, 'item')}, ${count(overlaps, 'overlap')}` : count(list.length, 'item')
    container.append(h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, dayInfo(k).long),
        h('span', { class: 'section-aside' + (overlaps ? ' text-clash' : '') }, aside),
        !shared && data.interests.length && locationDays().includes(k)
          ? h('button', { class: 'text-button', onclick: () => openPlanner(k) }, 'Plan this day')
          : null),
      h('div', { class: 'panel' }, rows)))
  }
}

// Same item at another time first, then similar items that fit around the plan.
export function showAlternatives (e) {
  const { same, similar } = alternativesFor(e)
  const option = x => h('div', { class: 'item' },
    h('div', { class: 'item-body' },
      h('div', { class: 'item-title' }, x.title),
      h('div', { class: 'item-meta' }, [kindName(x), whenLabel(x), x.room, x.location !== e.location && locationName(x)].filter(Boolean).join(', '))),
    h('div', { class: 'item-actions' },
      h('button', { class: 'button is-small is-primary', onclick: () => { closeDialog(); myPlanSwap(e.id, x.id) } }, 'Swap in'),
      h('button', { class: 'button is-small', onclick: () => { closeDialog(); showEvent(x.id) } }, 'View')))
  const block = (heading, list, none) => h('div', { class: 'overlay-section' }, h('h3', {}, heading),
    list.length ? h('div', { class: 'panel' }, list.map(x => option(x))) : h('p', { class: 'section-note' }, none))
  const name = e.title.length > 60 ? e.title.slice(0, 58) + '…' : e.title
  openDialog(`Alternatives to “${name}”`, [
    block('Same item at another time', same, 'This item is only scheduled once.'),
    block('Similar, and free in your plan', similar, 'No similar items fit around your plan.'),
  ], [h('button', { class: 'button', onclick: () => closeDialog() }, 'Close')])
}

function myPlanSwap (fromId, toId) {
  const before = new Set(data.starred)
  data.starred.delete(fromId)
  data.starred.add(toId)
  invalidateClashes()
  save()
  renderAll()
  notify('Swapped in the alternative', { action: 'Undo', run: () => myPlanRestoreStarred(before) })
}

function myPlanClear () {
  if (!confirm(`Remove all ${data.starred.size} items from My plan? A snapshot is kept under You, Backup.`)) return
  const before = exportData()
  takeSnapshot('before clearing agenda')
  data.starred.clear()
  invalidateClashes()
  save()
  renderAll()
  notify('My plan cleared', { action: 'Undo', run: () => { loadData(before); save(); renderAll() } })
}

// Print the Agenda as a list whatever is on screen, then put the view back.
export function printPlan () {
  const saved = [ui.view, prefs.planSection, prefs.planLayout]
  ui.view = 'plan'
  prefs.planSection = 'sessions'
  prefs.planLayout = 'list'
  renderPage()
  const restore = () => {
    [ui.view, prefs.planSection, prefs.planLayout] = saved
    renderPage()
    removeEventListener('afterprint', restore)
  }
  addEventListener('afterprint', restore)
  setTimeout(() => print(), 50)
}
