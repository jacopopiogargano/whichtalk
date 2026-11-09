// The focus day on Today: an hour strip over one list of starred items, the "Now" rule and free
// gaps that offer picks.
import { h } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { nowSec, dayOf, minuteOfDay, clock, duration, isOver } from '../lib/time.js'
import { kindName } from '../data/catalog.js'
import { data } from '../state/store.js'
import { SCORES, allPicks } from '../search/relevance.js'
import { inTracks } from '../plan/filters.js'
import { visitStart, visitEnd, overlapping, clashes } from '../plan/clashes.js'
import { openPersonalForm } from '../plan/personal.js'
import { eventItem } from '../ui/components.js'
import { showEvent } from '../ui/overlay.js'
import { starredEvents, dayStart, dayWindow, nowRule } from './today.js'

export const starredOnDay = k => starredEvents()
  .filter(e => e.start && dayOf(e.start) === k)
  .sort((a, b) => visitStart(a) - visitStart(b) || a.id - b.id)

// Up to two picks that start inside the gap, end at most 30 minutes after it and clash with nothing starred.
function focusGapPicks (from, to) {
  const mine = starredEvents()
  return allPicks()
    .filter(e => e.start >= from && e.start < to && e.end <= to + 1800 && !data.starred.has(e.id) && !isOver(e) &&
      inTracks(e) && !mine.some(other => overlapping(other, e)))
    .slice(0, 2)
    .sort((a, b) => a.start - b.start)
}

function focusGapRow (k, from, to, picks) {
  const startMinute = minuteOfDay(from)
  const addEvent = () => openPersonalForm(null, { day: k, from: startMinute, to: Math.min(startMinute + 60, minuteOfDay(to) || 1439) })
  return h('div', { class: 'item is-gap' },
    h('div', { class: 'item-time' }, clock(from)),
    h('div', { class: 'item-body' },
      h('div', { class: 'item-meta' }, `Free until ${clock(to)}, ${duration({ start: from, end: to })}`,
        h('button', { class: 'text-button add-in-gap', onclick: addEvent }, icon('plus'), 'Event')),
      picks.map(e => h('button', { class: 'gap-pick', 'data-gs': e.id, onclick: () => showEvent(e.id) },
        h('span', {}, e.title),
        h('small', {}, [clock(e.start), kindName(e), e.room].filter(Boolean).join(', '))))))
}

// Starred items in time order, the "Now" rule (today only) and free gaps of 45 minutes or more,
// the first four of them with picks. A gap that spans the current time starts now. Every id
// offered in a gap goes into `offered`, so the pick cards further down skip it.
function focusRows (k, isToday, offered) {
  const items = starredOnDay(k)
  const bounds = dayWindow(k)
  const t = nowSec()
  const rows = []
  let cursor = Math.min(bounds.start, items.length ? visitStart(items[0]) : Infinity)
  const close = Math.max(bounds.end, ...items.map(e => visitEnd(e)))
  let gapsSeen = 0
  let ruleDone = !isToday
  const ruleBefore = at => {
    if (ruleDone || at <= t) return
    rows.push(nowRule(t))
    ruleDone = true
  }
  const freeTime = (from, to) => {
    if (!ruleDone && from <= t && to > t) { ruleBefore(Infinity); from = t }
    if (to - from < 45 * 60) return
    ruleBefore(from)
    const picks = SCORES && gapsSeen < 4 ? focusGapPicks(from, to) : []
    gapsSeen++
    for (const e of picks) offered.add(e.id)
    rows.push(focusGapRow(k, from, to, picks))
  }
  for (const e of items) {
    freeTime(cursor, visitStart(e))
    ruleBefore(visitStart(e))
    rows.push(eventItem(e, { time: true, countdown: isToday }))
    cursor = Math.max(cursor, visitEnd(e))
  }
  freeTime(cursor, close)
  ruleBefore(Infinity)
  return rows
}

// Whole hours from the day's first session to its last, starred items as bars (stacked when they
// overlap, marked when they clash or are personal) and the current time. The list below says the
// same in words, so screen readers and the keyboard skip the strip; a pointer can open a bar.
function focusTimeline (k, isToday) {
  const bounds = dayWindow(k)
  const items = starredOnDay(k)
  const midnight = dayStart(k)
  const earliest = Math.min(bounds.start, ...items.map(e => visitStart(e)))
  const latest = Math.max(bounds.end, ...items.map(e => visitEnd(e)))
  const lo = midnight + Math.floor((earliest - midnight) / 3600) * 3600
  const hi = midnight + Math.max(Math.ceil((latest - midnight) / 3600) * 3600, lo - midnight + 3 * 3600)
  const span = hi - lo
  const clamp = s => Math.min(Math.max(s, lo), hi)
  const pct = s => ((clamp(s) - lo) / span * 100).toFixed(3) + '%'
  const laneEnds = []
  const bars = items.map(e => {
    let lane = laneEnds.findIndex(end => end <= visitStart(e))
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(0) }
    laneEnds[lane] = visitEnd(e)
    return { e, lane }
  })
  const clashing = clashes()
  const hours = []
  for (let at = lo; at <= hi; at += 3600) hours.push(at)
  const every = hours.length > 14 ? 3 : hours.length > 8 ? 2 : 1
  const t = nowSec()
  const bar = ({ e, lane }) => h('button', {
    class: 'timeline-bar' + (e.personal ? ' is-personal' : clashing.has(e.id) ? ' is-clash' : '') + (isOver(e) ? ' is-past' : ''),
    style: `left:${pct(visitStart(e))};width:calc(${((clamp(visitEnd(e)) - clamp(visitStart(e))) / span * 100).toFixed(3)}% - 2px);top:${lane * 26}px`,
    tabindex: '-1',
    title: `${clock(visitStart(e))} to ${clock(visitEnd(e))}: ${e.title}`,
    onclick: () => showEvent(e.id),
  }, e.title)
  return h('div', { class: 'timeline', 'aria-hidden': 'true' },
    h('div', { class: 'timeline-track', style: `--lanes:${Math.max(laneEnds.length, 1)}` },
      items.length ? hours.slice(1, -1).map(at => h('span', { class: 'timeline-hour', style: `left:${pct(at)}` })) : null,
      bars.map(bar),
      isToday && t >= lo && t <= hi ? h('span', { class: 'timeline-now', style: `left:${pct(t)}` }) : null,
      items.length ? null : h('p', { class: 'timeline-empty' }, 'Star sessions and they line up here, hour by hour.')),
    h('div', { class: 'timeline-axis' }, hours.filter((at, i) => i % every === 0)
      .map(at => h('span', { class: at === hi ? 'is-end' : null, style: `left:${pct(at)}` }, clock(at)))))
}

// The strip and the list in one rounded panel.
export function focusDayPanel (k, isToday, offered) {
  const strip = focusTimeline(k, isToday)
  return h('div', { class: 'panel' }, strip, focusRows(k, isToday, offered))
}
