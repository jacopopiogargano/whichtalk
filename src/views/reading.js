// Reading list and exports: starred papers (items of paper tracks, anything with an OpenReview id) as
// BibTeX or a Markdown checklist, a per-paper "read" mark (data.readList, synced and backed up),
// and the Export dialog that also offers the calendar file and the printed plan.
import { h, saveFile } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { count, num, normalize } from '../lib/text.js'
import { eventsById } from '../data/catalog.js'
import { CONFERENCE_ID, CONFERENCE_NAME, PAPER_TRACKS, eventPageUrl, openreviewUrl } from '../data/conference.js'
import { data, prefs, save } from '../state/store.js'
import { isDocument } from '../search/index.js'
import { inLocation } from '../plan/filters.js'
import { buildIcs } from '../plan/calendar.js'
import { openDialog, closeDialog } from '../ui/dialog.js'
import { renderOverlay } from '../ui/overlay.js'
import { planEvents, printPlan } from './plan.js'

// Words skipped when picking the title word of a citation key.
const CITATION_STOPWORDS = new Set(['a', 'an', 'the', 'on', 'of', 'for', 'to', 'in', 'and', 'with', 'via', 'towards', 'toward', 'is', 'are', 'from', 'by', 'at'])

export const isPaper = e => !!e && !e.personal && isDocument(e) && (PAPER_TRACKS.has(e.track) || !!e.openreviewId)

// '' when the conference publishes neither page.
const paperLink = e => (e.openreviewId && openreviewUrl(e)) || eventPageUrl(e)
const conferenceYear = () => (CONFERENCE_NAME.match(/\d{4}/) || [''])[0]

// Starred papers in time order (time TBA last).
const starredPapers = () => [...data.starred].map(id => eventsById.get(id)).filter(isPaper)
  .sort((a, b) => (a.start || 9e9) - (b.start || 9e9) || a.id - b.id)

// LaTeX-safe field text; braces are dropped rather than escaped.
const bibtexText = s => String(s || '').replace(/\\/g, '\\textbackslash{}').replace(/([&%$#_])/g, '\\$1').replace(/[{}]/g, '')
  .replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}')

// Keys look like smith2026diffusion; repeats get b, c, ... appended.
export function bibtexFor (papers) {
  const year = conferenceYear()
  const asciiWord = s => normalize(s).replace(/[^a-z0-9]+/g, '')
  const seen = new Map()
  const entry = e => {
    const authors = e.authors || []
    const surname = authors.length ? asciiWord(authors[0].split(/\s+/).pop()) : ''
    const titleWord = normalize(e.title).split(/[^a-z0-9]+/).find(w => w.length > 2 && !CITATION_STOPWORDS.has(w)) || 'paper'
    let key = `${surname || 'anon'}${year}${titleWord}`
    const repeats = seen.get(key) || 0
    seen.set(key, repeats + 1)
    if (repeats) key += String.fromCharCode(97 + repeats)
    const url = paperLink(e)
    return [
      `@inproceedings{${key},`,
      `  title = {${bibtexText(e.title)}},`,
      `  author = {${authors.map(bibtexText).join(' and ') || 'Unknown'}},`,
      `  booktitle = {${CONFERENCE_NAME}},`,
      `  year = {${year}},`,
      url && `  url = {${url}},`,
      '}',
    ].filter(Boolean).join('\n')
  }
  return papers.map(entry).join('\n\n') + '\n'
}

export function readingListMarkdown (papers) {
  const markdownText = s => String(s).replace(/([\\[\]()*_`])/g, '\\$1')
  const line = e => {
    const authors = e.authors || []
    const byline = authors.length ? `, ${markdownText(authors[0])}${authors.length > 1 ? ' et al.' : ''}` : ''
    const url = paperLink(e)
    const title = url ? `[${markdownText(e.title)}](${url})` : markdownText(e.title)
    return `- [${data.readList.has(e.id) ? 'x' : ' '}] ${title}${byline}`
  }
  return [`# Reading list, ${CONFERENCE_NAME}`, '', ...papers.map(line), ''].join('\n')
}

export function toggleReadMark (id) {
  if (data.readList.has(id)) data.readList.delete(id)
  else data.readList.add(id)
  save()
  renderOverlay()
}

export function openExportPanel () {
  const items = planEvents().filter(e => inLocation(e))
  const papers = starredPapers()
  const reminder = prefs.reminderMinutes ? `, reminder ${prefs.reminderMinutes} min before` : ', no reminders'
  const readCount = papers.filter(e => data.readList.has(e.id)).length
  const choice = (title, meta, iconName, run, disabled) => h('button', { class: 'item is-option', disabled: disabled || null, onclick: () => { closeDialog(); run() } },
    h('span', { class: 'item-body' }, h('span', { class: 'item-title' }, title), h('span', { class: 'item-meta' }, meta)),
    h('span', { class: 'item-chevron' }, icon(iconName)))
  openDialog('Export',
    h('div', {},
      h('div', { class: 'panel' },
        choice('Calendar (.ics)', count(items.filter(e => e.start).length, 'item') + reminder, 'cal',
          () => saveFile(`${CONFERENCE_ID}-my-plan.ics`, buildIcs(items), 'text/calendar'), !items.length),
        choice('Reading list, BibTeX', count(papers.length, 'paper'), 'down',
          () => saveFile(`${CONFERENCE_ID}-reading-list.bib`, bibtexFor(papers), 'application/x-bibtex'), !papers.length),
        choice('Reading list, Markdown', `${count(papers.length, 'paper')}, ${num(readCount)} read`, 'down',
          () => saveFile(`${CONFERENCE_ID}-reading-list.md`, readingListMarkdown(papers), 'text/markdown'), !papers.length),
        choice('Print', 'My plan as a list', 'print', printPlan, !items.length)),
      h('p', { class: 'helper' }, 'Reminders are set under You, Calendar reminders. Files are created on this device.')),
    [h('button', { class: 'button', onclick: () => closeDialog() }, 'Done')])
}
