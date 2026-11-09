// Minimal Chrome DevTools Protocol driver for the end-to-end test. Zero dependencies: Node 24's
// built-in fetch and WebSocket. One headless Chrome per run; every Page lives in its own browser
// context (fresh storage, no service worker or cache carried over).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)) })
  })
}

export async function launch ({ width = 1280, height = 900 } = {}) {
  const port = await freePort()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whichtalk-e2e-chrome-'))
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--password-store=basic',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-features=Translate,MediaRouter,OptimizationHints', '--lang=en-US', `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore' })
  let exited = false
  proc.on('exit', () => { exited = true })
  let wsUrl = null
  for (let i = 0; i < 150 && !wsUrl && !exited; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl } catch (e) { await sleep(100) }
  }
  if (!wsUrl) { proc.kill('SIGKILL'); throw new Error('Chrome did not start (no DevTools endpoint)') }
  const browser = new Browser(proc, profile, { width, height })
  await browser.connect(wsUrl)
  return browser
}

class Browser {
  constructor (proc, profile, size) {
    this.proc = proc
    this.profile = profile
    this.size = size
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map() // sessionId -> fn(method, params)
  }

  connect (url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url)
      this.ws.onopen = () => resolve()
      this.ws.onerror = ev => reject(new Error('CDP socket error ' + (ev.message || '')))
      this.ws.onmessage = ev => {
        const msg = JSON.parse(ev.data)
        if (msg.id) {
          const p = this.pending.get(msg.id)
          if (!p) return
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result)
        } else {
          const fn = this.listeners.get(msg.sessionId || '')
          if (fn) fn(msg.method, msg.params)
        }
      }
    })
  }

  send (method, params = {}, sessionId) {
    const id = this.nextId++
    const msg = { id, method, params }
    if (sessionId) msg.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.ws.send(JSON.stringify(msg))
    })
  }

  // A page in a fresh browser context: own storage, downloads denied (they are captured in the page).
  async newPage () {
    const { browserContextId } = await this.send('Target.createBrowserContext', { disposeOnDetach: true })
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId })
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    const page = new Page(this, browserContextId, targetId, sessionId)
    this.listeners.set(sessionId, (m, p) => page.onEvent(m, p))
    await page.init()
    return page
  }

  async close () {
    try { await Promise.race([this.send('Browser.close'), sleep(2000)]) } catch (e) { /* already gone */ }
    try { this.ws.close() } catch (e) { /* ignore */ }
    for (let i = 0; i < 30 && this.proc.exitCode === null && this.proc.signalCode === null; i++) await sleep(100)
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill('SIGKILL')
    try { fs.rmSync(this.profile, { recursive: true, force: true }) } catch (e) { /* ignore */ }
  }
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  '/': { code: 'Slash', keyCode: 191, text: '/' },
  '?': { code: 'Slash', keyCode: 191, text: '?', shift: true },
}
for (let d = 0; d <= 9; d++) KEYS[String(d)] = { code: 'Digit' + d, keyCode: 48 + d, text: String(d) }

export class Page {
  constructor (browser, contextId, targetId, sessionId) {
    Object.assign(this, { browser, contextId, targetId, sessionId })
    this.errors = []
    this.fileChooser = null
  }

  send (method, params) { return this.browser.send(method, params, this.sessionId) }

  onEvent (method, p) {
    if (method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails
      this.errors.push('uncaught: ' + ((d.exception && d.exception.description) || d.text).split('\n')[0])
    } else if (method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'assert')) {
      this.errors.push('console.error: ' + p.args.map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '))
    } else if (method === 'Log.entryAdded' && p.entry.level === 'error') {
      this.errors.push(`log (${p.entry.source}): ${p.entry.text}${p.entry.url ? ' ' + p.entry.url : ''}`)
    } else if (method === 'Page.fileChooserOpened') {
      this.fileChooser = p
    }
  }

  async init () {
    await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable', 'DOM.enable'].map(m => this.send(m)))
    const { width, height } = this.browser.size
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }] })
    await this.browser.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: this.contextId })
    await this.send('Page.setInterceptFileChooserDialog', { enabled: true })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${pageHooks})()` })
  }

  async close () {
    try { await this.browser.send('Target.closeTarget', { targetId: this.targetId }) } catch (e) { /* ignore */ }
    try { await this.browser.send('Target.disposeBrowserContext', { browserContextId: this.contextId }) } catch (e) { /* ignore */ }
    this.browser.listeners.delete(this.sessionId)
  }

  // Evaluate fn(...args) in the page (args are JSON; RegExps are passed as { re, flags }).
  async eval (fn, ...args) {
    const expression = `(${fn})(...${JSON.stringify(args, (k, v) => v instanceof RegExp ? { re: v.source, flags: v.flags } : v)})`
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error('eval: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).split('\n')[0])
    return r.result.value
  }

  async waitFor (fn, args = [], { timeout = 8000, message = 'condition' } = {}) {
    const end = Date.now() + timeout
    let last
    for (;;) {
      try { last = await this.eval(fn, ...args); if (last) return last } catch (e) { last = e.message }
      if (Date.now() > end) throw new Error(`timed out waiting for ${message}${last !== undefined && last !== false && last !== null ? ` (last: ${JSON.stringify(last).slice(0, 200)})` : ''}`)
      await sleep(50)
    }
  }

  // Load a URL and wait for the app's readiness hook. A hash-only change on the same document is a
  // hashchange (no reload); the stale marker makes sure a real reload is waited for.
  async goto (url, { ready = true } = {}) {
    // A hash-only change would be a same-document navigation: bounce through about:blank so the page
    // really loads, like a deep link opened in a new tab.
    const cur = await this.eval(() => location.href).catch(() => '')
    if (cur && !url.startsWith('about:') && cur.split('#')[0] === url.split('#')[0]) {
      await this.send('Page.navigate', { url: 'about:blank' })
      await this.waitFor(() => location.href === 'about:blank' && document.readyState === 'complete', [], { message: 'about:blank' })
    }
    await this.eval(() => { window.__e2eStale = true }).catch(() => {})
    await this.send('Page.navigate', { url })
    if (ready) await this.ready()
  }

  async reload () {
    await this.eval(() => { window.__e2eStale = true })
    await this.send('Page.reload', {})
    await this.ready()
  }

  async ready () {
    await this.waitFor(() => !window.__e2eStale && document.readyState === 'complete' && window.__ready === true, [], { timeout: 20000, message: 'window.__ready' })
  }

  // Spec: { text, label, role, css, within, has, index }. text/label/has match the accessible name
  // (aria-label, else visible text) exactly, or a RegExp. Default scope: the topmost open dialog, else the document.
  async locate (spec, { timeout = 6000 } = {}) {
    let r
    const end = Date.now() + timeout
    for (;;) {
      try { r = await this.eval((s) => window.__e2e.point(s), spec) } catch (e) { r = { ok: false, reason: e.message } }
      if (r.ok) {
        await sleep(30)
        const again = await this.eval((s) => window.__e2e.point(s), spec).catch(() => null)
        if (again && again.ok && Math.abs(again.x - r.x) < 1 && Math.abs(again.y - r.y) < 1) return again
      }
      if (Date.now() > end) throw new Error(`cannot click ${describe(spec)}: ${r.reason}`)
      await sleep(60)
    }
  }

  async click (spec, opts) {
    const { x, y } = await this.locate(typeof spec === 'string' ? { text: spec } : spec, opts)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }

  async exists (spec) { return this.eval(s => window.__e2e.match(s).length, spec) }

  async press (key) {
    const k = KEYS[key]
    if (!k) throw new Error('unknown key ' + key)
    const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.shift ? 8 : 0 }
    await this.send('Input.dispatchKeyEvent', { ...base, type: k.text ? 'keyDown' : 'rawKeyDown', text: k.text, unmodifiedText: k.text })
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  }

  // Real typing into the focused element (fires input events like a keyboard would).
  async type (text) { await this.send('Input.insertText', { text }) }

  // Focus a form control (found by aria-label, placeholder or <label> text) and type into it.
  async typeInto (label, text, within) {
    await this.locate({ field: label, within })
    const ok = await this.eval((l, w) => window.__e2e.focusField(l, w), label, within)
    if (!ok) throw new Error(`no field "${label}"`)
    await this.type(text)
  }

  // Set a control's value directly (selects by option text or value, time inputs, text) and fire input/change.
  async fill (label, value, within) {
    const r = await this.waitFor((l, v, w) => window.__e2e.fill(l, v, w), [label, value, within], { message: `field "${label}"`, timeout: 4000 })
    return r
  }

  // Answer the next file chooser (opened by clicking a button that triggers an <input type=file>).
  async chooseFile (clickSpec, file) {
    this.fileChooser = null
    await this.click(clickSpec)
    const end = Date.now() + 5000
    while (!this.fileChooser && Date.now() < end) await sleep(30)
    if (!this.fileChooser) throw new Error('no file chooser opened')
    await this.send('DOM.setFileInputFiles', { files: [file], backendNodeId: this.fileChooser.backendNodeId })
  }

  async clearOriginStorage (origin) {
    await this.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
  }

  async screenshot (file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
  }

  downloads () { return this.eval(() => window.__e2e.downloads.slice()) }
  async waitDownload (since, { name = /./ } = {}) {
    return this.waitFor((n, re) => { const d = window.__e2e.downloads.slice(n).find(x => new RegExp(re.re, re.flags).test(x.name)); return d && d.text !== null ? d : null },
      [since, name], { message: 'a download' })
  }

  clipboard () { return this.eval(() => window.__e2e.clipboard.slice()) }
}

const describe = s => JSON.stringify(s, (k, v) => v instanceof RegExp ? String(v) : v)

// Runs in every document before the app: captures downloads, clipboard writes, print(), confirm(),
// tracks modal dialogs in opening order, and offers element lookup by accessible name.
function pageHooks () {
  if (window.__e2e) return
  const T = window.__e2e = { downloads: [], clipboard: [], prints: 0, confirms: [], toasts: [], dialogs: [] }
  const blobs = new Map()
  const createUrl = URL.createObjectURL
  URL.createObjectURL = function (obj) { const u = createUrl.call(URL, obj); if (obj instanceof Blob) blobs.set(u, obj); return u }
  const seen = new WeakSet()
  const record = a => {
    if (!a.hasAttribute('download')) return false
    if (seen.has(a)) return true
    seen.add(a)
    const rec = { name: a.getAttribute('download') || '', type: '', text: null }
    T.downloads.push(rec)
    const b = blobs.get(a.href)
    if (b) { rec.type = b.type; b.text().then(t => { rec.text = t }) } else if (a.href.startsWith('data:')) rec.text = decodeURIComponent(a.href.slice(a.href.indexOf(',') + 1))
    else rec.text = ''
    return true
  }
  const anchorClick = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function () { if (record(this)) return; return anchorClick.call(this) }
  addEventListener('click', ev => { const a = ev.target && ev.target.closest && ev.target.closest('a[download]'); if (a && record(a)) ev.preventDefault() }, true)
  const clip = { writeText: async t => { T.clipboard.push(String(t)) }, readText: async () => T.clipboard[T.clipboard.length - 1] || '', write: async () => {}, read: async () => [] }
  try { Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => clip, configurable: true }) } catch (e) { /* ignore */ }
  window.confirm = m => { T.confirms.push(String(m)); return true }
  window.prompt = (m, d) => { T.clipboard.push(String(d)); return null }
  window.alert = () => {}
  window.print = () => { T.prints++ }
  const showModal = HTMLDialogElement.prototype.showModal
  HTMLDialogElement.prototype.showModal = function () { T.dialogs = T.dialogs.filter(d => d !== this); T.dialogs.push(this); return showModal.call(this) }
  T.topDialog = () => {
    const open = T.dialogs.filter(d => d.open && d.isConnected)
    return open[open.length - 1] || [...document.querySelectorAll('dialog[open]')].pop() || null
  }
  T.watchToast = sel => {
    const t = document.querySelector(sel)
    if (!t || t.__e2eWatched) return !!t
    t.__e2eWatched = true
    new MutationObserver(() => { const s = T.norm(t.textContent); if (s) T.toasts.push(s) }).observe(t, { childList: true, subtree: true, characterData: true })
    return true
  }
  const norm = T.norm = s => String(s || '').replace(/\s+/g, ' ').trim()
  const test = (v, m) => (m && typeof m === 'object' && 're' in m ? new RegExp(m.re, m.flags).test(norm(v)) : norm(v) === norm(m))
  T.visible = el => !!el && el.isConnected && el.getClientRects().length > 0 && (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true }))
  T.name = el => norm(el.getAttribute('aria-label') || el.innerText || el.textContent)
  const ownText = l => { const c = l.cloneNode(true); c.querySelectorAll('input, select, textarea, datalist').forEach(x => x.remove()); return norm(c.textContent) }
  T.roots = within => within === 'dialog' ? [T.topDialog()].filter(Boolean) : within ? [...document.querySelectorAll(within)] : [T.topDialog() || document]
  const CLICKABLE = 'button, a[href], [role=button], [role=tab], [role=switch], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=radio], [role=checkbox], summary, label, select'
  T.field = (label, within) => {
    for (const root of T.roots(within)) {
      const ctrls = [...root.querySelectorAll('input, select, textarea')].filter(T.visible)
      const el = ctrls.find(c => test(c.getAttribute('aria-label'), label)) || ctrls.find(c => test(c.getAttribute('placeholder'), label)) ||
        ([...root.querySelectorAll('label')].filter(T.visible).find(l => test(ownText(l), label)) || {}).control
      if (el) return el
    }
    return null
  }
  T.match = spec => {
    if (spec.field) { const f = T.field(spec.field, spec.within); return f ? [f] : [] }
    let els = T.roots(spec.within).flatMap(r => [...r.querySelectorAll(spec.css || CLICKABLE)])
    if (spec.role) els = els.filter(e => (e.getAttribute('role') || e.tagName.toLowerCase()) === spec.role)
    if (spec.label !== undefined) els = els.filter(e => test(e.getAttribute('aria-label'), spec.label))
    if (spec.text !== undefined) els = els.filter(e => test(T.name(e), spec.text))
    if (spec.has !== undefined) els = els.filter(e => test(e.innerText, spec.has))
    if (spec.visible !== false) els = els.filter(T.visible)
    if (!spec.css) els = els.filter(e => !els.some(o => o !== e && e.contains(o)))
    return els
  }
  // A point inside el whose nearest clickable ancestor is el itself (not a nested button).
  T.point = spec => {
    const el = T.match(spec)[spec.index || 0]
    if (!el) return { ok: false, reason: 'not found' }
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    const r = el.getBoundingClientRect()
    const cy = r.top + r.height / 2
    const pts = [[r.left + r.width / 2, cy], [r.left + 8, cy], [r.left + r.width / 4, cy], [r.right - 8, cy], [r.left + r.width / 2, r.top + 4]]
    let hit = null
    for (const [x, y] of pts) {
      hit = document.elementFromPoint(x, y)
      if (!hit || (hit !== el && !el.contains(hit))) continue
      const c = hit.closest(CLICKABLE)
      if (!c || c === el || !el.contains(c)) return { ok: true, x, y, name: T.name(el).slice(0, 60) }
    }
    return { ok: false, reason: `covered by <${hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') : 'nothing'}>` }
  }
  T.focusField = (label, within) => { const f = T.field(label, within); if (!f) return false; f.focus(); if (f.select) f.select(); return true }
  T.fill = (label, value, within) => {
    const f = T.field(label, within)
    if (!f) return false
    f.focus()
    if (f.tagName === 'SELECT') {
      const o = [...f.options].find(x => norm(x.textContent) === norm(value) || x.value === value)
      if (!o) return false
      f.value = o.value
    } else {
      const proto = f.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(f, value)
    }
    f.dispatchEvent(new Event('input', { bubbles: true }))
    f.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  T.text = sel => { const el = sel ? document.querySelector(sel) : document.body; return el ? norm(el.innerText) : '' }
}
