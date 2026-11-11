// Plan my day: a draft for one day from interest scores, by weighted interval scheduling with a cap
// on the number of items (the pace). Starred items and personal events are locked unless the user
// lets the plan replace starred ones; personal events always stay. Candidates must leave the lunch
// window free (optional) and, when the venue has a walking model, enough estimated walking time
// between rooms. A poster session counts as one flexible visit of up to an hour, placed at the first
// free half-hour start inside the session and carrying its three best-matching posters. The draft is
// previewed as adds and removes, then applied with Undo.
import { prefs, data, ui, save } from '../state/store.js'
import { h, notify } from '../lib/dom.js'
import { count } from '../lib/text.js'
import { nowSec, dayOf, dayInfo, clock, isOver } from '../lib/time.js'
import { eventsById, isNested, isGroupEvent, childNoun, kindName } from '../data/catalog.js'
import { VENUE } from '../data/conference.js'
import { SCORES, allPicks } from '../search/relevance.js'
import { showPanel, hidePanel, renderOverlay } from '../ui/overlay.js'
import { renderAll } from '../ui/shell.js'
import { dayStart } from '../views/today.js'
import { inTracks } from './filters.js'
import { starredIds, visitStart, visitEnd, invalidateClashes } from './clashes.js'
import { walkingMinutes } from './venue.js'
import { hhmm, parseHhmm } from './personal.js'

const PACE_LIMITS = { relaxed: 4, normal: 6, packed: 9 }
const POSTER_VISIT_SECONDS = 3600
const POSTER_STEP_SECONDS = 1800
const POSTER_WEIGHTS = [1, 0.6, 0.4]
const KEEP_BONUS = 1.5
const POOL_SIZE = 160

const plannerScore = e => (SCORES ? SCORES[e.idx] || 0 : 0)
const byPlannerKey = (a, b) => (a.key < b.key ? -1 : 1)

// Candidate: { start, end, room, weight, items, key, block?, kept? }
function draftPlanForDay (day, options) {
  const startedAt = performance.now()
  const now = nowSec()
  const midnight = dayStart(day)
  const lunch = options.lunch ? [midnight + options.lunchFrom * 60, midnight + options.lunchTo * 60] : null
  const walkSeconds = (a, b) => (options.walking ? (walkingMinutes(a.room, b.room) || 0) * 60 : 0)
  const apart = (a, b) => a.end + walkSeconds(a, b) <= b.start || b.end + walkSeconds(b, a) <= a.start

  const onDay = starredIds().map(id => eventsById.get(id)).filter(e => e && e.start && dayOf(e.start) === day)
  const locked = onDay.filter(e => e.personal || options.keepStarred)
    .map(e => ({ start: visitStart(e), end: visitEnd(e), room: e.room }))
  const replaceable = options.keepStarred ? [] : onDay.filter(e => !e.personal)
  const allowed = c => c.start >= now && locked.every(l => apart(l, c)) &&
    !(lunch && c.start < lunch[1] && lunch[0] < c.end)

  const candidates = []
  const postersBySession = new Map()
  for (const e of allPicks()) {
    if (!e.start || dayOf(e.start) !== day || data.starred.has(e.id) || !inTracks(e) || isOver(e)) continue
    const session = isNested(e) ? eventsById.get(e.parentId) : null
    if (session && isGroupEvent(session)) {
      if (!postersBySession.has(session.id)) postersBySession.set(session.id, [])
      postersBySession.get(session.id).push(e)
      continue
    }
    const c = { start: e.start, end: e.end, room: e.room, weight: plannerScore(e), items: [e], key: String(e.id) }
    if (allowed(c)) candidates.push(c)
  }
  for (const [sessionId, posters] of postersBySession) {
    const session = eventsById.get(sessionId)
    const best = posters.sort((a, b) => plannerScore(b) - plannerScore(a) || a.id - b.id).slice(0, POSTER_WEIGHTS.length)
    const weight = best.reduce((sum, x, i) => sum + plannerScore(x) * POSTER_WEIGHTS[i], 0)
    const length = Math.min(POSTER_VISIT_SECONDS, session.end - session.start)
    for (let start = session.start; start + length <= session.end; start += POSTER_STEP_SECONDS) {
      const c = { start, end: start + length, room: session.room, weight, items: best, key: 'p' + sessionId, block: true }
      if (allowed(c)) { candidates.push(c); break }
    }
  }
  // Already-starred items compete too, with a bonus so the plan does not churn without reason.
  for (const e of replaceable) {
    candidates.push({ start: visitStart(e), end: visitEnd(e), room: e.room, weight: plannerScore(e) + KEEP_BONUS, items: [e], key: String(e.id), kept: true })
  }

  candidates.sort((a, b) => b.weight - a.weight || a.start - b.start || byPlannerKey(a, b))
  const pool = candidates.slice(0, POOL_SIZE).sort((a, b) => a.end - b.end || a.start - b.start || byPlannerKey(a, b))
  const chosen = heaviestPlanChain(pool, Math.max(0, PACE_LIMITS[options.pace] - locked.length), walkSeconds)
  const keepIds = new Set(chosen.flatMap(c => c.items.map(x => x.id)))
  return {
    day,
    add: chosen.filter(c => !c.kept),
    remove: replaceable.filter(e => !keepIds.has(e.id)),
    locked,
    ms: performance.now() - startedAt,
  }
}

// Heaviest chain of at most `cap` compatible candidates from a pool sorted by end time.
// total[j][n] is the best weight of a chain of n items ending with pool[j], or -1.
function heaviestPlanChain (pool, cap, walkSeconds) {
  if (cap < 1) return []
  const size = pool.length
  const total = Array.from({ length: size }, () => new Float64Array(cap + 1).fill(-1))
  const prev = Array.from({ length: size }, () => new Int32Array(cap + 1).fill(-1))
  let top = { weight: 0, j: -1, n: 0 }
  for (let j = 0; j < size; j++) {
    const b = pool[j]
    total[j][1] = b.weight
    for (let i = 0; i < j; i++) {
      const a = pool[i]
      if (a.end + walkSeconds(a, b) > b.start) continue
      for (let n = 2; n <= cap; n++) {
        if (total[i][n - 1] < 0) continue
        const weight = total[i][n - 1] + b.weight
        if (weight > total[j][n] + 1e-9) { total[j][n] = weight; prev[j][n] = i }
      }
    }
    for (let n = 1; n <= cap; n++) if (total[j][n] > top.weight + 1e-9) top = { weight: total[j][n], j, n }
  }
  const chain = []
  for (let j = top.j, n = top.n; j >= 0 && n > 0; n--) { chain.push(pool[j]); j = prev[j][n] }
  return chain.reverse()
}

export function applyDraftPlan (draft) {
  const before = { starred: [...data.starred], windows: { ...data.visitWindows } }
  for (const e of draft.remove) {
    data.starred.delete(e.id)
    delete data.visitWindows[e.id]
  }
  for (const c of draft.add) {
    for (const x of c.items) {
      data.starred.add(x.id)
      if (c.block) data.visitWindows[x.id] = [c.start, c.end]
    }
  }
  invalidateClashes()
  save()
  hidePanel()
  renderAll()
  const added = draft.add.reduce((sum, c) => sum + c.items.length, 0)
  notify(`Plan applied: ${count(added, 'item')} added${draft.remove.length ? `, ${draft.remove.length} removed` : ''}`, {
    action: 'Undo',
    run: () => {
      data.starred.clear()
      for (const id of before.starred) data.starred.add(id)
      data.visitWindows = before.windows
      invalidateClashes()
      save()
      renderAll()
    },
  })
}

export function openPlanner (day) {
  ui.plannerDay = day
  showPanel('plan')
}

function plannerDraftRow (c, adding) {
  const first = c.items[0]
  const session = c.block ? eventsById.get(first.parentId) : null
  const title = session ? `Poster visit, ${session.title}` : first.title
  const meta = session
    ? `${clock(c.start)}–${clock(c.end)}, ${count(c.items.length, 'matching ' + childNoun(session).one)}, ${c.room}`
    : [kindName(first), c.room].filter(Boolean).join(', ')
  return h('div', { class: adding ? 'item is-plan-add' : 'item is-plan-remove' },
    h('div', { class: 'item-time' }, clock(c.start), h('small', {}, adding ? 'Add' : 'Remove')),
    h('div', { class: 'item-body' }, h('div', { class: 'item-title' }, title), h('div', { class: 'item-meta' }, meta)))
}

// Overlay body: the options, then the preview. Changing an option recomputes the draft at once.
export function plannerPanel () {
  const day = ui.plannerDay
  const options = prefs.plannerOptions
  if (!data.interests.length) {
    return [
      h('p', { class: 'section-note' }, 'Add interests first: the plan ranks sessions by how well they match them.'),
      h('button', { class: 'button is-primary', onclick: () => showPanel('you') }, 'Add interests'),
    ]
  }
  const draft = draftPlanForDay(day, options)
  ui.plannerDraft = draft
  const change = (key, value) => { options[key] = value; save(); renderOverlay() }
  const title = text => h('span', { class: 'item-body' }, h('span', { class: 'item-title' }, text))
  const toggle = (key, label) => h('button', {
    class: 'item is-option', role: 'switch', 'aria-checked': options[key] ? 'true' : 'false', onclick: () => change(key, !options[key]),
  }, title(label), h('span', { class: 'toggle' }))
  const lunchInput = (key, label) => h('input', {
    type: 'time', value: hhmm(options[key]), step: '900', 'aria-label': label,
    onchange: ev => { const minutes = parseHhmm(ev.target.value); if (Number.isFinite(minutes)) change(key, minutes) },
  })
  const pace = h('div', { class: 'toggle-group', role: 'group', 'aria-label': 'Pace' }, Object.keys(PACE_LIMITS).map(p =>
    h('button', { 'aria-pressed': options.pace === p ? 'true' : 'false', onclick: () => change('pace', p) }, p[0].toUpperCase() + p.slice(1))))
  const removals = draft.remove.map(e => ({ start: visitStart(e), end: visitEnd(e), room: e.room, items: [e] }))
  return [
    h('p', { class: 'section-note' }, `A draft for ${dayInfo(day).long} from your interests. Nothing changes until you apply it.`),
    h('div', { class: 'overlay-section' }, h('h3', {}, 'Options'), h('div', { class: 'panel' },
      h('div', { class: 'item is-option' }, title('Pace'), pace),
      toggle('keepStarred', 'Keep everything already saved'),
      toggle('lunch', 'Keep a lunch break'),
      options.lunch
        ? h('div', { class: 'item is-option' }, title('Lunch window'),
          h('span', { class: 'time-range' }, lunchInput('lunchFrom', 'Lunch starts'), h('span', {}, 'to'), lunchInput('lunchTo', 'Lunch ends')))
        : null,
      VENUE ? toggle('walking', 'Leave walking time between rooms') : null)),
    h('div', { class: 'overlay-section' }, h('h3', {}, 'Preview'),
      draft.add.length || draft.remove.length
        ? h('div', { class: 'panel' }, draft.add.map(c => plannerDraftRow(c, true)), removals.map(c => plannerDraftRow(c, false)))
        : h('p', { class: 'section-note' }, 'Nothing to change: your day already fits these options.'),
      draft.locked.length || VENUE
        ? h('p', { class: 'section-note' }, [draft.locked.length && `${count(draft.locked.length, 'item')} kept as is.`, VENUE && 'Walking times are estimates.'].filter(Boolean).join(' '))
        : null),
  ]
}
