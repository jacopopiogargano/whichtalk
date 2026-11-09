// People (My plan, People and Notes): who to meet, with the talks and posters where to find them,
// who I met, with meeting notes and follow-ups, and the exports. Contacts live in data.people.
import { h, notify, saveFile } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { whenLabel, stamp } from '../lib/time.js'
import { count, normalize } from '../lib/text.js'
import { EVENTS, isGroupEvent, kindName } from '../data/catalog.js'
import { CONFERENCE_ID, CONFERENCE_SHORT, HIDDEN_TRACKS } from '../data/conference.js'
import { data, prefs, local, save } from '../state/store.js'
import { sanitizePeople } from '../state/sanitize.js'
import { SCORES, rankedPicks } from '../search/relevance.js'
import { inLocation } from '../plan/filters.js'
import { starToggle, emptyState } from '../ui/components.js'
import { openDialog, closeDialog } from '../ui/dialog.js'
import { showEvent } from '../ui/overlay.js'
import { renderAll, renderPage } from '../ui/shell.js'
import { contactForm, meetingNoteForm } from './people-forms.js'
import { peopleMarkdown, peopleCsv, contactsVcard } from './people-export.js'

const CONTACT_STATUSES = [['to-meet', 'To meet'], ['met', 'Met'], ['skipped', 'Skip']]
const PRIORITY_BADGES = { 1: ['is-high', 'High priority'], 3: ['is-low', 'Low priority'] }

// Folded author name -> { name, events }, built once from the catalog.
let authorDirectory = null
function authorsByName () {
  if (authorDirectory) return authorDirectory
  const directory = new Map()
  for (const e of EVENTS) {
    if (HIDDEN_TRACKS.has(e.track) || isGroupEvent(e)) continue
    for (const name of e.authors) {
      const key = normalize(name)
      if (!directory.has(key)) directory.set(key, { name, events: [] })
      directory.get(key).events.push(e)
    }
  }
  authorDirectory = directory
  return directory
}

const byStartTime = (a, b) => (a.start || 9e9) - (b.start || 9e9)

// Where to find someone at the current location: their talks and posters, or for an organization
// everything its people present.
export function whereabouts (person) {
  const key = normalize(person.name)
  if (person.kind === 'org') return EVENTS.filter(e => e.institutions && e.institutions.some(i => normalize(i) === key) && inLocation(e)).sort(byStartTime)
  const entry = authorsByName().get(key)
  return entry ? entry.events.filter(inLocation).sort(byStartTime) : []
}

export const findContact = name => data.people.find(p => normalize(p.name) === normalize(name))

// fields: { name, affiliation, reason, links, priority, kind, source }. Returns the new or the
// existing contact (null without a name); `quiet` skips the re-render and the toast.
export function addContact (fields, quiet = false) {
  const name = (fields.name || '').trim()
  if (!name) return null
  const existing = findContact(name)
  if (existing) {
    if (!quiet) notify(`${name} is already on your list`)
    return existing
  }
  const now = Date.now()
  const person = sanitizePeople([{ ...fields, name, status: 'to-meet', created: now, updated: now }])[0]
  person.kind = fields.kind || 'person'
  data.people.unshift(person)
  save()
  if (!quiet) {
    renderAll()
    const undo = () => {
      const at = data.people.findIndex(p => p.id === person.id)
      if (at >= 0) data.people.splice(at, 1)
      save()
      renderAll()
    }
    notify(`Added ${name} to People`, { action: 'Undo', run: undo })
  }
  return person
}

function setContactStatus (person, status) {
  if (status === 'met') {
    meetingNoteForm(person)
    return
  }
  person.status = status
  person.updated = Date.now()
  save()
  renderAll()
}

function removeContact (person) {
  const at = data.people.indexOf(person)
  data.people.splice(at, 1)
  save()
  renderAll()
  notify(`Removed ${person.name}`, { action: 'Undo', run: () => { data.people.splice(at, 0, person); save(); renderAll() } })
}

function deleteNote (person, note) {
  person.notes = person.notes.filter(n => n !== note)
  save()
  renderAll()
  notify('Note deleted', { action: 'Undo', run: () => { person.notes.unshift(note); save(); renderAll() } })
}

const savedCoauthors = () => local.get('coauthors', []) || []

// Co-authors from an import who present here, then authors of the best-matching papers.
function suggestedContacts () {
  const score = new Map()
  for (const e of rankedPicks(inLocation).slice(0, 80)) {
    for (const name of e.authors) score.set(name, (score.get(name) || 0) + SCORES[e.idx])
  }
  const fromPapers = [...score.entries()].filter(([name]) => !findContact(name)).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name]) => ({ name, reason: 'Author of papers that match your interests', source: 'suggested' }))
  const directory = authorsByName()
  const coauthors = savedCoauthors().filter(c => c && c.name && directory.has(normalize(c.name)) && !findContact(c.name)).slice(0, 10)
    .map(c => ({ name: directory.get(normalize(c.name)).name, reason: `Co-author on ${count(c.papers, 'paper')}, presenting at ${CONFERENCE_SHORT}`, source: 'coauthor' }))
  return [...coauthors, ...fromPapers]
}

function whereRow (e) {
  return h('div', { class: 'where-row' },
    h('div', { class: 'where-text' },
      h('b', { onclick: () => showEvent(e.id), title: e.title, role: 'button', tabindex: '0' }, e.title),
      h('span', {}, [kindName(e), whenLabel(e), e.room].filter(Boolean).join(', '))),
    starToggle(e))
}

function contactCard (person) {
  const where = whereabouts(person)
  const subtitle = [person.affiliation, person.kind === 'org' ? 'Organization' : ''].filter(Boolean).join(', ')
  const badge = PRIORITY_BADGES[person.priority]
  const statusButtons = h('div', { class: 'toggle-group', role: 'group', 'aria-label': `Status of ${person.name}` },
    CONTACT_STATUSES.map(([key, label]) => h('button', { 'aria-pressed': person.status === key ? 'true' : 'false', onclick: () => setContactStatus(person, key) }, label)))
  return h('article', { class: 'contact' },
    h('header', {}, h('h3', {}, person.name),
      subtitle ? h('div', { class: 'affiliation' }, subtitle) : null,
      badge ? h('div', { class: 'priority ' + badge[0] }, badge[1]) : null),
    person.reason ? h('p', { class: 'contact-reason' }, person.reason) : null,
    h('div', { class: 'whereabouts' },
      where.length ? where.slice(0, 5).map(whereRow) : h('div', { class: 'helper' }, `Not on the ${CONFERENCE_SHORT} schedule.`),
      where.length > 5 ? h('div', { class: 'helper' }, `${where.length - 5} more`) : null),
    person.links.length
      ? h('div', { class: 'link-list' }, person.links.map(u => h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, new URL(u).host)))
      : null,
    h('div', { class: 'contact-actions' }, statusButtons,
      h('button', { class: 'button is-small', onclick: () => meetingNoteForm(person) }, 'Add note'),
      h('button', { class: 'button is-small', onclick: () => contactForm(person) }, 'Edit'),
      h('button', { class: 'button is-small is-danger', onclick: () => removeContact(person) }, 'Remove'),
      person.notes.length ? h('span', { class: 'helper' }, count(person.notes.length, 'note')) : null))
}

function todoItem (person, note, todo, withName) {
  const box = h('input', { type: 'checkbox' })
  box.checked = todo.done
  box.addEventListener('change', () => {
    todo.done = box.checked
    note.updated = Date.now()
    save()
    renderPage()
  })
  return h('label', { class: todo.done ? 'is-done' : '' }, box,
    h('span', {}, todo.text, withName ? h('span', { class: 'dim' }, `, ${person.name}`) : null))
}

function noteEntry (person, note) {
  const contact = Object.entries(note.contact || {}).filter(([, value]) => value)
  return h('article', { class: 'note-entry' },
    h('time', {}, stamp(note.at)),
    h('div', {},
      h('h3', {}, person.name, person.affiliation ? h('span', { class: 'affiliation' }, person.affiliation) : null),
      note.where ? h('div', { class: 'helper' }, note.where) : null,
      note.text ? h('p', {}, note.text) : null,
      note.todos.length ? h('div', { class: 'todo-list' }, note.todos.map(todo => todoItem(person, note, todo))) : null,
      note.tags.length || contact.length
        ? h('div', { class: 'meta-tags' },
          note.tags.map(tag => h('span', { class: 'meta-tag' }, '#' + tag)),
          contact.map(([key, value]) => h('span', { class: 'meta-tag' }, `${key}: ${value}`)))
        : null,
      h('div', { class: 'contact-actions' },
        h('button', { class: 'button is-small', onclick: () => meetingNoteForm(person, note) }, 'Edit'),
        h('button', { class: 'button is-small is-danger', onclick: () => deleteNote(person, note) }, 'Delete'))))
}

const exportLink = () => h('button', { class: 'text-button', onclick: openPeopleExport, disabled: !data.people.length }, 'Export')

const sectionHeading = (title, aside) => h('div', { class: 'section-head' }, h('h2', {}, title), aside === undefined ? null : h('span', { class: 'section-aside' }, aside))

const contactGroup = (title, list) => h('section', { class: 'section' },
  sectionHeading(title, count(list.length, 'person', 'people')),
  h('div', { class: 'panel contact-list' }, list.map(contactCard)))

// Skipped people sink to the bottom; then by priority, most recently changed first.
const contactOrder = (a, b) => (a.status === 'skipped') - (b.status === 'skipped') || a.priority - b.priority || b.updated - a.updated

export function renderPeopleSection (container) {
  container.append(h('div', { class: 'controls' },
    h('button', { class: 'button is-primary', onclick: () => contactForm(null) }, icon('userPlus'), 'Add person'),
    h('span', { class: 'fill' }),
    exportLink()))
  const suggestions = SCORES || savedCoauthors().length ? suggestedContacts() : []
  const toMeet = data.people.filter(p => p.status !== 'met').sort(contactOrder)
  if (toMeet.length) container.append(contactGroup('To meet', toMeet))
  else {
    container.append(emptyState('Who do you want to meet?',
      'Add people from the author list in any session’s details, from the suggestions below, or by hand. Each person lists the talks and posters where you can find them.'))
  }
  const met = data.people.filter(p => p.status === 'met')
  if (met.length) container.append(contactGroup('Met', met))
  if (!suggestions.length) return
  container.append(h('section', { class: 'section' }, sectionHeading('Suggested people'),
    h('p', { class: 'section-note' }, `Authors of the papers that best match your interests, plus your co-authors who are on the ${CONFERENCE_SHORT} program.`),
    h('div', { class: 'panel is-padded name-list' }, suggestions.map(s => h('button', {
      class: 'name-chip is-suggested',
      title: `${s.reason}. Add to People.`,
      onclick: () => addContact(s),
    }, icon('userPlus'), s.name)))))
}

// Open follow-ups first, then every meeting note, newest first.
export function renderNotesSection (container) {
  const notes = data.people.flatMap(person => person.notes.map(note => ({ person, note }))).sort((a, b) => b.note.at - a.note.at)
  const open = notes.flatMap(({ person, note }) => note.todos.filter(t => !t.done).map(todo => ({ person, note, todo })))
  container.append(h('div', { class: 'controls' }, h('span', { class: 'fill' }), exportLink()))
  if (!notes.length) {
    const openPeople = () => { prefs.planSection = 'people'; renderPage() }
    container.append(emptyState('No meeting notes yet',
      'In People, mark someone as met to write a note: where you met, what you discussed, follow-ups and contact details.',
      h('button', { class: 'button', onclick: openPeople }, 'Open People')))
    return
  }
  container.append(h('section', { class: 'section' },
    sectionHeading('Follow-ups', open.length ? count(open.length, 'open') : 'All done'),
    open.length
      ? h('div', { class: 'panel is-padded todo-list' }, open.map(x => todoItem(x.person, x.note, x.todo, true)))
      : h('p', { class: 'section-note' }, 'Completed follow-ups stay with their notes below.')))
  container.append(h('section', { class: 'section' },
    sectionHeading('Meeting notes', count(notes.length, 'note')),
    h('div', { class: 'panel note-log' }, notes.map(({ person, note }) => noteEntry(person, note)))))
}

export function openPeopleExport () {
  const exportButton = (label, cls, suffix, build, mime) => h('button', {
    class: cls,
    onclick: () => { saveFile(`${CONFERENCE_ID}-${suffix}`, build(data.people), mime); closeDialog() },
  }, label)
  openDialog('Export people and notes', h('p', { class: 'helper' }, 'Files are created on this device. vCards import into Contacts; CSV opens in any spreadsheet.'), [
    exportButton('Markdown', 'button', 'people.md', peopleMarkdown, 'text/markdown'),
    exportButton('CSV', 'button', 'people.csv', peopleCsv, 'text/csv'),
    exportButton('vCard', 'button is-primary', 'contacts.vcf', contactsVcard, 'text/vcard'),
  ])
}
