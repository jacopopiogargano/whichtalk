// Today: what is next, the plan in four numbers, the focus day as an hour strip over one list
// (a "Now" rule, free gaps that offer picks), three pick cards and people to meet. Also the
// "Suggested for you" page opened from Today, and day helpers shared with My plan and the planner.
import { h } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { nowSec, dayOf, clock, dayInfo, whenLabel, isOngoing, isOver, countdown, timeAgo } from '../lib/time.js'
import { num, count, normalize } from '../lib/text.js'
import { eventsById, kindName } from '../data/catalog.js'
import { LOCATIONS, CONFERENCE_NAME, CONFERENCE_SHORT, HIDDEN_TRACKS } from '../data/conference.js'
import { prefs, data, ui, save } from '../state/store.js'
import { downloadBackup, backupDue } from '../state/persistence.js'
import { ensureTermIndex } from '../search/index.js'
import { SCORES, rankedPicks, allPicks } from '../search/relevance.js'
import { inLocation, inTracks, passesPast, passesFocus, memo, topLevel, locationDays, dayTitle } from '../plan/filters.js'
import { clashPairs } from '../plan/clashes.js'
import { bestPicks, addBestPicks } from '../plan/starring.js'
import { personalEvents } from '../plan/personal.js'
import { openPlanner } from '../plan/planner.js'
import { changeSummary } from '../plan/changes.js'
import { eventItem, pickCard, lazyList, pageHead, emptyState, section } from '../ui/components.js'
import { showEvent, showPanel } from '../ui/overlay.js'
import { renderPage, navigate, chooseDay } from '../ui/shell.js'
import { whereabouts, openPeopleExport } from './people.js'
import { focusDayPanel, starredOnDay } from './focus-day.js'

export function planCounts () {
  let notes = 0
  let openTodos = 0
  for (const person of data.people) {
    notes += person.notes.length
    for (const note of person.notes) openTodos += note.todos.filter(todo => !todo.done).length
  }
  const withStatus = status => data.people.filter(person => person.status === status).length
  return {
    starred: [...data.starred].filter(id => { const e = eventsById.get(id); return !!e && inLocation(e) }).length,
    overlaps: clashPairs(inLocation).length,
    toMeet: withStatus('to-meet'),
    met: withStatus('met'),
    notes,
    openTodos,
    interests: data.interests.length,
  }
}

// A row of mutually exclusive buttons marked with aria-pressed (List / Week, Ranked / By day).
export function choiceGroup (label, choices, current, pick) {
  return h('div', { class: 'toggle-group', role: 'group', 'aria-label': label },
    choices.map(([value, text]) => h('button', { 'aria-pressed': value === current ? 'true' : 'false', onclick: () => pick(value) }, text)))
}

export const nowRule = t => h('div', { class: 'now-rule', id: 'now-rule' }, h('span', {}, 'Now'), h('span', {}, clock(t)))

// First start and last end at the current location, breaks (hidden tracks) left out.
const todaySpan = () => memo('window', () => {
  let first = Infinity
  let last = 0
  for (const e of topLevel()) {
    if (!e.start || HIDDEN_TRACKS.has(e.track)) continue
    first = Math.min(first, e.start)
    last = Math.max(last, e.end)
  }
  return { first, last }
})

function todayPhase () {
  const t = nowSec()
  const { first, last } = todaySpan()
  if (t < first) return 'before'
  return t >= last ? 'after' : 'during'
}

// Before the conference: its first day; after it: its last; during: today, or the next day with sessions.
function todayFocusDay (phase) {
  const days = locationDays()
  const lastDay = days[days.length - 1]
  if (phase === 'before') return days[0]
  if (phase === 'after') return lastDay
  const k = dayOf(nowSec())
  return days.includes(k) ? k : (days.find(d => d > k) || lastDay)
}

export const starredEvents = () => [...data.starred]
  .map(id => eventsById.get(id))
  .filter(e => e && inLocation(e))
  .concat(personalEvents())

export const dayStart = k => Date.parse(k + 'T00:00:00Z') / 1000 - LOCATIONS[prefs.location].tz * 3600

// First start and last end of the day's schedule; 8:00 to 19:00 when nothing is scheduled.
export const dayWindow = k => memo('bounds' + k, () => {
  const midnight = dayStart(k)
  let start = Infinity
  let end = 0
  for (const e of topLevel()) {
    if (!e.start || HIDDEN_TRACKS.has(e.track) || dayOf(e.start) !== k) continue
    start = Math.min(start, e.start)
    end = Math.max(end, Math.min(e.end, midnight + 23 * 3600))
  }
  if (start === Infinity) return { start: midnight + 8 * 3600, end: midnight + 19 * 3600 }
  return { start, end }
})

const todayOpenPlan = name => { prefs.planSection = name; navigate('plan') }

function todayNudges (phase, k) {
  const counts = planCounts()
  const nudge = (label, run) => h('button', { class: 'nudge', onclick: run }, label)
  const out = []
  // Overlaps already show in the numbers above, so they are not repeated here.
  if (counts.openTodos) out.push(nudge(count(counts.openTodos, 'open follow-up'), () => todayOpenPlan('notes')))
  if (data.interests.length && SCORES && !starredOnDay(k).length && phase !== 'after') {
    out.push(nudge(`Add top picks for ${phase === 'before' ? 'Day 1' : 'the day'}`, () => addBestPicks([k])))
  }
  if (backupDue()) {
    out.push(nudge(prefs.lastBackupAt ? `Last backup ${timeAgo(prefs.lastBackupAt)}. Back up` : 'Back up your data', () => downloadBackup()))
  }
  return out.length ? h('p', { class: 'nudges' }, out) : null
}

const todayShortTitle = e => (e.title.length > 110 ? e.title.slice(0, e.title.lastIndexOf(' ', 108)) + '…' : e.title)

function todayNextUp (phase) {
  if (phase !== 'during') return null
  const t = nowSec()
  const ahead = starredEvents().filter(e => e.start && e.end > t).sort((a, b) => a.start - b.start)
  const live = ahead.find(e => isOngoing(e))
  const next = ahead.find(e => e.start > t)
  const line = (label, e, time) => h('button', { class: 'next-up' + (label === 'Now' ? ' is-live' : ''), onclick: () => showEvent(e.id) },
    h('span', { class: 'next-up-body' },
      h('span', { class: 'visually-hidden' }, `${label}: `),
      h('span', { class: 'next-up-title' }, todayShortTitle(e)),
      h('span', { class: 'next-up-meta' }, [kindName(e), e.room].filter(Boolean).join(' · '))),
    h('span', { class: 'next-up-tag' }, h('b', { 'aria-hidden': 'true' }, label), h('span', {}, time)))
  if (!live && !next) return h('p', { class: 'next-quiet' }, 'Nothing else in your plan today.')
  return h('div', { class: 'next-board' },
    live ? line('Now', live, `until ${clock(live.end)}`) : null,
    next ? line('Next', next, dayOf(next.start) === dayOf(t) ? clock(next.start) : whenLabel(next)) : null)
}

// The plan in four numbers. Each cell opens the place where its number changes; an empty cell
// says what to do instead.
function todayTally () {
  const n = planCounts()
  const cell = (label, value, note, run, modifier) => h('button', { class: 'tally-cell', onclick: run },
    h('span', { class: 'tally-label' }, label),
    h('span', { class: 'tally-value' + (modifier ? ' ' + modifier : '') }, num(value)),
    h('span', { class: 'tally-note' }, note))
  const toSessions = () => todayOpenPlan('sessions')
  return h('div', { class: 'tally', role: 'group', 'aria-label': 'Your plan' },
    cell('Saved', n.starred, n.starred ? 'Sessions in your plan' : 'Star sessions in the schedule',
      n.starred ? toSessions : () => navigate('schedule'), n.starred ? '' : 'is-zero'),
    cell('Overlaps', n.overlaps, n.overlaps ? 'Resolve them in My plan' : 'Nothing clashes', toSessions, n.overlaps ? 'is-warn' : 'is-zero'),
    cell('People to meet', n.toMeet, n.toMeet || n.met ? `${num(n.met)} met so far` : 'Add people to meet',
      () => todayOpenPlan('people'), n.toMeet ? '' : 'is-zero'),
    cell('Interests', n.interests, n.interests ? 'Ranking every session' : 'Add your interests', () => showPanel('you'), n.interests ? '' : 'is-zero'))
}

function todayRecap () {
  const n = planCounts()
  const line = (value, label, run) => h('button', { class: 'item item-link', onclick: run },
    h('div', { class: 'item-body' }, h('div', { class: 'item-title' }, label)),
    h('span', { class: 'item-count' }, typeof value === 'number' ? num(value) : value),
    h('span', { class: 'item-chevron' }, icon('chev')))
  return [
    section('Recap', null,
      line(n.starred, 'Saved sessions', () => todayOpenPlan('sessions')),
      line(`${n.met} of ${n.met + n.toMeet}`, 'People met', () => todayOpenPlan('people')),
      line(n.notes, 'Meeting notes', () => todayOpenPlan('notes')),
      line(n.openTodos, 'Open follow-ups', () => todayOpenPlan('notes'))),
    h('div', { class: 'actions' },
      h('button', { class: 'button is-primary', onclick: () => openPeopleExport(), disabled: !data.people.length }, 'Export people and notes'),
      h('button', { class: 'button', onclick: () => downloadBackup() }, 'Back up')),
  ]
}

function todayPicksSection (k, offered) {
  const hasInterests = data.interests.length > 0
  let body
  if (!hasInterests) {
    body = h('div', { class: 'panel is-padded' },
      h('p', {}, 'Add a few interests and the best matches for each day appear here.'),
      h('button', { class: 'button is-primary', onclick: () => showPanel('you') }, 'Add interests'))
  } else if (!SCORES) {
    body = h('div', { class: 'pick-grid' }, [0, 1, 2].map(() => h('div', { class: 'pick-card is-skeleton' })))
  } else {
    const picks = allPicks()
      .filter(e => e.start && dayOf(e.start) === k && !data.starred.has(e.id) && !isOver(e) && inTracks(e) && !offered.has(e.id))
      .slice(0, 3)
    body = picks.length ? h('div', { class: 'pick-grid' }, picks.map(e => pickCard(e))) : h('p', { class: 'section-note' }, 'No more suggestions for this day.')
  }
  return h('section', { class: 'section today-picks' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Suggested for you'),
      hasInterests ? h('button', { class: 'text-button', onclick: () => navigate('foryou') }, 'See all') : null),
    body)
}

function todayMeetSection (k) {
  const found = []
  for (const person of data.people) {
    if (person.status !== 'to-meet') continue
    const spot = whereabouts(person).find(e => e.start && dayOf(e.start) === k && !isOver(e))
    if (spot) found.push({ person, e: spot })
  }
  if (!found.length) return null
  return section('People to meet', ['All people', () => todayOpenPlan('people')],
    found.slice(0, 6).map(({ person, e }) => h('button', { class: 'item item-link is-wanted', onclick: () => showEvent(e.id) },
      h('div', { class: 'item-time' }, clock(e.start)),
      h('div', { class: 'item-body' },
        h('div', { class: 'item-title' }, person.name),
        h('div', { class: 'item-meta' }, [kindName(e), e.room].filter(Boolean).join(', ')),
        h('div', { class: 'item-people' }, e.title)),
      h('span', { class: 'item-chevron' }, icon('chev')))))
}

export function renderToday (container) {
  const phase = todayPhase()
  const k = todayFocusDay(phase)
  const t = nowSec()
  const days = locationDays()
  const isToday = phase === 'during' && dayOf(t) === k
  const loc = LOCATIONS[prefs.location]
  let title = `${CONFERENCE_NAME} has ended`
  let meta = 'Your plan, people and notes stay here.'
  if (phase === 'during') {
    title = dayInfo(k).long
    meta = [dayTitle(k), `${clock(t)} ${loc.zone}`, loc.venue].filter(Boolean).join(', ')
  } else if (phase === 'before') {
    title = `${CONFERENCE_SHORT} starts ${countdown(todaySpan().first - t)}`
    meta = `${dayInfo(days[0]).long} to ${dayInfo(days[days.length - 1]).long}, ${loc.venue || loc.name}`
  }
  const changes = changeSummary()
  container.append(h('section', { class: 'intro' },
    h('h1', { class: 'intro-title' }, title),
    h('p', { class: 'intro-meta' }, meta),
    todayNextUp(phase),
    phase === 'after' ? null : todayTally(),
    todayNudges(phase, k),
    changes ? h('button', { class: 'changes-link', onclick: () => showPanel('changes') }, changes) : null))
  if (phase === 'after') {
    container.append(...todayRecap())
    return
  }
  const heading = isToday ? 'Your day' : phase === 'before' ? `Day 1, ${dayInfo(k).long}` : dayInfo(k).long
  const offered = new Set()
  container.append(h('section', { class: 'section today-plan' },
    h('div', { class: 'section-head' }, h('h2', {}, heading),
      data.interests.length ? h('button', { class: 'text-button', onclick: () => openPlanner(k) }, 'Plan my day') : null,
      h('button', { class: 'text-button', onclick: () => chooseDay(k) }, 'Full schedule')),
    starredOnDay(k).length ? null
      : h('p', { class: 'section-note' }, SCORES ? 'Nothing saved for this day yet. Free time below shows suggestions.' : 'Nothing saved for this day yet.'),
    focusDayPanel(k, isToday, offered)))
  container.append(todayPicksSection(k, offered))
  const meet = todayMeetSection(k)
  if (meet) container.append(meet)
}

// ---------- "Suggested for you" (opened from Today) ----------
export function renderPicks (container) {
  ensureTermIndex()
  const back = h('button', { class: 'crumb', onclick: () => navigate('today') }, icon('back'), 'Today')
  const editInterests = (label, cls) => h('button', { class: cls, onclick: () => showPanel('you') }, label)
  if (!data.interests.length) {
    container.append(back, pageHead('Suggested for you', 'Add interests to rank every session for you.', editInterests('Add interests', 'button is-primary')))
    return
  }
  const active = data.interests.filter(it => it.active).length
  const list = rankedPicks(e => inLocation(e) && inTracks(e) && passesPast(e) && passesFocus(e))
  const focus = ui.focusInterest && data.interests.find(it => normalize(it.text) === ui.focusInterest)
  const summary = focus
    ? `${count(list.length, 'suggestion')} matching “${focus.text}”`
    : `${count(list.length, 'suggestion')} from ${count(active, 'active interest')}`
  container.append(back, pageHead('Suggested for you', [summary],
    choiceGroup('Layout', [['ranked', 'Ranked'], ['by-day', 'By day']], prefs.picksLayout, value => { prefs.picksLayout = value; save(); renderPage() }),
    list.length ? h('button', { class: 'button is-primary', onclick: () => addBestPicks(locationDays()) }, 'Add top picks') : null,
    editInterests('Edit interests', 'button')))
  if (!active) { container.append(emptyState('All interests are paused', 'Resume one under You, Interests.')); return }
  if (!list.length) { container.append(emptyState('No suggestions yet', 'Try broader interests, or show more session types in the Schedule filter.')); return }
  if (prefs.picksLayout === 'by-day') {
    for (const k of locationDays()) {
      const onDay = list.filter(e => e.start && dayOf(e.start) === k)
      if (!onDay.length) continue
      const { chosen } = bestPicks(k)
      container.append(h('section', { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', {}, dayInfo(k).long),
          chosen.length
            ? h('button', { class: 'text-button', onclick: () => addBestPicks([k]) }, `Add ${chosen.length} top picks`)
            : h('span', { class: 'section-aside' }, 'Top picks saved')),
        h('div', { class: 'panel' }, onDay.slice(0, 8).map(e => eventItem(e, { suggest: true, time: true })))))
    }
    return
  }
  const box = h('div', { class: 'panel' })
  container.append(h('section', { class: 'section' }, box))
  lazyList(box, list, e => eventItem(e, { suggest: true, showDay: true, time: true }), 'page', 36)
}
