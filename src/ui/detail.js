// What the overlay shows for one event (facts, notes, overlaps, abstract, people, links, the posters or
// talks of a session) and for a group of events that share a slot.
import { h, saveFile } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { clock, timeRange, duration, dayInfo, dayOf, isOngoing, isOver } from '../lib/time.js'
import { num, count, httpUrl, normalize, slug } from '../lib/text.js'
import { eventsById, catalogInfo, isGroupEvent, childNoun, kindName } from '../data/catalog.js'
import {
  LOCATIONS, CONFERENCE_SHORT, SOURCE_NAME, PAPER_TRACKS, GENERIC_SESSION_TITLE, hasEventPage, eventPageUrl, posterImageUrl, openreviewUrl,
} from '../data/conference.js'
import { abstractFor } from '../data/abstracts.js'
import { prefs, data, ui } from '../state/store.js'
import { haystack, ensureHaystack, isDocument } from '../search/index.js'
import { SCORES, isSuggested } from '../search/relevance.js'
import { childrenHere } from '../plan/filters.js'
import { isStarred } from '../plan/clashes.js'
import { markChangesSeen } from '../plan/changes.js'
import { personalDetailView } from '../plan/personal.js'
import { walkNote } from '../plan/venue.js'
import { buildIcs } from '../plan/calendar.js'
import { addInterest } from '../views/profile.js'
import { findContact, addContact } from '../views/people.js'
import { isPaper, toggleReadMark } from '../views/reading.js'
import { highlight, reasonsRow, wasChanged, paperItem, lazyList, observers, starToggle } from './components.js'
import { showEvent, renderOverlay, clashSection } from './overlay.js'
import { setSearching } from './shell.js'

// Papers have an abstract, anything else a description. An item of a paper track titled like a
// session ("… Poster Session") is a session, not a paper.
const hasAbstractHeading = e => PAPER_TRACKS.has(e.track) && isDocument(e) && !(GENERIC_SESSION_TITLE && GENERIC_SESSION_TITLE.test(e.title))

function detailFacts (e) {
  const facts = h('div', { class: 'detail-facts' })
  const when = e.start
    ? [dayInfo(dayOf(e.start)).long, h('br'), `${timeRange(e)} ${LOCATIONS[prefs.location].zone}, ${duration(e)}`]
    : 'Time not yet published'
  const status = isOngoing(e) ? h('span', { class: 'meta-tag is-live' }, ' In progress') : isOver(e) ? h('span', { class: 'meta-tag' }, ' Ended') : null
  facts.append(icon('clock'), h('div', null, when, status))
  const site = LOCATIONS[e.location]
  if (e.room || e.location) facts.append(icon('pin'), h('div', null, [e.room, site ? site.venue || site.name : ''].filter(Boolean).join(', ')))
  const parent = e.parentId && eventsById.get(e.parentId)
  if (parent) facts.append(icon('layers'), h('div', null, h('button', { class: 'inline-link', onclick: () => showEvent(parent.id, { push: true }) }, e.parentTitle || parent.title)))
  if (e.topic) {
    const leaf = e.topic.split(' › ').pop()
    const known = data.interests.some(i => normalize(i.text) === normalize(leaf))
    const add = h('button', { class: 'inline-link', title: `Add “${leaf}” to your interests`, onclick: () => addInterest(leaf, 1, 'topic') }, 'Add to interests')
    facts.append(icon('tag'), h('div', null, e.topic, known ? null : [' ', add]))
  }
  return facts
}

// Abstracts live in separate shard files and load on demand; skeleton lines hold the space meanwhile.
function abstractBlock (e) {
  const label = hasAbstractHeading(e) ? 'Abstract' : 'Description'
  const block = h('div', { class: 'detail-section' }, h('h4', null, label))
  const hint = text => h('p', { class: 'hint' }, text)
  if (!e.hasAbstract) {
    block.append(hint(catalogInfo.abstractCount ? 'No description published for this item yet.' : `Descriptions appear after the next sync with ${SOURCE_NAME}.`))
    return block
  }
  const text = h('div', { class: 'abstract-text' }, h('div', { class: 'is-skeleton' }), h('div', { class: 'is-skeleton' }), h('div', { class: 'is-skeleton is-short' }))
  block.append(text)
  abstractFor(e).then(abstract => {
    if (!text.isConnected) return
    if (!abstract) { text.replaceChildren(hint('No description published for this item yet.')); return }
    const paragraphs = abstract.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    text.replaceChildren(...paragraphs.map(p => h('p', null, highlight(p, true))))
    if (abstract.length > 1400) {
      text.classList.add('is-clipped')
      const more = h('button', { class: 'inline-link', onclick: () => { text.classList.remove('is-clipped'); more.remove() } }, 'Read more')
      text.after(more)
    }
  }).catch(err => {
    if (text.isConnected) text.replaceChildren(hint(`Couldn’t load the description (${err.message}).`))
  })
  return block
}

// Names (authors or labs) as chips: tap to search, + to add to People.
function nameChips (names, contactFor, opts) {
  return h('div', { class: 'name-list' }, names.map(name => {
    const known = findContact(name)
    const add = h('button', {
      'aria-label': `Add ${name} to People`, title: 'Add to People',
      onclick: ev => { ev.stopPropagation(); addContact(contactFor(name)); renderOverlay() },
    }, icon('plus'))
    const marker = opts.markKnown ? h('span', { class: 'in-contacts', title: 'Already in People' }, '(in People)') : null
    return h('span', { class: known ? 'name-chip is-wanted' : 'name-chip' },
      h('button', { title: `Search for ${name}`, onclick: () => setSearching(name) }, highlight(name)),
      known ? marker : add)
  }))
}

function peopleBlocks (e) {
  const blocks = []
  const names = e.authors || []
  if (names.length && !isGroupEvent(e)) {
    const lab = e.institutions && e.institutions.length === 1 ? e.institutions[0] : ''
    blocks.push(h('div', { class: 'detail-section' },
      h('h4', null, names.length === 1 ? 'Speaker' : `${names.length} people`, h('span', { class: 'fill' }), h('span', { class: 'inline-note' }, 'Use + to add someone to People')),
      nameChips(names, name => ({ name, affiliation: lab, reason: `${kindName(e)}: ${e.title}`, source: 'author' }), { markKnown: true })))
  }
  if (e.institutions && e.institutions.length) {
    blocks.push(h('div', { class: 'detail-section' }, h('h4', null, 'Affiliations'),
      nameChips(e.institutions, name => ({ name, kind: 'org', reason: `Lab behind “${e.title}”`, source: 'affiliation' }), { markKnown: false })))
  }
  return blocks
}

// The links section as a list: empty when there is nothing to link to.
function detailLinks (e) {
  const external = (href, label) => h('a', { class: 'button', href, target: '_blank', rel: 'noopener' }, icon('ext'), label)
  const links = hasEventPage() ? [external(eventPageUrl(e), SOURCE_NAME)] : []
  if (e.openreviewId && openreviewUrl(e)) links.push(external(openreviewUrl(e), 'OpenReview'))
  if (e.hasPoster && posterImageUrl(e)) links.push(external(posterImageUrl(e), 'Poster'))
  for (const [label, url] of e.links || []) {
    const safe = httpUrl(url)
    if (safe) links.push(external(safe, label))
  }
  if (e.start) links.push(h('button', { class: 'button', onclick: () => saveFile(`${slug(CONFERENCE_SHORT)}-${e.id}.ics`, buildIcs([e]), 'text/calendar') }, icon('cal'), 'Add to calendar'))
  return links.length ? [h('div', { class: 'detail-section' }, h('div', { class: 'link-list' }, links))] : []
}

// The posters or talks of a session, filterable, best matches first.
function sessionChildren (session) {
  const children = childrenHere(session)
  const noun = childNoun(session)
  const input = h('input', { type: 'search', placeholder: `Filter ${count(children.length, noun.one)}`, 'aria-label': `Filter ${noun.label.toLowerCase()} in this session`, value: ui.query })
  const tally = h('span', null)
  const list = h('div', { class: 'panel' })
  const redraw = () => {
    observers.overlay.splice(0).forEach(watcher => watcher.disconnect())
    ensureHaystack()
    const words = normalize(input.value).split(/\s+/).filter(Boolean)
    let shown = words.length ? children.filter(p => words.every(w => haystack[p.idx].includes(w))) : children.slice()
    if (prefs.onlyMatches && SCORES) shown = shown.filter(isSuggested)
    shown.sort((a, b) => (SCORES ? SCORES[b.idx] - SCORES[a.idx] : 0) || (data.starred.has(b.id) - data.starred.has(a.id)) || a.title.localeCompare(b.title))
    const matching = shown.filter(isSuggested).length
    tally.textContent = `${num(shown.length)}${matching ? `, ${num(matching)} suggested` : ''}`
    list.replaceChildren()
    lazyList(list, shown, p => paperItem(p, { push: true }), 'overlay', 80)
  }
  let timer
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(redraw, 60) })
  const block = h('div', { class: 'detail-section' }, h('h4', null, `${noun.label} in this session`), h('div', { class: 'people-filter' }, input, tally), list)
  redraw()
  return block
}

function readingSwitch (e) {
  return h('button', { class: 'item is-option reading-row', role: 'switch', 'aria-checked': data.readList.has(e.id) ? 'true' : 'false', onclick: () => toggleReadMark(e.id) },
    h('span', { class: 'item-body' }, h('span', { class: 'item-title' }, 'Read'), h('span', { class: 'item-meta' }, 'Marked in your reading list')),
    h('span', { class: 'toggle' }))
}

export function eventDetailView (e) {
  if (e.personal) return personalDetailView(e)
  const view = h('div', { class: 'detail' }, h('h2', null, highlight(e.title, true)), detailFacts(e),
    h('div', { class: 'detail-save' }, starToggle(e, 'button', true)))
  if (wasChanged(e.id)) {
    view.append(h('p', { class: 'walk-note is-warn' }, 'Changed since your last visit. Details under Today.'))
    markChangesSeen([e.id])
  }
  const visit = data.visitWindows[e.id]
  if (visit) view.append(h('p', { class: 'walk-note' }, `Planned visit ${clock(visit[0])}–${clock(visit[1])}`))
  if (isStarred(e)) {
    const walk = walkNote(e)
    if (walk) view.append(walk)
  }
  if (isPaper(e) && isStarred(e)) view.append(readingSwitch(e))
  if (isSuggested(e)) view.append(h('div', { class: 'detail-reasons' }, reasonsRow(e)))
  view.append(h('div', { class: 'detail-section', id: 'detail-clashes' }, clashSection(e)))
  view.append(abstractBlock(e), ...peopleBlocks(e), ...detailLinks(e))
  if (isGroupEvent(e)) view.append(sessionChildren(e))
  return view
}

export function groupDetailView (group) {
  const events = group.ids.map(id => eventsById.get(id)).filter(Boolean)
  return h('div', { class: 'detail' }, h('p', { class: 'section-note' }, count(events.length, 'item')),
    h('div', { class: 'panel' }, events.map(e => paperItem(e, { push: true }))))
}
