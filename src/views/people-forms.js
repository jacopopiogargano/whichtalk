// Dialog forms for People: a contact (name, affiliation, why, links, priority) and a meeting note
// (when, where, what, follow-ups, tags, contact details). Saving a note marks the person as met.
import { h, notify } from '../lib/dom.js'
import { nowSec } from '../lib/time.js'
import { httpUrl, newId } from '../lib/text.js'
import { eventsById } from '../data/catalog.js'
import { HIDDEN_TRACKS } from '../data/conference.js'
import { data, save } from '../state/store.js'
import { topLevel } from '../plan/filters.js'
import { openDialog, closeDialog } from '../ui/dialog.js'
import { renderAll } from '../ui/shell.js'
import { addContact } from './people.js'

const PRIORITY_OPTIONS = [[1, 'High'], [2, 'Normal'], [3, 'Low']]

const formField = (label, control, wide) => h('label', { class: wide ? 'form-field is-full' : 'form-field' }, label, control)
const cancelButton = () => h('button', { class: 'button', onclick: () => closeDialog() }, 'Cancel')

// Prefill for "Where": a starred item happening now, else anything on stage now.
function currentPlace () {
  const t = nowSec()
  const happening = e => e && e.start <= t && t < e.end
  const e = [...data.starred].map(id => eventsById.get(id)).find(happening) || topLevel().find(x => happening(x) && !HIDDEN_TRACKS.has(x.track))
  return e ? `${e.title}${e.room ? ', ' + e.room : ''}` : ''
}

// Value for <input type="datetime-local">, in the browser's zone.
const localDateTime = ms => new Date(ms - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)

export function contactForm (person) {
  const name = h('input', { value: person ? person.name : '', placeholder: 'Full name' })
  const affiliation = h('input', { value: person ? person.affiliation : '', placeholder: 'Lab or company' })
  const reason = h('textarea', { placeholder: 'Why you want to meet them' })
  const links = h('input', { value: person ? person.links.join(' ') : '', placeholder: 'Links, separated by spaces' })
  const chosen = person ? person.priority : 2
  const priority = h('select', {}, PRIORITY_OPTIONS.map(([value, label]) => h('option', { value, selected: chosen === value }, label)))
  reason.value = person ? person.reason : ''
  const submit = () => {
    const urls = links.value.split(/\s+/).filter(httpUrl)
    if (!name.value.trim()) {
      name.focus()
      return
    }
    if (person) {
      Object.assign(person, {
        name: name.value.trim(),
        affiliation: affiliation.value.trim(),
        reason: reason.value.trim(),
        links: urls,
        priority: Number(priority.value),
        updated: Date.now(),
      })
    } else {
      addContact({ name: name.value, affiliation: affiliation.value, reason: reason.value, links: urls, priority: Number(priority.value), source: 'manual' }, true)
    }
    closeDialog()
    save()
    renderAll()
  }
  openDialog(person ? `Edit ${person.name}` : 'Add someone to meet',
    h('div', { class: 'form-grid' },
      formField('Name', name), formField('Affiliation', affiliation), formField('Why', reason, true),
      formField('Links', links), formField('Priority', priority)),
    [cancelButton(), h('button', { class: 'button is-primary', onclick: submit }, person ? 'Save' : 'Add')])
}

export function meetingNoteForm (person, note) {
  const draft = note || { at: Date.now(), where: currentPlace(), text: '', todos: [], tags: [], contact: {} }
  const known = draft.contact
  const at = h('input', { type: 'datetime-local', value: localDateTime(draft.at) })
  const where = h('input', { value: draft.where, placeholder: 'Where you met' })
  const text = h('textarea', { placeholder: 'What you talked about' })
  const todos = h('textarea', { placeholder: 'One follow-up per line' })
  const tags = h('input', { value: draft.tags.join(', '), placeholder: 'hiring, collaboration' })
  const contact = {
    email: h('input', { type: 'email', value: known.email || '' }),
    phone: h('input', { type: 'tel', value: known.phone || '' }),
    linkedin: h('input', { value: known.linkedin || '' }),
    web: h('input', { value: known.web || '' }),
    other: h('input', { value: known.other || '' }),
  }
  text.value = draft.text
  todos.value = draft.todos.map(t => t.text).join('\n')
  const submit = () => {
    // A follow-up kept with the same wording keeps its checkmark.
    const wasDone = new Map(draft.todos.map(t => [t.text, t.done]))
    const record = {
      id: draft.id || newId(),
      at: Date.parse(at.value) || Date.now(),
      where: where.value.trim(),
      text: text.value,
      todos: todos.value.split('\n').map(line => line.trim()).filter(Boolean).map(line => ({ text: line, done: !!wasDone.get(line) })),
      tags: tags.value.split(',').map(tag => tag.trim()).filter(Boolean),
      contact: Object.fromEntries(Object.entries(contact).map(([key, input]) => [key, input.value.trim()])),
      updated: Date.now(),
    }
    if (note) Object.assign(note, record)
    else person.notes.unshift(record)
    person.status = 'met'
    person.updated = Date.now()
    closeDialog()
    save()
    renderAll()
    notify(note ? 'Note updated' : `Saved a note for ${person.name}`)
  }
  openDialog(note ? `Edit note for ${person.name}` : `Met ${person.name}`,
    h('div', { class: 'form-grid' },
      formField('When', at), formField('Where', where),
      formField('Notes', text, true), formField('Follow-ups', todos, true),
      formField('Tags', tags, true),
      formField('Email', contact.email), formField('Phone', contact.phone),
      formField('LinkedIn', contact.linkedin), formField('Website', contact.web), formField('Other contact', contact.other, true)),
    [cancelButton(), h('button', { class: 'button is-primary', onclick: submit }, 'Save note')])
}
