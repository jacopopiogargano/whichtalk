// Opt-in interest imports: an OpenAlex or Semantic Scholar author profile, a personal website, or
// pasted text. Nothing is fetched until the user presses a button, every request is labelled with
// what is sent where, and extracted terms wait in a review box before they become interests.
import { h, qs, fill, notify } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { count, num, normalize } from '../lib/text.js'
import { CONFERENCE_SHORT } from '../data/conference.js'
import { local, ui, save } from '../state/store.js'
import { rescore, rankedPicks } from '../search/relevance.js'
import { extractInterests, htmlToText } from '../search/extract.js'
import { inLocation } from '../plan/filters.js'
import { showPanel, renderOverlay } from '../ui/overlay.js'
import { renderAll, navigate } from '../ui/shell.js'
import { addInterest } from './profile.js'

const ORCID_PATTERN = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i
const REVIEW_PRESELECTED = 14

// Text segment in the shape extractInterests reads.
const textSegment = (text, weight) => ({ text, weight })

function showStatus (node, text, tone) {
  node.className = tone ? `status-line is-${tone}` : 'status-line'
  node.textContent = text
}
const reasonOf = err => (err.name === 'AbortError' ? 'timed out' : err.message)

async function fetchJson (url, statusNode, label) {
  showStatus(statusNode, label)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctrl.signal, headers: { Accept: 'application/json' } })
    if (res.status === 429) throw new Error('the service is rate-limiting requests. Try again in a minute')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// Most frequent co-authors, remembered so People can suggest the ones presenting here.
const topCoauthors = tally => [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([name, papers]) => ({ name, papers }))

function openReview (title, summary, found, extra = {}) {
  if (!found.length) {
    notify('No distinctive topics found. Try more text, or add topics by hand.')
    return
  }
  const candidates = found.map((c, k) => ({ text: c.text, weight: c.weight, matches: c.n, picked: k < REVIEW_PRESELECTED }))
  ui.review = { title, summary, candidates, ...extra }
  if (ui.panel !== 'you') showPanel('you')
  else renderOverlay()
  setTimeout(() => { const box = qs('#import-review'); if (box) box.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, 30)
}

function applyReview () {
  const review = ui.review
  let added = 0
  for (const c of review.candidates) if (c.picked && addInterest(c.text, c.weight, review.source || 'import', true)) added++
  if (review.coauthors) local.set('coauthors', review.coauthors)
  ui.review = null
  rescore()
  save()
  renderAll()
  notify(`Added ${count(added, 'interest')}. ${count(rankedPicks(inLocation).length, 'suggestion')} now.`, { action: 'See them', run: () => navigate('foryou') })
}

export function importReview () {
  const review = ui.review
  const picked = review.candidates.filter(c => c.picked).length
  const redraw = change => () => { change(); renderOverlay() }
  const candidateRow = c => h('div', { class: c.picked ? 'interest is-readonly' : 'interest is-readonly is-paused' },
    h('button', { class: 'checkbox interest-text', 'aria-pressed': c.picked ? 'true' : 'false', onclick: redraw(() => { c.picked = !c.picked }) }, h('i'), c.text),
    h('span', { class: 'interest-count' }, count(c.matches, 'match', 'matches')),
    h('span', { class: 'weight' },
      h('button', { class: 'step', 'aria-label': `Lower ${c.text}`, onclick: redraw(() => { c.weight = Math.max(0.5, c.weight - 0.5) }) }, '−'),
      h('span', { class: 'weight-value' }, String(c.weight)),
      h('button', { class: 'step', 'aria-label': `Raise ${c.text}`, onclick: redraw(() => { c.weight = Math.min(3, c.weight + 0.5) }) }, '+')))
  return h('section', { class: 'review-box', id: 'import-review' },
    h('h3', {}, review.title),
    h('p', { class: 'helper' }, `${review.summary}. Select the interests to add; − and + change the weight.`),
    h('div', { class: 'interest-list' }, review.candidates.map(candidateRow)),
    h('div', { class: 'onboarding-actions' },
      h('button', { class: 'button is-primary', disabled: !picked, onclick: applyReview }, `Add ${count(picked, 'interest')}`),
      h('button', { class: 'button', onclick: redraw(() => { for (const c of review.candidates) c.picked = true }) }, 'Select all'),
      h('button', { class: 'button', onclick: redraw(() => { ui.review = null }) }, 'Discard')))
}

// ---------- author profiles ----------

function authorChoice (name, affiliation, stats, topics, onPick) {
  const pick = ev => { ev.currentTarget.setAttribute('aria-pressed', 'true'); onPick() }
  return h('button', { class: 'candidate', onclick: pick },
    h('span', {}, h('b', {}, name), h('small', {}, affiliation), h('small', {}, stats), topics ? h('small', {}, topics) : null))
}

async function searchSemanticScholar (query, statusNode, results) {
  const found = await fetchJson(`https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(query)}&fields=name,affiliations,paperCount,citationCount&limit=8`,
    statusNode, `Searching api.semanticscholar.org for “${query}”`)
  const authors = (found.data || []).filter(a => a.paperCount)
  showStatus(statusNode, authors.length ? `${count(authors.length, 'match', 'matches')}. Pick your profile:` : 'No authors found. Check the spelling or try OpenAlex.', 'ok')
  fill(results, authors.map(a => authorChoice(a.name, (a.affiliations || []).join(', '),
    `${num(a.paperCount)} papers, ${num(a.citationCount || 0)} citations`, '', () => importSemanticScholar(a, statusNode))))
}

async function searchOpenAlex (raw, query, statusNode, results) {
  const orcid = (raw.match(ORCID_PATTERN) || [])[1]
  const fields = 'select=id,display_name,orcid,works_count,cited_by_count,last_known_institutions,topics'
  const url = orcid
    ? `https://api.openalex.org/authors?filter=orcid:${orcid}&${fields}`
    : `https://api.openalex.org/authors?search=${encodeURIComponent(query)}&per-page=8&${fields}`
  const found = await fetchJson(url, statusNode, `Searching api.openalex.org for ${orcid ? 'ORCID ' + orcid : `“${query}”`}`)
  const authors = (found.results || []).filter(a => a.works_count > 0)
  showStatus(statusNode, authors.length
    ? `${count(authors.length, 'match', 'matches')}. Pick your profile; affiliation and topics help:`
    : 'No authors found. Check the spelling, try an ORCID, or try Semantic Scholar.', 'ok')
  fill(results, authors.map(a => authorChoice(a.display_name,
    (a.last_known_institutions || []).map(i => i.display_name).filter(Boolean).slice(0, 2).join(', ') || 'Affiliation unknown',
    `${num(a.works_count)} works, ${num(a.cited_by_count || 0)} citations`,
    (a.topics || []).slice(0, 3).map(t => t.display_name).join(', '),
    () => importOpenAlex(a, statusNode))))
}

async function findAuthor (input, source, statusNode, results) {
  const raw = input.trim()
  results.replaceChildren()
  if (!raw) {
    showStatus(statusNode, 'Type your name as it appears on your papers, or an ORCID.', 'error')
    return
  }
  if (/scholar\.google\./i.test(raw) && !/\s/.test(raw.replace(/https?:\/\/\S+/, '').trim())) {
    showStatus(statusNode, 'Google Scholar can’t be read by other websites. Type your name instead to find the same papers on OpenAlex.', 'error')
    return
  }
  const query = raw.replace(/https?:\/\/\S+/g, '').trim()
  try {
    if (source === 's2') await searchSemanticScholar(query, statusNode, results)
    else await searchOpenAlex(raw, query, statusNode, results)
  } catch (err) {
    showStatus(statusNode, `Couldn’t reach ${source === 's2' ? 'Semantic Scholar' : 'OpenAlex'}: ${reasonOf(err)}. You can paste your paper titles below instead.`, 'error')
  }
}

async function importOpenAlex (author, statusNode) {
  const authorId = String(author.id || '').split('/').pop()
  if (!/^A\d+$/.test(authorId)) {
    showStatus(statusNode, 'Unexpected OpenAlex id', 'error')
    return
  }
  try {
    const fields = 'select=title,publication_year,keywords,topics,authorships'
    let found = await fetchJson(`https://api.openalex.org/works?filter=author.id:${authorId},from_publication_date:2019-01-01&per-page=100&sort=cited_by_count:desc&${fields}`,
      statusNode, `Reading recent works of ${author.display_name} from OpenAlex. Only their OpenAlex id is sent.`)
    let works = found.results || []
    if (works.length < 15) {
      found = await fetchJson(`https://api.openalex.org/works?filter=author.id:${authorId}&per-page=100&sort=cited_by_count:desc&${fields}`, statusNode, 'Few recent works. Reading older ones too.')
      works = found.results || works
    }
    const self = normalize(author.display_name)
    const segments = []
    const tally = new Map()
    for (const work of works) {
      if (work.title) segments.push(textSegment(work.title, 1))
      for (const k of work.keywords || []) segments.push(textSegment(k.display_name, 1.2 * (k.score || 0.5)))
      for (const t of (work.topics || []).slice(0, 2)) segments.push(textSegment(t.display_name, 0.5))
      for (const authorship of work.authorships || []) {
        const name = authorship.author && authorship.author.display_name
        if (name && normalize(name) !== self) tally.set(name, (tally.get(name) || 0) + 1)
      }
    }
    // The profile's own topics weigh most, scaled by how many works carry them.
    const topics = author.topics || []
    const busiest = Math.max(1, ...topics.map(t => t.count || 1))
    for (const t of topics) segments.push(textSegment(t.display_name, 2.5 * (t.count || 1) / busiest))
    showStatus(statusNode, `Read ${count(works.length, 'work')}. Review the extracted interests above.`, 'ok')
    openReview(`OpenAlex: ${author.display_name}`, `${count(works.length, 'paper')}, weighted by how distinctive each topic is at ${CONFERENCE_SHORT}`,
      extractInterests(segments), { source: 'openalex', coauthors: topCoauthors(tally) })
  } catch (err) {
    showStatus(statusNode, `Couldn’t read works: ${reasonOf(err)}`, 'error')
  }
}

async function importSemanticScholar (author, statusNode) {
  if (!/^\d+$/.test(String(author.authorId))) {
    showStatus(statusNode, 'Unexpected Semantic Scholar id', 'error')
    return
  }
  try {
    const found = await fetchJson(`https://api.semanticscholar.org/graph/v1/author/${author.authorId}/papers?fields=title,year,authors&limit=100`, statusNode,
      `Reading papers of ${author.name} from Semantic Scholar. Only their author id is sent.`)
    const papers = found.data || []
    const self = normalize(author.name)
    const tally = new Map()
    for (const paper of papers) {
      for (const co of paper.authors || []) if (co.name && normalize(co.name) !== self) tally.set(co.name, (tally.get(co.name) || 0) + 1)
    }
    showStatus(statusNode, `Read ${count(papers.length, 'paper')}. Review the extracted interests above.`, 'ok')
    openReview(`Semantic Scholar: ${author.name}`, count(papers.length, 'paper'), extractInterests(papers.map(p => textSegment(p.title, 1))),
      { source: 's2', coauthors: topCoauthors(tally) })
  } catch (err) {
    showStatus(statusNode, `Couldn’t read papers: ${reasonOf(err)}`, 'error')
  }
}

// ---------- websites and pasted text ----------

async function importWebsite (raw, statusNode, pasteBox) {
  const address = raw.trim()
  let url
  try {
    url = new URL(/^https?:\/\//i.test(address) ? address : 'https://' + address)
  } catch (err) {
    showStatus(statusNode, 'That doesn’t look like a web address.', 'error')
    return
  }
  if (!/^https?:$/.test(url.protocol)) {
    showStatus(statusNode, 'Only http(s) pages can be read.', 'error')
    return
  }
  showStatus(statusNode, `Requesting ${url.host} directly, without cookies`)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(url.href, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const type = res.headers.get('content-type') || ''
    let text = (await res.text()).slice(0, 1500000)
    if (/html/i.test(type) || /<html|<body/i.test(text)) text = htmlToText(text)
    showStatus(statusNode, `Read ${num(text.length)} characters from ${url.host}.`, 'ok')
    openReview(url.host, 'Website text', extractInterests(text.split('\n').map(line => textSegment(line, 1))), { source: 'website' })
  } catch (err) {
    showStatus(statusNode, `${url.host} doesn’t let other pages read it (no CORS)${err.name === 'AbortError' ? ', or it timed out' : ''}. Open it, copy the text, and paste it below.`, 'error')
    pasteBox.hidden = false
    const area = pasteBox.querySelector('textarea')
    if (area) area.focus()
  } finally {
    clearTimeout(timer)
  }
}

function importText (text, label) {
  const segments = text.split(/\n+/).map(line => textSegment(line, 1))
  openReview(label, `${num(text.length)} characters, processed on this device`, extractInterests(segments), { source: 'text' })
}

function importFromField (selector, label) {
  const text = qs(selector).value
  if (text.trim()) importText(text, label)
}

const privacyNote = text => h('div', { class: 'privacy-note' }, icon('shield'), h('span', {}, text))

function papersImporter () {
  const status = h('div', { class: 'status-line', 'aria-live': 'polite' })
  const results = h('div', { class: 'candidates' })
  let source = 'openalex'
  const search = () => findAuthor(input.value, source, status, results)
  const input = h('input', { id: 'openalex-input', placeholder: 'Your name, ORCID, or Google Scholar URL', 'aria-label': 'Name or ORCID', onkeydown: ev => { if (ev.key === 'Enter') search() } })
  const privacyText = () => (source === 's2'
    ? 'Sends only what you type to api.semanticscholar.org. Google Scholar itself can’t be read by other sites.'
    : 'Sends only what you type to api.openalex.org, an open index of scholarly works. Google Scholar itself can’t be read by other sites.')
  const privacy = privacyNote(privacyText())
  const sources = h('div', { class: 'toggle-group', role: 'group', 'aria-label': 'Source' })
  const drawSources = () => fill(sources, [['openalex', 'OpenAlex'], ['s2', 'Semantic Scholar']].map(([key, label]) => h('button', {
    'aria-pressed': source === key ? 'true' : 'false',
    onclick: () => { source = key; drawSources(); privacy.lastChild.textContent = privacyText() },
  }, label)))
  drawSources()
  return h('div', { class: 'importer' },
    h('h3', {}, 'Your papers'),
    h('p', {}, 'Search by name or ORCID and pick your profile. The titles, keywords and topics of your recent papers are read.'),
    sources,
    h('div', { class: 'autocomplete-row' }, input, h('button', { class: 'button is-primary', onclick: search }, 'Find')),
    privacy, status, results)
}

function websiteImporter () {
  const status = h('div', { class: 'status-line', 'aria-live': 'polite' })
  const pasteBox = h('div', { class: 'importer', hidden: true },
    h('label', { class: 'form-field' }, 'Paste the page text', h('textarea', { id: 'web-paste', placeholder: 'Text of your homepage' })),
    h('button', { class: 'button', onclick: () => importFromField('#web-paste', 'Pasted website text') }, 'Extract interests'))
  const read = () => importWebsite(input.value, status, pasteBox)
  const input = h('input', { id: 'site-url', placeholder: 'https://your-site.example', 'aria-label': 'Website URL', onkeydown: ev => { if (ev.key === 'Enter') read() } })
  return h('div', { class: 'importer' },
    h('h3', {}, 'Personal website'),
    h('p', {}, 'Works when the site lets other pages read it (CORS), as GitHub Pages does. Otherwise paste its text.'),
    h('div', { class: 'autocomplete-row' }, input, h('button', { class: 'button is-primary', onclick: read }, 'Read')),
    privacyNote('Your browser requests the page directly, without cookies. Only its text is read; scripts never run.'),
    status, pasteBox)
}

function textImporter ({ heading, intro, field, id, placeholder, label }) {
  return h('div', { class: 'importer' },
    h('h3', {}, heading),
    h('p', {}, intro),
    h('label', { class: 'form-field' }, field, h('textarea', { id, placeholder })),
    h('button', { class: 'button', onclick: () => importFromField('#' + id, label) }, 'Extract interests'),
    privacyNote('Processed on this device. Nothing is sent.'))
}

export function importersBox () {
  return h('details', { class: 'import-box', open: ui.importOpen || null, ontoggle: ev => { ui.importOpen = ev.target.open } },
    h('summary', {}, 'Import from your papers, website or a text'),
    h('p', { class: 'section-note' }, `Nothing is fetched until you press a button. Text is processed on this device: common words are dropped, phrases are kept, and terms that are frequent at ${CONFERENCE_SHORT} count less.`),
    h('div', { class: 'importers' },
      papersImporter(),
      websiteImporter(),
      textImporter({
        heading: 'LinkedIn',
        intro: 'LinkedIn can’t be read by other sites. Paste your headline, About and experience instead.',
        field: 'Profile text',
        id: 'profile-link-input',
        placeholder: 'Research scientist working on reinforcement learning from human feedback',
        label: 'LinkedIn text',
      }),
      textImporter({
        heading: 'Any text',
        intro: 'A CV, a list of paper titles, a research statement, or keywords.',
        field: 'Text',
        id: 'paste-text',
        placeholder: 'Paste text',
        label: 'Pasted text',
      })))
}
