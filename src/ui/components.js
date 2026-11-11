// Shared building blocks: highlighted text, star buttons, list items, pick cards, paper rows,
// lazily filled lists, page heads and the time grid used by Rooms and the week view.
import { h, notify } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { clock, clockFromMinutes, duration, dayInfo, dayOf, whenLabel, isOngoing, isOver, countdown, nowSec, minuteOfDay } from '../lib/time.js'
import { num, count, normalize, normalizeKeepCase, escapeRegex } from '../lib/text.js'
import { eventsById, isGroupEvent, childNoun, authorLine, kindName, locationName } from '../data/catalog.js'
import { LOCATIONS, ALL_LOCATION, CONTAINER_KINDS } from '../data/conference.js'
import { prefs, data, ui } from '../state/store.js'
import { STOPWORDS } from '../search/index.js'
import { SCORES, MATCH_BITS, interestQueries, highlightCache, isSuggested, matchedInterests, matchStrength, vote } from '../search/relevance.js'
import { activeTerms, childrenHere } from '../plan/filters.js'
import { visitStart, visitEnd, isStarred, clashes, clashText } from '../plan/clashes.js'
import { toggleStar, unstar } from '../plan/starring.js'
import { changedEventIds } from '../plan/changes.js'
import { showAlternatives } from '../views/plan.js'
import { showEvent } from './overlay.js'
import { renderPage } from './shell.js'

// ---------- highlighting ----------
// Search terms are marked everywhere. Interest terms only in deep mode (the details panel), so lists
// stay quiet and the "Matches ..." line carries the reason. Interest words match on a loose stem.
const hlStem = word => escapeRegex(word.length > 4 ? word.slice(0, Math.max(4, word.length - 2)) : word) + '[a-z0-9]*'

function hlPattern (deep) {
  const cache = highlightCache()
  const slot = deep ? 'deep' : 'search'
  if (cache[slot] !== undefined) return cache[slot]
  const alternatives = activeTerms.map(escapeRegex)
  if (deep) {
    for (const q of interestQueries) {
      if (!q.active) continue
      const words = normalize(q.text).trim().split(/\s+/).filter(w => w.length > 1 && !STOPWORDS.has(w))
      if (words.length) alternatives.push('\\b' + words.map(hlStem).join('[\\s-]+'))
    }
  }
  cache[slot] = alternatives.length ? new RegExp(alternatives.join('|'), 'g') : false
  return cache[slot]
}

// Returns the text itself, or a fragment with <mark> around every hit. Matching runs on a folded copy
// of the same length, so offsets map straight back onto the original.
export function highlight (text, deep) {
  const pattern = hlPattern(deep)
  if (!pattern || !text) return text || ''
  const folded = normalizeKeepCase(text)
  let fragment = null
  let cursor = 0
  let hit
  pattern.lastIndex = 0
  while ((hit = pattern.exec(folded))) {
    if (!hit[0]) { pattern.lastIndex++; continue }
    fragment = fragment || document.createDocumentFragment()
    fragment.append(text.slice(cursor, hit.index), h('mark', null, text.slice(hit.index, hit.index + hit[0].length)))
    cursor = hit.index + hit[0].length
  }
  if (!fragment) return text
  fragment.append(text.slice(cursor))
  return fragment
}

// ---------- star toggle ----------
// A labelled star (the event details) says what it does and is the primary action until pressed.
function paintStar (button, on) {
  button.setAttribute('aria-pressed', on ? 'true' : 'false')
  if (button.dataset.labelled) {
    button.classList.toggle('is-primary', !on)
    button.title = on ? 'Remove from My plan' : 'Save to My plan'
    button.replaceChildren(icon(on ? 'starFill' : 'star'), on ? 'In My plan' : 'Save to My plan')
    return
  }
  button.setAttribute('aria-label', on ? 'Remove from My plan' : 'Save to My plan')
  button.replaceChildren(icon(on ? 'starFill' : 'star'))
}

export function starToggle (e, cls = 'star-toggle', labelled = false) {
  const button = h('button', { class: cls, 'data-star': e.id, 'data-labelled': labelled ? '1' : null, title: 'Save to My plan', onclick: ev => { ev.stopPropagation(); toggleStar(e.id) } })
  paintStar(button, data.starred.has(e.id))
  return button
}

// Re-render every visible copy of these events (list items, paper rows, star buttons) in place.
// The options an item was built with are kept on it as data attributes.
export function refreshEventNodes (ids) {
  const flag = (node, name) => node.dataset[name] === '1'
  for (const id of new Set(ids)) {
    const e = eventsById.get(id)
    if (!e) continue
    const itemOptions = node => ({ showDay: flag(node, 'showday'), suggest: flag(node, 'suggest'), time: flag(node, 'time'), plan: flag(node, 'plan'), countdown: flag(node, 'cd') })
    document.querySelectorAll(`.item[data-id="${id}"]`).forEach(node => node.replaceWith(eventItem(e, itemOptions(node))))
    document.querySelectorAll(`.paper[data-id="${id}"]`).forEach(node => node.replaceWith(paperItem(e, { when: flag(node, 'when'), push: flag(node, 'push') })))
    document.querySelectorAll(`[data-star="${id}"]`).forEach(button => paintStar(button, data.starred.has(id)))
  }
}

// Starred items whose time or room changed since the last visit carry a quiet "Changed" tag until seen.
let changedMemo = { key: '', ids: new Set() }
export function wasChanged (id) {
  const log = prefs.changeLog
  const key = log ? `${log.at}:${log.seen.length}` : ''
  if (changedMemo.key !== key) changedMemo = { key, ids: changedEventIds() }
  return changedMemo.ids.has(id)
}

const isSelectedEvent = e => !!ui.selection && ui.selection.id === e.id
const opensOnEnter = (open) => ev => { if (ev.key === 'Enter' && ev.target === ev.currentTarget) open(ev) }
const matchLine = (e, n) => `Matches ${matchedInterests(e).slice(0, n).join(', ')}`

function clashLinks (e, max = 2) {
  if (!isStarred(e)) return null
  const list = clashes().get(e.id) || []
  if (!list.length) return null
  return list.slice(0, max).map(c => {
    const other = eventsById.get(c.id)
    const tail = list.length > max && c === list[max - 1] ? `, and ${list.length - max} more` : ''
    return h('button', { class: 'clash-link', title: 'Open the overlapping item', onclick: ev => { ev.stopPropagation(); showEvent(other.id) } },
      icon('warn'), h('span', null, clashText(other, c.min), tail))
  })
}

// "Matches ..." with thumbs up/down. A vote re-weights the interests behind the match.
export function reasonsRow (e) {
  const hits = matchedInterests(e)
  const typos = interestQueries.filter(q => MATCH_BITS && (MATCH_BITS[e.idx] & q.bit) && q.fuzzy.length).flatMap(q => q.fuzzy)
  const current = data.votes[e.id] || 0
  const voteButton = (value, glyph, label) => h('button', {
    class: 'vote', 'aria-pressed': current === value ? 'true' : 'false', 'aria-label': label, title: label,
    onclick: ev => {
      ev.stopPropagation()
      const result = vote(e, value)
      if (ui.view === 'foryou' && !activeTerms.length) renderPage()
      else refreshEventNodes([e.id])
      const message = result.next > 0 ? `More like this. Raised ${result.terms.join(', ') || 'your interests'}.`
        : result.next < 0 ? `Hidden. Lowered ${result.terms.join(', ') || 'matching interests'}.` : 'Feedback cleared'
      notify(message, { action: 'Undo', run: () => { vote(e, result.next); if (ui.view === 'foryou') renderPage() } })
    },
  }, icon(glyph))
  return h('div', { class: 'reasons' },
    h('span', { class: 'fill', title: `Match strength ${Math.round(matchStrength(e) * 100)}%` },
      hits.length ? `Matches ${hits.slice(0, 4).join(', ')}` : 'Suggested',
      typos.length ? h('span', { class: 'dim', title: 'Typo-tolerant match' }, ` (${typos[0]})`) : ''),
    voteButton(1, 'thumbUp', 'More like this'), voteButton(-1, 'thumbDown', 'Not for me'))
}

// ---------- list item ----------
// [time] | title, facts, people, notes | star. `time` adds the time column (Today, My plan, search);
// Schedule items sit under a time heading and leave it out. Poster sessions stay collapsed.
function itemTime (e, o, live) {
  if (!e.start) return h('div', { class: 'item-time' }, 'TBA')
  const begins = visitStart(e)
  const small = o.showDay ? dayInfo(dayOf(e.start)).weekday : live ? 'Now'
    : o.countdown && begins > nowSec() ? countdown(begins - nowSec(), true) : duration({ start: begins, end: visitEnd(e) })
  return h('div', { class: 'item-time' }, clock(begins), h('small', null, small))
}

function sessionNote (e) {
  const children = childrenHere(e)
  const matching = SCORES && children.some(isSuggested) && `${num(children.filter(isSuggested).length)} match your interests`
  return h('div', { class: 'item-note' }, [count(children.length, childNoun(e).one), matching].filter(Boolean).join(', '))
}

function clashActions (e, other) {
  return h('div', { class: 'item-actions' },
    h('button', { class: 'button is-small', onclick: ev => { ev.stopPropagation(); unstar(other.id, `Kept “${e.title.slice(0, 40)}”, removed the other`) } }, 'Keep this'),
    h('button', { class: 'button is-small', onclick: ev => { ev.stopPropagation(); showAlternatives(e) } }, 'Alternatives'))
}

export function eventItem (e, o = {}) {
  const starred = isStarred(e)
  const suggested = isSuggested(e)
  const overlaps = starred ? (clashes().get(e.id) || []) : []
  const session = isGroupEvent(e)
  const live = isOngoing(e)
  const visit = data.visitWindows[e.id]
  const classes = ['item', !o.time && 'is-untimed', starred && 'is-starred', e.personal && 'is-personal', suggested && 'is-suggested',
    session && 'is-session', overlaps.length && 'is-clash', live && 'is-live', isOver(e) && 'is-past', isSelectedEvent(e) && 'is-selected']
  const where = [e.room, prefs.location === ALL_LOCATION && locationName(e)].filter(Boolean).join(', ')
  const facts = [o.time ? kindName(e) : `${kindName(e)}${e.start ? ', ' + duration(e) : ''}`, where].filter(Boolean).join(', ')
  const firstOther = overlaps.length ? eventsById.get(overlaps[0].id) : null
  const open = () => showEvent(e.id)
  return h('div', {
    class: classes.filter(Boolean).join(' '), 'data-id': e.id,
    'data-showday': o.showDay ? '1' : null, 'data-suggest': o.suggest ? '1' : null, 'data-time': o.time ? '1' : null, 'data-plan': o.plan ? '1' : null, 'data-cd': o.countdown ? '1' : null,
    tabindex: '0', role: 'button',
    'aria-label': `${e.start ? whenLabel(e) + ', ' : ''}${kindName(e)}: ${e.title}${overlaps.length ? ' (overlaps another saved item)' : ''}`,
    onclick: open, onkeydown: opensOnEnter(open),
  },
  o.time ? itemTime(e, o, live) : null,
  h('div', { class: 'item-body' },
    h('div', { class: 'item-title' }, live && !o.time ? h('span', { class: 'live-marker', title: 'In progress' }) : null, highlight(e.title), wasChanged(e.id) ? h('span', { class: 'changed-tag' }, 'Changed') : null),
    h('div', { class: 'item-meta' }, facts),
    visit ? h('div', { class: 'item-note' }, `Planned visit ${clock(visit[0])}–${clock(visit[1])} of the poster session`) : null,
    e.personal && e.notes ? h('div', { class: 'item-people' }, e.notes) : null,
    e.authors && e.authors.length && !session ? h('div', { class: 'item-people' }, highlight(authorLine(e))) : null,
    session ? sessionNote(e) : null,
    CONTAINER_KINDS.has(e.kind) && !session ? h('div', { class: 'item-note' }, 'Talks not yet announced') : null,
    suggested && !o.suggest && !session ? h('div', { class: 'item-note is-match' }, matchLine(e, 3)) : null,
    clashLinks(e),
    o.plan && firstOther && !e.personal && !firstOther.personal ? clashActions(e, firstOther) : null,
    o.suggest ? reasonsRow(e) : null),
  session ? h('span', { class: 'item-chevron', 'aria-hidden': 'true' }, icon('chev')) : null,
  e.personal ? h('span', { class: 'star-spacer', 'aria-hidden': 'true' }) : starToggle(e))
}

// Large suggestion card (Today).
export function pickCard (e) {
  const open = () => showEvent(e.id)
  const lead = e.start ? `${isOngoing(e) ? 'Now' : clock(e.start)}, ${kindName(e)}` : kindName(e)
  return h('div', { class: 'pick-card', 'data-id': e.id, role: 'button', tabindex: '0', onclick: open, onkeydown: opensOnEnter(open) },
    h('div', { class: 'pick-top' }, h('span', null, lead), starToggle(e)),
    h('h3', null, e.title),
    h('p', { class: 'pick-reason' }, matchLine(e, 3)),
    h('p', { class: 'pick-where' }, [e.room, e.start ? duration(e) : ''].filter(Boolean).join(', ')))
}

// Compact row for papers (search results, poster sessions, groups).
export function paperItem (e, o = {}) {
  const clash = data.starred.has(e.id) && clashes().has(e.id)
  const open = ev => { ev.stopPropagation(); showEvent(e.id, { push: o.push }) }
  return h('div', {
    class: ['paper', isSelectedEvent(e) && 'is-selected', clash && 'is-clash'].filter(Boolean).join(' '),
    'data-id': e.id, 'data-when': o.when ? '1' : null, 'data-push': o.push ? '1' : null,
    tabindex: '0', role: 'button', 'aria-label': e.title, onclick: open, onkeydown: opensOnEnter(open),
  },
  h('div', { class: 'paper-body' },
    h('div', { class: 'paper-title' }, highlight(e.title)),
    h('div', { class: 'paper-authors' },
      clash ? h('span', { class: 'paper-clash' }, 'Overlaps') : null,
      o.when && e.start ? h('span', { class: 'paper-when' }, whenLabel(e)) : null,
      highlight(authorLine(e) || e.room || '')),
    isSuggested(e) ? h('div', { class: 'paper-match' }, matchLine(e, 3)) : null),
  starToggle(e))
}

// ---------- lazy lists ----------
// Items are appended in batches as a sentinel scrolls near the viewport, so huge lists open instantly.
// Observers are filed by owner ('page' or 'overlay') and disconnected when that owner re-renders.
export const observers = { page: [], overlay: [] }

export function lazyList (container, items, render, bucket, batch = 60) {
  let next = 0
  let watching = false
  const sentinel = h('div', { class: 'load-more-sentinel' })
  container.append(sentinel)
  const watcher = new IntersectionObserver(entries => { if (entries.some(x => x.isIntersecting)) appendBatch() }, { rootMargin: '900px 0px' })
  function appendBatch () {
    const fragment = document.createDocumentFragment()
    const stop = Math.min(items.length, next + batch)
    while (next < stop) { fragment.append(render(items[next], next)); next++ }
    sentinel.before(fragment)
    if (next >= items.length) { watcher.disconnect(); sentinel.remove() }
    else if (watching) { watcher.unobserve(sentinel); watcher.observe(sentinel) }
  }
  observers[bucket].push(watcher)
  appendBatch()
  if (next < items.length) { watching = true; watcher.observe(sentinel) }
}

// ---------- page furniture ----------
// `meta` may be a list of facts; each becomes its own span.
export function pageHead (title, meta, ...tools) {
  const metaLine = Array.isArray(meta) ? meta.filter(Boolean).map(x => h('span', null, x)) : meta
  return h('div', { class: 'page-head' },
    h('div', null, h('h1', null, title), meta ? h('p', { class: 'page-meta' }, metaLine) : null),
    tools.filter(Boolean).length ? h('div', { class: 'page-tools' }, tools) : null)
}

export function emptyState (title, text, ...extra) {
  return h('div', { class: 'empty-state' }, h('h2', null, title), h('p', null, text), extra.length ? h('div', { class: 'actions' }, extra) : null)
}

// Inset-grouped section: title, optional [label, onclick] link, then a rounded panel of rows.
export function section (title, link, ...rows) {
  return h('section', { class: 'section' },
    title ? h('div', { class: 'section-head' }, h('h2', null, title), link ? h('button', { class: 'text-button', onclick: link[1] }, link[0]) : null) : null,
    h('div', { class: 'panel' }, rows))
}

// ---------- time grid ----------
// Assigns side-by-side lanes to overlapping blocks ({ s, e }); each block gets `lane`, and every block
// of an overlapping cluster gets the cluster's `lanes`.
export function laneLayout (blocks) {
  const placed = []
  let cluster = []
  let clusterEnd = 0
  const closeCluster = () => {
    const laneEnds = []
    for (const b of cluster) {
      let lane = laneEnds.findIndex(end => end <= b.s)
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(0) }
      laneEnds[lane] = b.e
      b.lane = lane
    }
    for (const b of cluster) b.lanes = laneEnds.length
    placed.push(...cluster)
    cluster = []
  }
  for (const b of blocks.sort((x, y) => x.s - y.s || y.e - x.e)) {
    if (cluster.length && b.s >= clusterEnd) closeCluster()
    cluster.push(b)
    clusterEnd = Math.max(clusterEnd, b.e)
  }
  if (cluster.length) closeCluster()
  return placed
}

function gridBlock (b, firstMinute, px) {
  const lanes = b.lanes || 1
  const height = Math.max(b.dur * px - 2, 24)
  const lines = Math.max(1, Math.min(4, Math.floor((height - 22) / 15.5)))
  const position = `top:${(b.m - firstMinute) * px + 1}px;height:${height}px;left:calc(${b.lane || 0} * 100% / ${lanes} + 3px);width:calc(100% / ${lanes} - 6px)`
  return h('button', { class: b.cls ? 'block ' + b.cls : 'block', style: position, title: b.tip, 'aria-label': b.tip, 'data-id': b.id || null, onclick: b.onclick },
    h('small', null, b.cflabel ? icon('warn', 'block-clash') : null, h('span', null, b.top), b.saved ? icon('starFill', 'block-star') : null, b.sugg ? icon('match', 'block-match') : null),
    h('b', { style: `-webkit-line-clamp:${lines}` }, b.title),
    b.sub && height - 22 - lines * 15.5 > 13 ? h('small', null, b.sub) : null)
}

// Columns are rooms (Rooms) or days (week view). Blocks carry m (start minute of day), dur (minutes)
// and their lane; o = { px, colMin, minHour, maxHour, maxLanes }.
export function timeGrid (columns, o) {
  const blocks = columns.flatMap(c => c.blocks)
  const first = Math.floor(Math.min(o.minHour * 60, ...blocks.map(b => b.m)) / 60) * 60
  const last = Math.ceil(Math.max(o.maxHour * 60, ...blocks.map(b => b.m + b.dur)) / 60) * 60
  const px = o.px
  const height = (last - first) * px
  const tracks = columns.map(c => { const lanes = Math.min(c.lanes || 1, o.maxLanes || 3); return `minmax(${o.colMin * lanes}px, ${lanes}fr)` })
  const grid = h('div', { class: 'time-grid', style: `grid-template-columns:56px ${tracks.join(' ')};--hour:${60 * px}px` })
  grid.append(h('div', { class: 'grid-head is-corner' }, LOCATIONS[prefs.location].zone))
  for (const c of columns) {
    grid.append(h('div', { class: c.mark ? 'grid-head is-today' : 'grid-head', title: c.title },
      c.title, c.note ? h('small', null, c.note) : null, c.warn ? h('small', { class: 'is-clash' }, c.warn) : null))
  }
  const axis = h('div', { class: 'grid-axis', style: `height:${height}px` })
  for (let m = first; m < last; m += 60) axis.append(h('span', { style: m === first ? 'top:4px;transform:none' : `top:${(m - first) * px}px` }, clockFromMinutes(m)))
  grid.append(axis)
  for (const c of columns) {
    const column = h('div', { class: c.today ? 'grid-col is-today' : 'grid-col', style: `height:${height}px` }, c.blocks.map(b => gridBlock(b, first, px)))
    if (c.today) {
      const minute = minuteOfDay(nowSec())
      if (minute >= first && minute <= last) column.append(h('div', { class: 'grid-now', style: `top:${(minute - first) * px}px` }))
    }
    grid.append(column)
  }
  return h('div', { class: 'grid-scroller' }, grid)
}
