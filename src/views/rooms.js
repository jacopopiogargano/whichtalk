// Schedule "By room": one column per room on a shared time axis. Items that share room, time and
// track (the posters of one session, parallel workshop papers) collapse into one block that opens
// as a group.
import { count } from '../lib/text.js'
import { nowSec, dayOf, minuteOfDay, timeRange, isOver } from '../lib/time.js'
import { isGroupEvent, childNoun, authorLine, kindName } from '../data/catalog.js'
import { TRACK_BY_KEY, HIDDEN_TRACKS } from '../data/conference.js'
import { data } from '../state/store.js'
import { isSuggested } from '../search/relevance.js'
import { childrenHere } from '../plan/filters.js'
import { clashes } from '../plan/clashes.js'
import { laneLayout, timeGrid } from '../ui/components.js'
import { showEvent, showGroup } from '../ui/overlay.js'

const ROOMLESS_LABEL = 'No room listed'

// Display order of a track; personal events (no track entry) sort first.
export const trackOrder = e => (TRACK_BY_KEY[e.track] ? TRACK_BY_KEY[e.track].rank : -1)

function roomsBlock (room, members, clashing) {
  const e = members[0]
  const starred = members.some(x => data.starred.has(x.id))
  const clash = members.some(x => data.starred.has(x.id) && clashing.has(x.id))
  const match = members.some(x => isSuggested(x))
  const single = members.length === 1
  let sub
  if (!single) sub = members.map(x => x.title).slice(0, 3).join('; ')
  else sub = isGroupEvent(e) ? count(childrenHere(e).length, childNoun(e).one) : authorLine(e)
  return {
    s: e.start,
    e: e.end,
    m: minuteOfDay(e.start),
    dur: (e.end - e.start) / 60,
    id: single ? e.id : null,
    cls: [starred && 'is-starred', match && 'is-suggested', clash && 'is-clash', isOver(e) && 'is-past'].filter(Boolean).join(' '),
    cflabel: clash,
    top: timeRange(e),
    saved: starred,
    sugg: match,
    title: single ? e.title : `${members.length} ${kindName(e)}s`,
    sub,
    tip: single ? e.title : members.map(x => x.title).join('\n'),
    onclick: () => (single ? showEvent(e.id) : showGroup(`${room}, ${timeRange(e)}`, members.map(x => x.id))),
  }
}

export function renderRoomsGrid (container, day, items) {
  const byRoom = new Map()
  const clusters = new Map()
  for (const e of items) {
    if (HIDDEN_TRACKS.has(e.track) || e.personal) continue
    const key = `${e.room}|${e.start}|${e.end}|${e.track}`
    let members = clusters.get(key)
    if (!members) {
      members = []
      clusters.set(key, members)
      const room = e.room || ROOMLESS_LABEL
      if (!byRoom.has(room)) byRoom.set(room, [])
      byRoom.get(room).push(members)
    }
    members.push(e)
  }
  const isToday = day === dayOf(nowSec())
  const clashing = clashes()
  const columns = [...byRoom].map(([room, groups]) => {
    const blocks = laneLayout(groups.map(members => roomsBlock(room, members, clashing)))
    return {
      title: room,
      note: String(groups.length),
      blocks,
      lanes: Math.max(1, ...blocks.map(b => b.lanes)),
      rank: Math.min(...groups.map(members => trackOrder(members[0]))),
      weight: groups.reduce((sum, members) => sum + (members[0].end - members[0].start), 0),
      today: isToday,
    }
  })
  columns.sort((a, b) => (a.title === ROOMLESS_LABEL) - (b.title === ROOMLESS_LABEL) || a.rank - b.rank || b.weight - a.weight || a.title.localeCompare(b.title))
  container.append(timeGrid(columns, { px: 1.35, colMin: 168, minHour: 9, maxHour: 17 }))
}
