// Team (My plan, Team): colleagues' share links kept as named teammates on this device. Shows who
// is going to what, strong matches nobody has claimed, common free time for a meetup, and poster
// assignments, which travel in my own share link ('@' there stands for the sharer).
import { h, notify } from '../lib/dom.js'
import { nowSec, dayOf, clock, dayInfo, isOver, timeAgo } from '../lib/time.js'
import { count, newId, normalize } from '../lib/text.js'
import { eventsById, isNested, kindName } from '../data/catalog.js'
import { data, prefs, save } from '../state/store.js'
import { sanitizeTeam } from '../state/sanitize.js'
import { allPicks } from '../search/relevance.js'
import { inLocation, locationDays } from '../plan/filters.js'
import { starredIds, visitStart, visitEnd } from '../plan/clashes.js'
import { parseShareLink } from '../plan/share.js'
import { showEvent } from '../ui/overlay.js'
import { renderPage } from '../ui/shell.js'
import { dayStart, dayWindow } from './today.js'

const MEETUP_MIN_SECONDS = 45 * 60

// Adds a colleague from a share link, or refreshes the one with the same name. Throws with a
// message for the status line.
function addTeammate (typedName, link) {
  const shared = parseShareLink(link)
  const name = (typedName || shared.name || '').trim()
  if (!name) throw new Error('Add a name for this colleague.')
  const existing = data.team.find(m => normalize(m.name) === normalize(name))
  const record = {
    id: existing ? existing.id : newId(),
    name,
    starred: shared.starred,
    assignments: shared.assignments,
    busy: shared.busy,
    active: existing ? existing.active : true,
    addedAt: Date.now(),
  }
  data.team = sanitizeTeam(existing ? data.team.map(m => (m === existing ? record : m)) : [...data.team, record])
  save()
  return { refreshed: !!existing, items: shared.starred.length }
}

function removeTeammate (id) {
  const before = data.team
  data.team = data.team.filter(m => m.id !== id)
  save()
  renderPage()
  notify('Colleague removed', { action: 'Undo', run: () => { data.team = before; save(); renderPage() } })
}

function whoIsGoing (id) {
  const names = data.starred.has(id) ? ['You'] : []
  for (const m of data.team) if (m.starred.includes(id)) names.push(m.name)
  return names
}

// My own assignment wins; 'me' reads as "you", a colleague's '@' as that colleague.
function assigneeOf (id) {
  const mine = data.assignments[id]
  if (mine) return mine === 'me' ? 'you' : mine
  for (const m of data.team) {
    const theirs = m.assignments[id]
    if (theirs) return theirs === '@' ? m.name : theirs
  }
  return ''
}

function assigneePicker (e) {
  const current = data.assignments[e.id] || ''
  const assign = ev => {
    const who = ev.target.value
    if (who) data.assignments[e.id] = who
    else delete data.assignments[e.id]
    save()
    renderPage()
  }
  return h('select', { class: 'site-select', 'aria-label': `Assign “${e.title}”`, onclick: ev => ev.stopPropagation(), onchange: assign },
    h('option', { value: '' }, 'Unassigned'),
    h('option', { value: 'me', selected: current === 'me' }, 'Me'),
    data.team.map(m => h('option', { value: m.name, selected: current === m.name }, m.name)))
}

// Gaps of 45 minutes or more on `day` when I and every included teammate are free (from now on,
// if the day is today).
function commonFreeTime (day) {
  const bounds = dayWindow(day)
  const midnight = dayStart(day)
  const onDay = e => e && e.start && dayOf(e.start) === day
  const busy = []
  for (const id of starredIds()) {
    const e = eventsById.get(id)
    if (onDay(e)) busy.push([visitStart(e), visitEnd(e)])
  }
  for (const m of data.team) {
    if (!m.active) continue
    for (const id of m.starred) {
      const e = eventsById.get(id)
      if (onDay(e)) busy.push([e.start, e.end])
    }
    for (const [d, from, to] of m.busy || []) if (d === day) busy.push([midnight + from * 60, midnight + to * 60])
  }
  busy.sort((a, b) => a[0] - b[0])
  const free = []
  let cursor = Math.max(bounds.start, day === dayOf(nowSec()) ? nowSec() : 0)
  for (const [start, end] of busy) {
    if (start - cursor >= MEETUP_MIN_SECONDS) free.push([cursor, start])
    cursor = Math.max(cursor, end)
  }
  if (bounds.end - cursor >= MEETUP_MIN_SECONDS) free.push([cursor, bounds.end])
  return free
}

const teamHeading = (title, aside) => h('div', { class: 'section-head' }, h('h2', {}, title), aside === undefined ? null : h('span', { class: 'section-aside' }, aside))
const teamTimeCell = e => h('div', { class: 'item-time' }, clock(e.start), h('small', {}, dayInfo(dayOf(e.start)).weekday))

function teammateRow (m) {
  const toggle = () => { m.active = !m.active; save(); renderPage() }
  return h('div', { class: 'item is-option' },
    h('button', { class: 'checkbox', 'aria-pressed': m.active ? 'true' : 'false', title: 'Include in common free slots', onclick: toggle }, h('i')),
    h('span', { class: 'item-body' },
      h('span', { class: 'item-title' }, m.name),
      h('span', { class: 'item-meta' }, `${count(m.starred.length, 'item')}, updated ${timeAgo(m.addedAt)}`)),
    h('button', { class: 'text-button is-danger', onclick: () => removeTeammate(m.id) }, 'Remove'))
}

function colleaguesSection () {
  const nameInput = h('input', { placeholder: 'Their name', 'aria-label': 'Colleague name', maxlength: '60' })
  const linkInput = h('input', { placeholder: 'Paste their share link', 'aria-label': 'Share link' })
  const status = h('p', { class: 'status-line', 'aria-live': 'polite' })
  const add = () => {
    try {
      const result = addTeammate(nameInput.value, linkInput.value)
      renderPage()
      notify(`${result.refreshed ? 'Updated' : 'Added'}, ${count(result.items, 'item')}`)
    } catch (err) {
      status.className = 'status-line is-error'
      status.textContent = err.message
    }
  }
  const rename = ev => { prefs.displayName = ev.target.value.trim(); save() }
  return h('section', { class: 'section' },
    teamHeading('Colleagues', data.team.length ? count(data.team.length, 'person', 'people') : ''),
    h('p', { class: 'section-note' }, 'Ask each colleague for their share link (My plan, Share) and paste it here. Paste a newer link under the same name to refresh it. Links stay on this device.'),
    data.team.length ? h('div', { class: 'panel' }, data.team.map(teammateRow)) : null,
    h('div', { class: 'panel is-padded teammate-add' },
      h('div', { class: 'autocomplete-row' }, nameInput, linkInput, h('button', { class: 'button is-primary', onclick: add }, 'Add')),
      status),
    h('div', { class: 'item is-option name-field' },
      h('span', { class: 'item-body' },
        h('span', { class: 'item-title' }, 'Your name in your share link'),
        h('span', { class: 'item-meta' }, 'So colleagues see who assigned what')),
      h('input', { value: prefs.displayName || '', placeholder: 'Optional', 'aria-label': 'Your name', maxlength: '60', onchange: rename })))
}

function coverageRow (e) {
  const assignee = assigneeOf(e.id)
  return h('div', { class: 'item', 'data-cover': e.id, onclick: () => showEvent(e.id) },
    teamTimeCell(e),
    h('div', { class: 'item-body' },
      h('div', { class: 'item-title' }, e.title),
      h('div', { class: 'item-meta' }, `${whoIsGoing(e.id).join(', ') || 'Nobody yet'}${assignee ? `, assigned to ${assignee}` : ''}`)),
    isNested(e) ? assigneePicker(e) : null)
}

function unclaimedRow (e) {
  return h('div', { class: 'item is-unclaimed', onclick: () => showEvent(e.id) },
    teamTimeCell(e),
    h('div', { class: 'item-body' },
      h('div', { class: 'item-title' }, e.title),
      h('div', { class: 'item-meta' }, [kindName(e), e.room].filter(Boolean).join(', '))),
    assigneePicker(e))
}

function freeTimeRow (day) {
  const free = commonFreeTime(day)
  const info = dayInfo(day)
  return h('div', { class: 'item free-slot' },
    h('div', { class: 'item-time' }, info.weekday, h('small', {}, String(info.date))),
    h('div', { class: 'item-body' },
      h('div', { class: 'item-title' }, free.length ? free.map(([s, e]) => `${clock(s)}–${clock(e)}`).join(', ') : 'No common free slot'),
      free.length ? h('div', { class: 'item-meta' }, 'Everyone selected is free, 45 min or more') : null))
}

export function renderTeamSection (container) {
  container.append(colleaguesSection())
  if (!data.team.length) return
  const ids = new Set([...data.starred, ...data.team.flatMap(m => m.starred)])
  const going = [...ids].map(id => eventsById.get(id)).filter(e => e && e.start && inLocation(e)).sort((a, b) => a.start - b.start || a.id - b.id)
  container.append(h('section', { class: 'section' },
    teamHeading('Who is going', count(going.length, 'item')),
    h('div', { class: 'panel' }, going.slice(0, 80).map(coverageRow))))
  const unclaimed = allPicks().filter(e => e.start && inLocation(e) && !isOver(e) && !whoIsGoing(e.id).length && !assigneeOf(e.id)).slice(0, 8)
  if (unclaimed.length) {
    container.append(h('section', { class: 'section' },
      teamHeading('Nobody has claimed'),
      h('p', { class: 'section-note' }, 'Your strongest matches that no one on the team has saved or been assigned.'),
      h('div', { class: 'panel' }, unclaimed.map(unclaimedRow))))
  }
  const included = data.team.filter(m => m.active).map(m => m.name)
  container.append(h('section', { class: 'section' },
    teamHeading('Common free time', ['You', ...included].join(', ')),
    h('div', { class: 'panel' }, locationDays().map(freeTimeRow))))
}
