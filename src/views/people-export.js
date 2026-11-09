// File exports of contacts and meeting notes: Markdown, CSV and vCard 3.0. The files keep the
// column names and status words of earlier versions ('meet', 'met', 'skip'), so spreadsheets and
// scripts built on them keep working.
import { CONFERENCE_NAME } from '../data/conference.js'

const EXPORT_STATUS_WORDS = { 'to-meet': 'meet', met: 'met', skipped: 'skip' }
const CSV_COLUMNS = ['name', 'affiliation', 'status', 'priority', 'why', 'met_at', 'where', 'notes', 'follow_ups', 'tags', 'email', 'phone', 'linkedin', 'website', 'other']

const statusWord = status => EXPORT_STATUS_WORDS[status] || status
const filledContactFields = note => Object.entries(note.contact || {}).filter(([, value]) => value)
const isoMinute = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

export function peopleMarkdown (people) {
  const out = [`# ${CONFERENCE_NAME} — people`, '']
  for (const p of people) {
    out.push(`## ${p.name}${p.affiliation ? ` (${p.affiliation})` : ''}`, '', `- Status: ${statusWord(p.status)}${p.reason ? `\n- Why: ${p.reason}` : ''}`)
    for (const link of p.links) out.push(`- ${link}`)
    for (const note of p.notes) {
      out.push('', `### ${isoMinute(note.at)}${note.where ? ' — ' + note.where : ''}`, '')
      if (note.text) out.push(note.text, '')
      for (const todo of note.todos) out.push(`- [${todo.done ? 'x' : ' '}] ${todo.text}`)
      const contact = filledContactFields(note).map(([key, value]) => `${key}: ${value}`)
      if (contact.length) out.push('', contact.join(' · '))
      if (note.tags.length) out.push('', note.tags.map(tag => '#' + tag).join(' '))
    }
    out.push('')
  }
  return out.join('\n')
}

// One row per meeting note (or one row for a person without notes), CRLF line ends.
export function peopleCsv (people) {
  const cell = value => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`
  const rows = [CSV_COLUMNS]
  for (const p of people) {
    const person = [p.name, p.affiliation, statusWord(p.status), p.priority, p.reason]
    if (!p.notes.length) rows.push([...person, ...new Array(CSV_COLUMNS.length - person.length).fill('')])
    for (const note of p.notes) {
      const c = note.contact
      const todos = note.todos.map(todo => (todo.done ? '[x] ' : '[ ] ') + todo.text).join('; ')
      rows.push([...person, new Date(note.at).toISOString(), note.where, note.text, todos, note.tags.join('; '), c.email, c.phone, c.linkedin, c.web, c.other])
    }
  }
  return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n'
}

const vcardText = s => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => '\\' + m)

function vcardFor (p) {
  // Notes are stored newest first; walking them oldest first lets the newest value of a field win.
  const contact = {}
  for (const note of [...p.notes].reverse()) for (const [key, value] of filledContactFields(note)) contact[key] = value
  const parts = p.name.split(/\s+/)
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${vcardText(p.name)}`, `N:${vcardText(parts[parts.length - 1])};${vcardText(parts.slice(0, -1).join(' '))};;;`]
  if (p.affiliation) lines.push(`ORG:${vcardText(p.affiliation)}`)
  if (contact.email) lines.push(`EMAIL;TYPE=INTERNET:${vcardText(contact.email)}`)
  if (contact.phone) lines.push(`TEL;TYPE=CELL:${vcardText(contact.phone)}`)
  for (const url of [contact.web, contact.linkedin, ...p.links].filter(Boolean)) lines.push(`URL:${vcardText(url)}`)
  const summary = [p.reason, ...p.notes.map(note => `${new Date(note.at).toISOString().slice(0, 10)} ${note.where}: ${note.text}`)].filter(Boolean).join('\n')
  if (summary) lines.push(`NOTE:${vcardText(`${CONFERENCE_NAME} — ${summary}`)}`)
  lines.push('END:VCARD')
  return lines.join('\r\n')
}

// Organizations have no vCard.
export function contactsVcard (people) {
  return people.filter(p => p.kind !== 'org').map(vcardFor).join('\r\n') + '\r\n'
}
