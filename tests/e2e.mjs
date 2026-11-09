#!/usr/bin/env node
// End-to-end test for the WhichTalk planner (NeurIPS 2026 page). It drives headless Chrome over
// the DevTools protocol and checks what a user sees: text, counts, aria state, the URL hash, downloads
// and copied links.
//
//   node tests/e2e.mjs --url http://localhost:8766/neurips/2026/ [--only name[,name]] [--out dir]
//
// Elements are found by visible text, role and aria-label. The few ids and classes that cannot be
// avoided live in S below. Every scenario runs in a fresh browser context
// (empty storage), with the clock fixed by ?now= and console errors collected on every page.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launch } from './cdp.mjs'

const S = { data: '#catalog-data', page: '#page', toast: '#snackbar', grid: '.time-grid', nowRule: '#now-rule' }

// Fixtures from the catalog (neurips.cc event ids). NOW is Tuesday 8 December 2026, 08:45 AEDT:
// day 1 of the main conference in Sydney, just before the first keynote.
const NOW = '2026-12-07T21:45:00Z'
const DAY = '2026-12-08'
const DAY2 = '2026-12-09'
const DAY3 = '2026-12-10'
const KEYNOTE = { id: 178413, title: 'Scaling Experience in the Wild: Building the Industrial Learning Loop', dtstart: '20261207T220000Z' } // 09:00–10:00
const WIML = { id: 137772, title: 'WiML' } // affinity event 08:00–17:00, overlaps the keynote
const SESSION = { id: 137645, title: 'Sydney Poster Session 1' }
const POSTER = { id: 155228, title: '3D Fresnel Volumizing for Efficient Implicit Velocity Field Reconstruction', openreview: '7JwhEn9uk1' } // abstract, OpenReview, poster image, slides
const POSTER_NO_IMAGE = { id: 156149, openreview: '00MXC2OlRy' } // abstract and OpenReview, no poster image

// ---------- options ----------
const argv = process.argv.slice(2)
const opt = name => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
const BASE = opt('url') || 'http://localhost:8766/neurips/2026/'
const ONLY = opt('only') ? opt('only').split(',') : null
const OUT = opt('out') || path.join(os.tmpdir(), 'whichtalk-e2e')
const app = (hash = '') => `${BASE}?now=${encodeURIComponent(NOW)}${hash}`
const withNow = url => (url.includes('now=') ? url : url.replace(/^([^#?]*)(\?[^#]*)?/, (m, a, q) => `${a}${q ? q + '&' : '?'}now=${encodeURIComponent(NOW)}`))

// ---------- assertions and page helpers ----------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function ok (cond, what) { if (!cond) throw new Error(what) }
function eq (got, want, what) {
  const g = typeof got === 'string' ? got : JSON.stringify(got)
  const w = typeof want === 'string' ? want : JSON.stringify(want)
  if (g !== w) throw new Error(`${what}: expected ${w}, got ${g}`)
}
const has = (text, part, what) => ok(part instanceof RegExp ? part.test(text) : text.includes(part), `${what}: ${part} not found in "${text.slice(0, 300)}"`)
const lacks = (text, part, what) => ok(!(part instanceof RegExp ? part.test(text) : text.includes(part)), `${what}: ${part} should be gone`)

const pageText = p => p.eval(sel => window.__e2e.text(sel), S.page)
const heading = p => p.eval(sel => { const h = document.querySelector(sel + ' h1'); return h ? window.__e2e.norm(h.innerText) : '' }, S.page)
const waitText = (p, part, what = String(part)) => p.waitFor((sel, m) => {
  const t = window.__e2e.text(sel)
  return m && typeof m === 'object' && 're' in m ? new RegExp(m.re, m.flags).test(t) : t.includes(m)
}, [S.page, part], { message: `page text ${what}` })
const waitNoText = (p, part) => p.waitFor((sel, m) => !window.__e2e.text(sel).includes(m), [S.page, part], { message: `"${part}" to disappear` })
const waitHeading = (p, want) => p.waitFor((sel, w) => {
  const h = document.querySelector(sel + ' h1')
  const t = h ? window.__e2e.norm(h.innerText) : ''
  return (w && typeof w === 'object' ? new RegExp(w.re, w.flags).test(t) : t === w) ? t : false
}, [S.page, want], { message: `heading ${want}` })

function hashMatches (want) {
  const h = Object.fromEntries(new URLSearchParams(location.hash.slice(1)))
  const norm = o => JSON.stringify(Object.keys(o).sort().map(k => [k, String(o[k])]))
  return norm(h) === norm(want) ? h : false
}
const waitHash = (p, want) => p.waitFor(hashMatches, [want], { message: `hash ${JSON.stringify(want)}` })
const hashParams = p => p.eval(() => Object.fromEntries(new URLSearchParams(location.hash.slice(1))))

const attr = (p, spec, name) => p.eval((s, n) => { const el = window.__e2e.match(s)[0]; return el ? el.getAttribute(n) : null }, spec, name)
const waitAttr = (p, spec, name, want) => p.waitFor((s, n, w) => { const el = window.__e2e.match(s)[0]; return el && el.getAttribute(n) === w }, [spec, name, want], { message: `${JSON.stringify(spec)} ${name}=${want}` })
const count = (p, css, within = S.page) => p.eval((c, w) => [...document.querySelectorAll(w + ' ' + c)].filter(window.__e2e.visible).length, css, within)

// Toasts are recorded by a MutationObserver; wait for one shown after `mark`.
const toastMark = p => p.eval(() => window.__e2e.toasts.length)
const waitToast = (p, re, mark) => p.waitFor((m, r) => window.__e2e.toasts.slice(m).find(t => new RegExp(r.re, r.flags).test(t)), [mark, re], { message: `toast ${re}` })

// The topmost open dialog: wait until it shows a heading (h1-h4) matching `title`.
const dialogHeading = (p, title) => p.waitFor(t => {
  const d = window.__e2e.topDialog()
  if (!d || !window.__e2e.visible(d)) return false
  const hs = [...d.querySelectorAll('h1, h2, h3, h4')].map(h => window.__e2e.norm(h.innerText))
  return hs.find(h => (t && typeof t === 'object' ? new RegExp(t.re, t.flags).test(h) : h === t)) || false
}, [title], { message: `dialog with heading ${title}` })
const dialogText = p => p.eval(() => { const d = window.__e2e.topDialog(); return d ? window.__e2e.norm(d.innerText) : '' })
const openDialogs = p => p.eval(() => [...document.querySelectorAll('dialog')].filter(d => d.open).length)
async function closeDialog (p) {
  const n = await openDialogs(p)
  await p.click({ label: 'Close', within: 'dialog' })
  await p.waitFor(k => [...document.querySelectorAll('dialog')].filter(d => d.open).length < k, [n], { message: 'dialog to close' })
}

// Today's four numbers: { Saved: ['1', 'Sessions in your plan'], ... } from the "Your plan" group.
const tally = p => p.eval(() => {
  const g = document.querySelector('[role=group][aria-label="Your plan"]')
  if (!g) return null
  const leaves = el => { const out = []; const walk = n => { for (const c of n.childNodes) { if (c.nodeType === 3) { const s = c.textContent.trim(); if (s) out.push(s) } else if (c.nodeType === 1) walk(c) } }; walk(el); return out }
  return Object.fromEntries([...g.querySelectorAll('button')].map(b => { const [k, v, ...rest] = leaves(b); return [k, [v, rest.join(' ')]] }))
})
async function waitTally (p, want) {
  await p.waitFor((w) => {
    const g = document.querySelector('[role=group][aria-label="Your plan"]')
    if (!g) return false
    const t = window.__e2e.norm(g.innerText)
    return Object.entries(w).every(([k, v]) => [...g.querySelectorAll('button')].some(b => { const s = window.__e2e.norm(b.innerText); return s.startsWith(k) && s.slice(k.length).trim().startsWith(v) })) && t
  }, [want], { message: `Today tally ${JSON.stringify(want)}` })
}

async function tab (p, name) {
  await p.click({ role: 'tab', text: new RegExp('^' + name), within: 'body' })
  const want = { Today: /^\w+day, \w+ \d+$/, Schedule: 'Schedule', 'My plan': 'My plan' }[name]
  if (want) await waitHeading(p, want)
}
async function openYou (p) {
  // The panel may already be open: p=you in the hash reopens it after a reload.
  const open = await p.eval(() => { const d = window.__e2e.topDialog(); return !!d && [...d.querySelectorAll('h1, h2, h3')].some(h => window.__e2e.norm(h.innerText) === 'You') })
  if (!open) await p.click({ label: 'You: interests, sync and backup', within: 'body' })
  await dialogHeading(p, 'You')
  eq(await attr(p, { label: 'You: interests, sync and backup', within: 'body' }, 'aria-pressed'), 'true', 'You button pressed')
}
async function star (p, id, within = S.page) {
  const spec = { css: `[data-star="${id}"]`, within }
  const was = await attr(p, spec, 'aria-pressed')
  await p.click(spec)
  await waitAttr(p, spec, 'aria-pressed', was === 'true' ? 'false' : 'true')
}
async function addInterest (p, text) {
  await openYou(p)
  const m = await toastMark(p)
  await p.typeInto('Add an interest', text, 'dialog')
  await p.press('Enter')
  await waitToast(p, new RegExp(`^Added “${text}”, [\\d,]+ match`), m)
  await p.waitFor(t => window.__e2e.match({ label: 'Pause ' + t, within: 'dialog' }).length, [text], { message: 'interest row' })
  await closeDialog(p)
}
async function addPerson (p, name, aff) {
  await p.click({ role: 'tab', text: 'People', within: S.page })
  await p.click({ text: 'Add person', within: S.page })
  await dialogHeading(p, 'Add someone to meet')
  await p.fill('Name', name, 'dialog')
  if (aff) await p.fill('Affiliation', aff, 'dialog')
  await p.fill('Why', 'Ask about their work', 'dialog')
  await p.click({ text: 'Add', within: 'dialog' })
  await p.waitFor(() => !window.__e2e.topDialog(), [], { message: 'person form to close' })
  await waitText(p, name)
}
async function download (p, clickSpec, name) {
  const before = (await p.downloads()).length
  await p.click(clickSpec)
  return p.waitDownload(before, { name })
}
const unfold = ics => ics.replace(/\r\n[ \t]/g, '')

// ---------- scenarios ----------
const scenarios = {
  async boot (ctx) {
    const p = await ctx.open()
    eq(await p.eval(() => document.title), 'WhichTalk · NeurIPS 2026', 'document title')
    const tabs = await p.eval(() => window.__e2e.match({ role: 'tab', within: 'body' }).map(e => [window.__e2e.name(e), e.getAttribute('aria-selected')]))
    eq(tabs, [['Today', 'true'], ['Schedule', 'false'], ['My plan', 'false']], 'nav tabs')
    eq(await heading(p), 'Tuesday, December 8', 'Today heading')
    eq(await tally(p), { Saved: ['0', 'Star sessions in the schedule'], Overlaps: ['0', 'Nothing clashes'], 'People to meet': ['0', 'Add people to meet'], Interests: ['0', 'Add your interests'] }, 'tally')
    const t = await pageText(p)
    for (const s of ['Main conference', 'AEDT', 'Your day', 'Suggested for you', 'Add interests']) has(t, s, 'Today')
    ok(await p.eval(sel => !!document.querySelector(sel), S.nowRule), 'Now rule on Today')
    ok(await p.eval(() => window.__ready === true && typeof window.__bootMs === 'number' && typeof window.__indexMs === 'number' && performance.getEntriesByName('app-ready').length === 1), 'boot hooks')
    eq(await p.eval(() => location.hash), '', 'hash on Today')
  },

  async navigation (ctx) {
    const p = await ctx.open()
    await tab(p, 'Schedule')
    await waitHash(p, { v: 'schedule', d: DAY })
    eq(await attr(p, { role: 'tab', text: 'Schedule', within: 'body' }, 'aria-selected'), 'true', 'Schedule tab selected')
    await tab(p, 'My plan')
    await waitHash(p, { v: 'plan' })
    await tab(p, 'Today')
    await waitHash(p, {})
    await p.press('2'); await waitHeading(p, 'Schedule'); await waitHash(p, { v: 'schedule', d: DAY })
    await p.press('3'); await waitHeading(p, 'My plan'); await waitHash(p, { v: 'plan' })
    await p.press('1'); await waitHeading(p, 'Tuesday, December 8'); await waitHash(p, {})
    // deep links, on load and by hashchange
    await p.goto(app(`#v=schedule&d=${DAY2}`))
    await waitHeading(p, 'Schedule')
    await waitAttr(p, { css: '[aria-label="Day"] button', text: /^Wednesday, December 9/, within: S.page }, 'aria-pressed', 'true')
    await p.goto(app('#v=plan&t=people'))
    await waitAttr(p, { role: 'tab', text: 'People', within: S.page }, 'aria-selected', 'true')
    await waitText(p, 'Add person')
    await p.eval(d => { location.hash = `v=schedule&d=${d}` }, DAY3)
    await waitAttr(p, { css: '[aria-label="Day"] button', text: /^Thursday, December 10/, within: S.page }, 'aria-pressed', 'true')
    // #e= opens the detail overlay; closing it restores the view and its hash
    await p.goto(app(`#e=${KEYNOTE.id}`))
    await dialogHeading(p, KEYNOTE.title)
    await closeDialog(p)
    await waitHash(p, {})
    eq(await heading(p), 'Tuesday, December 8', 'Today behind the overlay')
    await p.goto(app(`#v=schedule&d=${DAY}&e=${WIML.id}`))
    await dialogHeading(p, WIML.title)
    await closeDialog(p)
    await waitHash(p, { v: 'schedule', d: DAY })
    eq(await heading(p), 'Schedule', 'Schedule behind the overlay')
  },

  async schedule (ctx) {
    const p = await ctx.open(`#v=schedule&d=${DAY}`)
    const days = await p.eval(sel => window.__e2e.match({ css: '[aria-label="Day"] button', within: sel }).map(b => [window.__e2e.name(b), b.getAttribute('aria-pressed')]), S.page)
    ok(days.length >= 7, 'day picker has the Sydney days: ' + JSON.stringify(days))
    eq(days.filter(d => d[1] === 'true').map(d => d[0]), ['Tuesday, December 8'], 'selected day')
    await p.click({ css: '[aria-label="Day"] button', text: /^Wednesday, December 9/, within: S.page })
    await waitHash(p, { v: 'schedule', d: DAY2 })
    await waitText(p, 'Wednesday, December 9')
    const sessions = async () => Number(((await pageText(p)).match(/([\d,]+) sessions?\b/) || [])[1].replace(/,/g, ''))
    const n = await sessions()
    ok(n > 5, 'sessions on Wednesday: ' + n)
    ok(await count(p, '[data-id]') > 5, 'Schedule list rows')
    await p.press('ArrowRight'); await waitHash(p, { v: 'schedule', d: DAY3 })
    await p.press('ArrowLeft'); await waitHash(p, { v: 'schedule', d: DAY2 })
    // rooms grid (m=rooms reaches the hash on the next navigation, not on the toggle itself)
    const roomsGrid = () => p.waitFor(sel => { const g = document.querySelector(sel); return g && /Hall 1-4/.test(g.innerText) }, [`${S.page} ${S.grid}`], { message: 'rooms grid' })
    await p.click({ text: 'By room', within: S.page })
    await roomsGrid()
    await waitAttr(p, { text: 'By room', within: S.page }, 'aria-pressed', 'true')
    eq(await attr(p, { text: 'List', within: S.page }, 'aria-pressed'), 'false', 'List not pressed')
    await p.press('ArrowRight'); await waitHash(p, { v: 'schedule', d: DAY3, m: 'rooms' })
    await roomsGrid()
    await p.goto(app(`#v=schedule&d=${DAY2}&m=rooms`))
    await roomsGrid()
    await p.click({ text: 'List', within: S.page })
    await waitAttr(p, { text: 'List', within: S.page }, 'aria-pressed', 'true')
    await p.waitFor(sel => !document.querySelector(sel), [`${S.page} ${S.grid}`], { message: 'grid gone in list layout' })
    await p.press('ArrowRight'); await p.press('ArrowLeft')
    await waitHash(p, { v: 'schedule', d: DAY2 })
    // filter panel: toggle a track, counts and summary change, Reset restores
    await p.click({ text: 'Filter', within: S.page })
    await dialogHeading(p, 'Filter')
    const posters = { role: 'menuitemcheckbox', text: /^Posters\b/, within: 'dialog' }
    eq(await attr(p, posters, 'aria-checked'), 'true', 'Posters checked')
    eq(await attr(p, { role: 'menuitemcheckbox', text: /^Breaks\b/, within: 'dialog' }, 'aria-checked'), 'false', 'Breaks off by default')
    has(await dialogText(p), /Posters [\d,]+/, 'Posters count in the filter')
    await p.click(posters)
    await waitAttr(p, posters, 'aria-checked', 'false')
    await waitText(p, '6 of 8 types')
    await p.waitFor(sel => window.__e2e.match({ text: 'Filter (1)', within: sel }).length, [S.page], { message: 'Filter (1) button' })
    ok(await sessions() < n, 'fewer sessions without posters')
    await p.click({ text: 'Reset', within: 'dialog' })
    await waitAttr(p, posters, 'aria-checked', 'true')
    await waitNoText(p, '6 of 8 types')
    eq(await sessions(), n, 'sessions after Reset')
    await p.click({ text: 'Done', within: 'dialog' })
    await p.waitFor(() => !window.__e2e.topDialog(), [], { message: 'filter closed' })
  },

  async search (ctx) {
    const p = await ctx.open()
    await p.press('/')
    await p.waitFor(() => { const a = document.activeElement; return a && a.tagName === 'INPUT' && a.getAttribute('aria-label') === 'Search' && window.__e2e.visible(a) }, [], { message: 'focused search field' })
    await p.type('diffusion')
    await waitHeading(p, 'Results for “diffusion”')
    await waitHash(p, { q: 'diffusion' })
    const t = await pageText(p)
    const m = t.match(/([\d,]+) sessions? and ([\d,]+) papers?/)
    ok(m && Number(m[1].replace(/,/g, '')) + Number(m[2].replace(/,/g, '')) > 10, 'result counts: ' + (m && m[0]))
    ok(await count(p, '[data-id]') > 0, 'result rows')
    ok(await p.eval(sel => [...document.querySelectorAll(sel + ' mark')].filter(x => /diffusion/i.test(x.textContent)).length > 3, S.page), 'highlighted matches')
    await p.press('Escape')
    await waitHeading(p, 'Tuesday, December 8')
    await waitHash(p, {})
    ok(await p.eval(() => ![...document.querySelectorAll('input[aria-label="Search"]')].some(i => window.__e2e.visible(i) && i.value)), 'search cleared')
  },

  async star (ctx) {
    const p = await ctx.open(`#v=schedule&d=${DAY}`)
    let m = await toastMark(p)
    await star(p, KEYNOTE.id)
    await waitToast(p, /^Saved to My plan/, m)
    eq(await attr(p, { css: `[data-star="${KEYNOTE.id}"]`, within: S.page }, 'aria-label'), 'Remove from My plan', 'star label')
    await tab(p, 'Today')
    await waitTally(p, { Saved: '1', Overlaps: '0' })
    await waitText(p, KEYNOTE.title)
    await tab(p, 'My plan')
    await waitText(p, KEYNOTE.title)
    await waitText(p, '1 saved item')
    // a second, overlapping item
    await tab(p, 'Schedule')
    await waitHash(p, { v: 'schedule', d: DAY })
    m = await toastMark(p)
    await star(p, WIML.id)
    await waitToast(p, new RegExp(`^Saved\\. Overlaps with “${KEYNOTE.title.slice(0, 30)}`), m)
    await tab(p, 'Today')
    await waitTally(p, { Saved: '2', Overlaps: '1' })
    ok(await p.exists({ css: '[title="1 overlap"]', within: 'body' }), 'overlap badge on My plan')
    await tab(p, 'My plan')
    await waitText(p, '1 overlap')
    await waitText(p, `Overlaps with “${WIML.title}”`)
    await waitText(p, `Overlaps with “${KEYNOTE.title}”`)
    // unstar from My plan, then Undo
    m = await toastMark(p)
    await p.click({ css: `[data-star="${KEYNOTE.id}"]`, within: S.page })
    await waitToast(p, /^Removed from My plan/, m)
    await p.waitFor(sel => !document.querySelector(sel), [`${S.page} [data-id="${KEYNOTE.id}"]`], { message: 'keynote removed from My plan' })
    await p.click({ text: 'Undo', within: S.toast })
    await waitAttr(p, { css: `[data-star="${KEYNOTE.id}"]`, within: S.page }, 'aria-pressed', 'true')
    await waitText(p, '2 saved items')
  },

  async detail (ctx) {
    const p = await ctx.open(`#v=schedule&d=${DAY}`)
    await p.click({ css: `[data-id="${SESSION.id}"]`, within: S.page })
    await dialogHeading(p, SESSION.title)
    await dialogHeading(p, 'Posters in this session')
    await p.typeInto('Filter posters in this session', '3D Fresnel', 'dialog')
    await p.click({ css: `[data-id="${POSTER.id}"]`, within: 'dialog' })
    await dialogHeading(p, POSTER.title)
    await waitHash(p, { v: 'schedule', d: DAY, e: POSTER.id })
    ok(await p.exists({ label: 'Back', within: 'dialog' }), 'Back button')
    const abstract = await p.waitFor(() => {
      const h = [...window.__e2e.topDialog().querySelectorAll('h4, h3')].find(x => window.__e2e.norm(x.innerText) === 'Abstract')
      const t = h ? window.__e2e.norm(h.parentElement.innerText).replace(/^Abstract/, '').trim() : ''
      return t.length > 200 && !/Couldn’t load/.test(t) ? t : false
    }, [], { message: 'abstract text' })
    ok(abstract.length > 200, 'abstract length')
    const links = await p.eval(() => Object.fromEntries([...window.__e2e.topDialog().querySelectorAll('a[href]')].map(a => [window.__e2e.name(a), a.href])))
    has(links.OpenReview || '', `openreview.net/forum?id=${POSTER.openreview}`, 'OpenReview link')
    has(links.Poster || '', `PosterPDFs/NeurIPS%202026/${POSTER.id}.png`, 'Poster link')
    has(links['neurips.cc'] || '', `showEvent=${POSTER.id}`, 'neurips.cc link')
    has(links.Slides || '', 'Slides', 'Slides link')
    ok(await p.exists({ text: 'Add to calendar', within: 'dialog' }), 'Add to calendar')
    // add an author to People from the author list
    const m = await toastMark(p)
    await p.click({ label: /^Add .+ to People$/, within: 'dialog' })
    await waitToast(p, /^Added .+ to People/, m)
    await p.waitFor(() => /\(in People\)/.test(window.__e2e.topDialog().innerText), [], { message: '(in People)' })
    await p.click({ label: 'Back', within: 'dialog' })
    await dialogHeading(p, SESSION.title)
    await closeDialog(p)
    await waitHash(p, { v: 'schedule', d: DAY })
    // links follow the data: this poster has no poster image
    await p.goto(app(`#e=${POSTER_NO_IMAGE.id}`))
    await dialogHeading(p, 'Abstract')
    const links2 = await p.eval(() => [...window.__e2e.topDialog().querySelectorAll('a[href]')].map(a => window.__e2e.name(a)))
    ok(links2.includes('OpenReview') && !links2.includes('Poster'), 'links without poster image: ' + links2)
  },

  async interests (ctx) {
    const p = await ctx.open()
    await addInterest(p, 'reinforcement learning')
    await waitTally(p, { Interests: '1' })
    await waitText(p, 'Matches reinforcement learning')
    await tab(p, 'Schedule')
    await waitText(p, /[\d,]+ match your interests/)
    await tab(p, 'Today')
    await p.click({ text: 'See all', within: S.page })
    await waitHeading(p, 'Suggested for you')
    await waitText(p, /[\d,]+ suggestions from 1 active interest/)
    ok(await p.exists({ label: 'More like this', within: S.page }), 'picks have feedback buttons')
    let m = await toastMark(p)
    await p.click({ label: 'Not for me', within: S.page })
    await waitToast(p, /^Hidden\. Lowered reinforcement learning/, m)
    await p.click({ text: 'Undo', within: S.toast })
    // plan my day: a draft, Apply, Undo
    await tab(p, 'Today')
    await p.click({ text: 'Plan my day', within: S.page })
    await dialogHeading(p, 'Plan Tuesday, December 8')
    await dialogHeading(p, 'Preview')
    has(await dialogText(p), 'A draft for Tuesday, December 8 from your interests', 'planner draft')
    m = await toastMark(p)
    await p.click({ text: /^Apply [\d,]+ changes?$/, within: 'dialog' })
    const t = await waitToast(p, /^Plan applied: [\d,]+ items? added/, m)
    const added = t.match(/^Plan applied: ([\d,]+)/)[1]
    ok(Number(added) > 0, 'items added')
    await p.waitFor(() => !window.__e2e.topDialog(), [], { message: 'planner closed' })
    await waitTally(p, { Saved: added })
    await p.click({ text: 'Undo', within: S.toast })
    await waitTally(p, { Saved: '0' })
  },

  async personal (ctx) {
    const p = await ctx.open('#v=plan')
    await p.click({ text: 'Event', within: S.page })
    await dialogHeading(p, 'New event')
    await p.fill('Title', 'Coffee with Ada', 'dialog')
    await p.fill('Day', 'Tuesday, December 8', 'dialog')
    await p.fill('Starts', '11:00', 'dialog')
    await p.fill('Ends', '11:45', 'dialog')
    await p.fill('Place', 'Foyer', 'dialog')
    const m = await toastMark(p)
    await p.click({ text: 'Add event', within: 'dialog' })
    await waitToast(p, /^Event added to My plan/, m)
    await waitText(p, 'Coffee with Ada')
    has(await pageText(p), /Tuesday, December 8.*Coffee with Ada/, 'event under its day in My plan')
    await p.click({ text: 'Week', within: S.page })
    await p.waitFor(sel => { const g = document.querySelector(sel); return g && g.innerText.includes('Coffee with Ada') }, [`${S.page} ${S.grid}`], { message: 'event in the week grid' })
    await p.click({ text: 'List', within: S.page })
    await tab(p, 'Today')
    await waitText(p, 'Coffee with Ada')
    await p.click({ css: '[role=button]', text: /Coffee with Ada/, within: S.page })
    await dialogHeading(p, 'Coffee with Ada')
    const d = await dialogText(p)
    for (const s of ['Personal, meeting', 'Foyer', 'Edit', 'Delete']) has(d, s, 'personal event detail')
  },
}

Object.assign(scenarios, {
  async people (ctx) {
    const p = await ctx.open('#v=plan&t=people')
    await addPerson(p, 'Grace Hopper', 'US Navy')
    const status = name => ({ css: '[role=group][aria-label="Status of Grace Hopper"] button', text: name, within: S.page })
    eq(await attr(p, status('To meet'), 'aria-pressed'), 'true', 'status To meet')
    await p.click({ text: 'Add note', within: S.page })
    await dialogHeading(p, 'Met Grace Hopper')
    await p.fill('Notes', 'Talked about COBOL', 'dialog')
    await p.fill('Follow-ups', 'Send the compiler paper', 'dialog')
    const m = await toastMark(p)
    await p.click({ text: 'Save note', within: 'dialog' })
    await waitToast(p, /^Saved a note for Grace Hopper/, m)
    await waitAttr(p, status('Met'), 'aria-pressed', 'true')
    await p.click({ role: 'tab', text: 'Notes', within: S.page })
    await waitText(p, 'Follow-ups')
    const t = await pageText(p)
    for (const s of ['1 open', 'Send the compiler paper', 'Meeting notes', 'Talked about COBOL']) has(t, s, 'Notes')
    await p.click({ text: 'Export', within: S.page })
    await dialogHeading(p, 'Export people and notes')
    const md = await download(p, { text: 'Markdown', within: 'dialog' }, /\.md$/)
    has(md.text, '## Grace Hopper (US Navy)', 'Markdown export')
    has(md.text, 'Send the compiler paper', 'Markdown export follow-up')
    await p.click({ text: 'Export', within: S.page })
    await dialogHeading(p, 'Export people and notes')
    const vcf = await download(p, { text: 'vCard', within: 'dialog' }, /\.vcf$/)
    has(vcf.text, 'FN:Grace Hopper', 'vCard export')
    await p.click({ text: /^Send the compiler paper/, css: 'label', within: S.page })
    await waitText(p, 'All done')
    await tab(p, 'Today')
    await waitTally(p, { 'People to meet': '0' })
    eq((await tally(p))['People to meet'][1], '1 met so far', 'people met caption')
  },

  async backup (ctx) {
    const p = await ctx.open(`#v=schedule&d=${DAY}`)
    await star(p, KEYNOTE.id)
    await addInterest(p, 'robotics')
    await tab(p, 'My plan')
    await addPerson(p, 'Ada Lovelace')
    await openYou(p)
    const m = await toastMark(p)
    const file = await download(p, { text: /^Download backup/, within: 'dialog' }, /\.json$/)
    await waitToast(p, /^Backup downloaded/, m)
    const backup = JSON.parse(file.text)
    eq([backup.format, backup.version, backup.conference], ['whichtalk-backup', 1, 'neurips-2026'], 'backup header')
    has(file.name, /^whichtalk-neurips-2026-backup-\d{4}-\d{2}-\d{2}\.json$/, 'backup file name')
    ok(backup.data.starred.includes(KEYNOTE.id), 'backup has the starred item')
    eq(backup.data.interests.map(h => h.text), ['robotics'], 'backup interests')
    ok(backup.data.people.some(x => x.name === 'Ada Lovelace'), 'backup has the person')
    await p.waitFor(() => /Last backup just now/.test(window.__e2e.topDialog().innerText), [], { message: 'Last backup just now' })
    // clear everything, then restore through the file input
    const tmp = path.join(OUT, `backup-${process.pid}.json`)
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(tmp, file.text)
    await p.goto('about:blank', { ready: false })
    await sleep(300)
    await p.clearOriginStorage(new URL(BASE).origin)
    await p.goto(app())
    await waitTally(p, { Saved: '0', 'People to meet': '0', Interests: '0' })
    await openYou(p)
    await p.chooseFile({ text: 'Restore from a backup file', within: 'dialog' }, tmp)
    await dialogHeading(p, 'Restore from a backup file')
    has(await dialogText(p), /1 saved items/, 'backup summary')
    const m2 = await toastMark(p)
    await p.click({ text: 'Replace', within: 'dialog' })
    await waitToast(p, /^Restored the backup/, m2)
    await closeDialog(p)
    await waitTally(p, { Saved: '1', 'People to meet': '1', Interests: '1' })
    fs.rmSync(tmp, { force: true })
  },

  async persistence (ctx) {
    const p = await ctx.open(`#v=schedule&d=${DAY}`)
    await star(p, KEYNOTE.id)
    await addInterest(p, 'graph neural networks')
    await p.reload()
    await waitAttr(p, { css: `[data-star="${KEYNOTE.id}"]`, within: S.page }, 'aria-pressed', 'true')
    await tab(p, 'Today')
    await waitTally(p, { Saved: '1', Interests: '1' })
    await openYou(p)
    ok(await p.exists({ label: 'Pause graph neural networks', within: 'dialog' }), 'interest kept after reload')
  },

  async share (ctx) {
    const a = await ctx.open(`#v=schedule&d=${DAY}`)
    await star(a, KEYNOTE.id)
    await tab(a, 'My plan')
    const m = await toastMark(a)
    await a.click({ text: 'Share', within: S.page })
    await waitToast(a, /^Share link copied, 1 item\. It is read-only\./, m)
    const link = (await a.clipboard()).pop()
    ok(link && link.startsWith(BASE), 'share link: ' + link)
    const b = await ctx.open(null, link)
    await waitText(b, 'Shared plan')
    await waitText(b, '1 item, carried in the link itself')
    await b.click({ text: 'View', within: S.page })
    await waitHeading(b, 'Shared plan')
    await waitText(b, KEYNOTE.title)
    const m2 = await toastMark(b)
    await b.click({ text: 'Add all to My plan', within: S.page })
    await waitToast(b, /^Added 1 item to My plan/, m2)
    await waitHeading(b, 'My plan')
    await waitAttr(b, { css: `[data-star="${KEYNOTE.id}"]`, within: S.page }, 'aria-pressed', 'true')
    // the same link as a team member
    await b.click({ role: 'tab', text: 'Team', within: S.page })
    await b.fill('Colleague name', 'Alan', S.page)
    await b.fill('Share link', link, S.page)
    const m3 = await toastMark(b)
    await b.click({ text: 'Add', within: S.page })
    await waitToast(b, /^Added, 1 item/, m3)
    await waitText(b, 'Who is going')
    await waitText(b, 'You, Alan')
  },

  async sync (ctx) {
    const a = await ctx.open(`#v=schedule&d=${DAY}`)
    await star(a, KEYNOTE.id)
    await addInterest(a, 'robotics')
    await tab(a, 'My plan')
    await addPerson(a, 'Ada Lovelace')
    await openYou(a)
    await a.click({ text: /^Sync to another device/, within: 'dialog' })
    await dialogHeading(a, 'Sync to another device')
    await a.waitFor(() => window.__e2e.match({ text: 'Copy link', within: 'dialog' }).length, [], { message: 'Copy link' })
    has(await dialogText(a), 'Contains 1 saved item, 1 interest, 1 person and 0 notes', 'sync summary')
    ok(await a.exists({ css: '[aria-label="QR code for the sync link"]', within: 'dialog' }), 'QR code')
    const m = await toastMark(a)
    await a.click({ text: 'Copy link', within: 'dialog' })
    await waitToast(a, /^Sync link copied/, m)
    const link = (await a.clipboard()).pop()
    ok(/#sync=/.test(link), 'sync link: ' + link)
    const b = await ctx.open(null, withNow(link))
    await dialogHeading(b, 'Data from another device')
    eq(await b.eval(() => { const r = window.__e2e.topDialog().querySelector('input[type=radio]:checked'); return r && window.__e2e.norm(r.closest('label').innerText) }),
      'Merge (recommended) Union of saved items, interests and people; for notes on the same person, the newest version wins.', 'merge selected')
    const m2 = await toastMark(b)
    await b.click({ text: 'Apply', within: 'dialog' })
    await waitToast(b, /^Merged the other device’s data/, m2)
    await waitTally(b, { Saved: '1', 'People to meet': '1', Interests: '1' })
  },

  async calendar (ctx) {
    const p = await ctx.open(`#e=${KEYNOTE.id}`)
    await dialogHeading(p, KEYNOTE.title)
    await star(p, KEYNOTE.id, 'dialog')
    const one = await download(p, { text: 'Add to calendar', within: 'dialog' }, /\.ics$/)
    const ics = unfold(one.text)
    for (const s of ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', `SUMMARY:[NeurIPS] ${KEYNOTE.title}`, `DTSTART:${KEYNOTE.dtstart}`, 'END:VEVENT']) has(ics, s, 'event .ics')
    await closeDialog(p)
    await tab(p, 'My plan')
    await p.click({ text: 'Export', within: S.page })
    await dialogHeading(p, 'Export')
    const all = await download(p, { text: /^Calendar \(\.ics\)/, within: 'dialog' }, /\.ics$/)
    const plan = unfold(all.text)
    eq((plan.match(/BEGIN:VEVENT/g) || []).length, 1, 'VEVENTs in the plan .ics')
    has(plan, `SUMMARY:[NeurIPS] ${KEYNOTE.title}`, 'plan .ics summary')
    has(plan, 'TRIGGER:-PT10M', 'default reminder')
  },

  async theme (ctx) {
    const p = await ctx.open()
    eq(await p.eval(() => document.documentElement.dataset.theme), 'system', 'initial theme')
    await openYou(p)
    const btn = name => ({ css: '[role=group][aria-label="Theme"] button', text: name, within: 'dialog' })
    await p.click(btn('Dark'))
    await p.waitFor(() => document.documentElement.dataset.theme === 'dark', [], { message: 'dark theme' })
    await waitAttr(p, btn('Dark'), 'aria-pressed', 'true')
    await p.reload()
    eq(await p.eval(() => document.documentElement.dataset.theme), 'dark', 'theme after reload')
    await openYou(p)
    eq(await attr(p, btn('Dark'), 'aria-pressed'), 'true', 'Dark pressed after reload')
    await p.click(btn('Light'))
    await p.waitFor(() => document.documentElement.dataset.theme === 'light', [], { message: 'light theme' })
  },

  async shortcuts (ctx) {
    const p = await ctx.open()
    await p.press('?')
    await dialogHeading(p, 'Keyboard shortcuts')
    has(await dialogText(p), 'Previous or next day in the Schedule', 'shortcuts list')
    await p.press('Escape')
    await p.waitFor(() => !window.__e2e.topDialog(), [], { message: 'shortcuts closed by Esc' })
    await openYou(p)
    await p.click({ text: 'Keyboard shortcuts', within: 'dialog' })
    await dialogHeading(p, 'Keyboard shortcuts')
    await closeDialog(p)
    await p.waitFor(() => !window.__e2e.topDialog(), [], { message: 'all dialogs closed' })
  },

  async reading (ctx) {
    const p = await ctx.open(`#e=${POSTER.id}`)
    await dialogHeading(p, POSTER.title)
    await star(p, POSTER.id, 'dialog')
    await closeDialog(p)
    await p.goto(app(`#e=${POSTER.id}`)) // the detail shows the Read switch only when opened for a saved paper
    await dialogHeading(p, POSTER.title)
    const read = { role: 'switch', text: /^Read\b/, within: 'dialog' }
    await waitAttr(p, read, 'aria-checked', 'false')
    await p.click(read)
    await waitAttr(p, read, 'aria-checked', 'true')
    await closeDialog(p)
    await tab(p, 'My plan')
    await p.click({ text: 'Export', within: S.page })
    await dialogHeading(p, 'Export')
    has(await dialogText(p), 'Reading list, Markdown 1 paper, 1 read', 'reading list row')
    const md = await download(p, { text: /^Reading list, Markdown/, within: 'dialog' }, /\.md$/)
    has(md.text, `- [x] [${POSTER.title}](https://openreview.net/forum?id=${POSTER.openreview})`, 'Markdown reading list')
    await p.click({ text: 'Export', within: S.page })
    await dialogHeading(p, 'Export')
    const bib = await download(p, { text: /^Reading list, BibTeX/, within: 'dialog' }, /\.bib$/)
    has(bib.text, /^@inproceedings\{\w+2026\w+,/, 'BibTeX entry')
    has(bib.text, `title = {${POSTER.title}}`, 'BibTeX title')
  },

  async alternatives (ctx) {
    const p = await ctx.open(`#v=schedule&d=${DAY}`)
    await star(p, KEYNOTE.id)
    await star(p, WIML.id)
    await tab(p, 'My plan')
    const row = `${S.page} [data-id="${KEYNOTE.id}"]`
    await p.click({ text: 'Alternatives', within: row })
    await dialogHeading(p, /^Alternatives to “Scaling Experience/)
    await dialogHeading(p, 'Same item at another time')
    await dialogHeading(p, 'Similar, and free in your plan')
    await closeDialog(p)
    const m = await toastMark(p)
    await p.click({ text: 'Keep this', within: row })
    await waitToast(p, /^Kept “Scaling Experience in the Wild[^”]*”, removed the other/, m)
    await p.waitFor(sel => !document.querySelector(sel), [`${S.page} [data-id="${WIML.id}"]`], { message: 'the other item removed' })
    await waitText(p, '1 saved item')
    lacks(await pageText(p), 'Overlaps with', 'clash label')
    await p.click({ text: 'Undo', within: S.toast })
    await waitText(p, '2 saved items')
  },

  async print (ctx) {
    const p = await ctx.open(`#v=schedule&d=${DAY}`)
    await star(p, KEYNOTE.id)
    await tab(p, 'My plan')
    await p.click({ text: 'Week', within: S.page })
    await p.waitFor(sel => !!document.querySelector(sel), [`${S.page} ${S.grid}`], { message: 'week grid' })
    await p.click({ text: 'Export', within: S.page })
    await dialogHeading(p, 'Export')
    await p.click({ text: /^Print/, within: 'dialog' })
    await p.waitFor(() => window.__e2e.prints === 1, [], { message: 'print()' })
    eq(await count(p, S.grid), 0, 'print view uses the list layout')
    await waitText(p, KEYNOTE.title)
  },

  async location (ctx) {
    const p = await ctx.open(`#v=schedule&d=${DAY}`)
    await waitText(p, 'AEDT')
    await p.click({ text: 'Filter', within: S.page })
    await dialogHeading(p, 'Location')
    await p.click({ role: 'menuitemcheckbox', text: /^Paris\b/, within: 'dialog' })
    await waitAttr(p, { role: 'menuitemcheckbox', text: /^Paris\b/, within: 'dialog' }, 'aria-checked', 'true')
    await p.click({ text: 'Done', within: 'dialog' })
    const h = await hashParams(p)
    eq([h.s, h.v], ['PAR', 'schedule'], 'location in the hash')
    await waitText(p, 'CET')
    await waitText(p, /Paris/)
    await p.click({ text: /^Filter/, within: S.page })
    await p.click({ role: 'menuitemcheckbox', text: /^Sydney\b/, within: 'dialog' })
    await p.click({ text: 'Done', within: 'dialog' })
    await p.waitFor(() => !new URLSearchParams(location.hash.slice(1)).has('s'), [], { message: 'default location drops s=' })
    await waitText(p, 'AEDT')
  },
})

// ---------- runner ----------
async function checkPage (browser) {
  const p = await browser.newPage()
  try {
    await p.goto(app())
    if (!(await p.eval(sel => !!document.querySelector(sel), S.data))) throw new Error(`no ${S.data} on ${BASE}: not a WhichTalk planner page`)
  } finally { await p.close() }
}

async function runScenario (browser, name, fn) {
  const pages = []
  const ctx = {
    async open (hash = '', url) {
      const p = await browser.newPage()
      pages.push(p)
      await p.goto(url || app(hash))
      await p.eval(sel => window.__e2e.watchToast(sel), S.toast)
      const reload = p.reload.bind(p)
      p.reload = async () => { await reload(); await p.eval(sel => window.__e2e.watchToast(sel), S.toast) }
      const goto = p.goto.bind(p)
      p.goto = async (u, o) => { await goto(u, o); if (!o || o.ready !== false) await p.eval(sel => window.__e2e.watchToast(sel), S.toast) }
      return p
    },
  }
  const t0 = Date.now()
  let error = null
  try {
    await fn(ctx)
    await sleep(150) // late async errors (idle callbacks, abstract loads)
    const errs = pages.flatMap(p => p.errors)
    if (errs.length) throw new Error('console errors: ' + errs.join(' | '))
  } catch (err) {
    error = err
    for (const [i, p] of pages.entries()) await p.screenshot(path.join(OUT, `${name}${pages.length > 1 ? '-' + (i + 1) : ''}.png`)).catch(() => {})
  }
  for (const p of pages) await p.close()
  return { name, ms: Date.now() - t0, error }
}

async function main () {
  const names = Object.keys(scenarios).filter(n => !ONLY || ONLY.includes(n))
  if (!names.length) { console.error('no scenario matches --only ' + ONLY); process.exit(2) }
  const browser = await launch()
  const stop = async () => { await browser.close(); process.exit(130) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  let results = []
  try {
    await checkPage(browser)
    console.log(`WhichTalk e2e: ${BASE} (now ${NOW})`)
    for (const n of names) {
      const r = await runScenario(browser, n, scenarios[n])
      results.push(r)
      console.log(`${r.error ? 'FAIL' : 'PASS'} ${n.padEnd(13)} ${(r.ms / 1000).toFixed(1)}s${r.error ? '  ' + r.error.message : ''}`)
    }
  } catch (err) {
    console.error('setup failed: ' + err.message)
    results = [{ name: 'setup', error: err }]
  } finally {
    await browser.close()
  }
  const failed = results.filter(r => r.error)
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed${failed.length ? ' (screenshots in ' + OUT + ')' : ''}`)
  process.exit(failed.length ? 1 : 0)
}

main()
