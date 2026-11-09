// Starring and unstarring, with Undo; alternatives for a clashing item; conflict-aware top picks.
import { data, ui, save } from '../state/store.js'
import { notify, fill } from '../lib/dom.js'
import { count } from '../lib/text.js'
import { dayOf, isOver } from '../lib/time.js'
import { EVENTS, eventsById } from '../data/catalog.js'
import { eachTerm, idf, termIndex, ensureTermIndex, FIELD_WEIGHTS, isDocument } from '../search/index.js'
import { rankedPicks } from '../search/relevance.js'
import { refreshEventNodes } from '../ui/components.js'
import { showEvent, clashSection } from '../ui/overlay.js'
import { renderRail, renderDayPicker, renderPage, renderAll } from '../ui/shell.js'
import { activeTerms, inLocation, inTracks } from './filters.js'
import { clashes, clashText, overlapping, invalidateClashes } from './clashes.js'

function restoreStarred (ids) {
  data.starred.clear()
  for (const id of ids) data.starred.add(id)
}

function afterStarChange () {
  invalidateClashes()
  save()
}

const clashingIdsOf = id => (clashes().get(id) || []).map(c => c.id)

export function toggleStar (id, opts = {}) {
  const e = eventsById.get(id)
  if (!e) return
  // Personal events are always in the plan; the star opens them instead.
  if (e.personal) { showEvent(id); return }
  const adding = !data.starred.has(id)
  const clashedBefore = clashingIdsOf(id)
  if (adding) data.starred.add(id)
  else {
    data.starred.delete(id)
    delete data.visitWindows[id]
  }
  afterStarChange()
  const clashNow = clashes().get(id) || []
  refreshEventNodes([id, ...clashedBefore, ...clashNow.map(c => c.id)])
  renderRail()
  renderDayPicker()
  if ((ui.view === 'plan' || ui.view === 'today') && !activeTerms.length) renderPage()
  const detail = document.getElementById('detail-clashes')
  if (detail && ui.selection && ui.selection.type === 'event') fill(detail, clashSection(eventsById.get(ui.selection.id)))
  if (opts.quiet) return
  const undo = { action: 'Undo', run: () => toggleStar(id, { quiet: true }) }
  if (adding && clashNow.length) {
    const more = clashNow.length > 1 ? `, and ${clashNow.length - 1} more` : ''
    notify(`Saved. ${clashText(eventsById.get(clashNow[0].id), clashNow[0].min)}${more}.`, undo)
  } else {
    notify(adding ? 'Saved to My plan' : 'Removed from My plan', undo)
  }
}

export function unstar (id, message) {
  if (!data.starred.has(id)) return
  data.starred.delete(id)
  afterStarChange()
  renderAll()
  notify(message || 'Removed from My plan', {
    action: 'Undo',
    run: () => { data.starred.add(id); afterStarChange(); renderAll() },
  })
}

// The same item at another time (an oral also shown as a poster, say), else the most similar
// items by shared rare words, as long as they fit around the rest of the plan.
export function alternativesFor (e, limit = 5) {
  ensureTermIndex()
  const others = [...data.starred].map(id => eventsById.get(id)).filter(x => x && x.id !== e.id)
  const fitsPlan = x => !!x.start && !others.some(o => overlapping(o, x)) && !overlapping(x, e)
  const same = EVENTS.filter(x => x.id !== e.id && x.title === e.title && isDocument(x)).filter(fitsPlan)

  const words = []
  eachTerm(e.title + (e.keywords ? '|' + e.keywords : ''), word => words.push(word))
  const rare = [...new Set(words)].map(word => ({ word, weight: idf(word) }))
    .filter(w => w.weight > 0.35)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10)
  // Postings pack the event index above 4 bits of field id.
  const score = new Map()
  for (const { word, weight } of rare) {
    for (const posting of termIndex.post.get(word) || []) {
      const idx = posting >> 4
      score.set(idx, (score.get(idx) || 0) + weight * FIELD_WEIGHTS[posting & 15])
    }
  }
  // Same track as the original counts a little extra.
  const similar = [...score].map(([idx, s]) => ({ event: EVENTS[idx], points: s + (EVENTS[idx].track === e.track ? 0.3 : 0) }))
    .filter(({ event, points }) => event.id !== e.id && event.title !== e.title && points > 0.9 && fitsPlan(event) &&
      inLocation(event) && !isOver(event))
    .sort((a, b) => b.points - a.points)
    .slice(0, limit)
    .map(r => r.event)
  return { same, similar }
}

// The best unstarred suggestions of a day that overlap neither the plan nor each other.
export function bestPicks (day, limit = 5) {
  const ranked = rankedPicks(e => inLocation(e) && e.start && dayOf(e.start) === day && !isOver(e) && inTracks(e))
  const taken = [...data.starred].map(id => eventsById.get(id)).filter(Boolean)
  const chosen = []
  let skipped = 0
  for (const e of ranked) {
    if (chosen.length >= limit) break
    if (data.starred.has(e.id)) continue
    if (taken.some(o => overlapping(o, e)) || chosen.some(o => overlapping(o, e))) { skipped++; continue }
    chosen.push(e)
  }
  return { chosen, skipped }
}

export function addBestPicks (days) {
  const before = [...data.starred]
  let added = 0
  let skipped = 0
  for (const day of days) {
    const picks = bestPicks(day)
    for (const e of picks.chosen) data.starred.add(e.id)
    added += picks.chosen.length
    skipped += picks.skipped
  }
  afterStarChange()
  renderAll()
  notify(`Added ${count(added, 'top pick')}${skipped ? `, skipped ${skipped} that would overlap` : ''}`, {
    action: 'Undo',
    run: () => { restoreStarred(before); afterStarChange(); renderAll() },
  })
}
