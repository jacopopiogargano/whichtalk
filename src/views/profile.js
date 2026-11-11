// Interests: weighted search terms that rank suggestions and people to meet. Edited with an
// autocomplete over the conference's own vocabulary: in full at the top of the account panel, and
// as a compact editor on Today (first visit) and Suggested for you. The opt-in bulk imports
// (papers, website, pasted text) live in profile-import.js.
import { h, qs, notify } from '../lib/dom.js'
import { icon } from '../lib/icons.js'
import { count, num, normalize } from '../lib/text.js'
import { data, prefs, ui, save } from '../state/store.js'
import { MAX_INTERESTS } from '../state/sanitize.js'
import { ensureTermIndex } from '../search/index.js'
import { rescore, interestQueries, interestCount } from '../search/relevance.js'
import { autocompleteSearch, suggestTopics } from '../search/extract.js'
import { highlight } from '../ui/components.js'
import { hidePanel, showPanel } from '../ui/overlay.js'
import { renderAll, navigate } from '../ui/shell.js'
import { importReview, importersBox } from './profile-import.js'

// Shown as "from …" next to an interest; hand-typed and topic picks carry no label.
const INTEREST_SOURCE_LABELS = { openalex: 'OpenAlex', s2: 'Semantic Scholar', website: 'website', text: 'pasted text', import: 'import', topic: '' }

const interestPosition = text => data.interests.findIndex(x => normalize(x.text) === normalize(text))

function interestsChanged () {
  rescore()
  save()
  renderAll()
}

// Adds an interest, or strengthens and resumes one with the same folded text. `quiet` skips the
// re-render and the toast (bulk imports do both once at the end).
export function addInterest (raw, weight = 1, source = 'manual', quiet = false) {
  const text = (raw || '').trim().replace(/\s+/g, ' ').slice(0, 80)
  if (!text) return false
  const existing = data.interests[interestPosition(text)]
  if (existing) {
    existing.weight = Math.max(existing.weight, weight)
    existing.active = true
    if (!quiet) notify(`“${text}” is already an interest`)
  } else if (data.interests.length >= MAX_INTERESTS) {
    notify(`Up to ${MAX_INTERESTS} interests. Remove some first.`)
    return false
  } else {
    data.interests.push({ text, weight, active: true, source })
  }
  prefs.onboarded = true
  ensureTermIndex()
  rescore()
  save()
  if (!quiet) {
    renderAll()
    const at = interestPosition(text)
    const query = interestQueries[at]
    const readAs = query && query.fuzzy.length ? ` (${query.fuzzy[0]})` : ''
    notify(`Added “${text}”, ${count(interestCount[at] || 0, 'match', 'matches')}${readAs}`)
  }
  return true
}

function stepWeight (at, delta) {
  const interest = data.interests[at]
  interest.weight = Math.min(3, Math.max(0.25, Math.round((interest.weight + delta) * 4) / 4))
  interestsChanged()
}

function removeInterest (at) {
  const [removed] = data.interests.splice(at, 1)
  interestsChanged()
  notify(`Removed “${removed.text}”`, { action: 'Undo', run: () => { data.interests.splice(at, 0, removed); interestsChanged() } })
}

function clearInterests () {
  if (!confirm('Remove all interests?')) return
  const before = data.interests.splice(0)
  interestsChanged()
  notify('Interests cleared', { action: 'Undo', run: () => { data.interests.splice(0, data.interests.length, ...before); interestsChanged() } })
}

// Combobox: suggestions from the catalog's topics and frequent title phrases, plus an "as typed"
// entry. Arrow keys move, Enter adds, Escape closes. The id keeps the panel's copy and the page's
// copy apart (both can be on screen).
function interestInput (inputId = 'interest-input') {
  const menuId = inputId + '-options'
  const input = h('input', {
    id: inputId,
    placeholder: 'Add a topic, keyword, author or lab',
    'aria-label': 'Add an interest',
    autocomplete: 'off',
    maxlength: '80',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-controls': menuId,
    'aria-autocomplete': 'list',
  })
  const menu = h('div', { class: 'autocomplete-menu', id: menuId, role: 'listbox', hidden: true })
  let options = []
  let current = -1

  const closeMenu = () => {
    menu.hidden = true
    input.setAttribute('aria-expanded', 'false')
    current = -1
  }
  const choose = option => {
    addInterest(option ? option.label : input.value, 1, option ? 'topic' : 'manual')
    input.value = ''
    closeMenu()
    // addInterest re-renders the panel, so focus the fresh input.
    setTimeout(() => { const fresh = qs('#' + inputId); if (fresh) fresh.focus() }, 0)
  }
  const pressOption = run => ev => { ev.preventDefault(); run() }
  const openMenu = () => {
    options = autocompleteSearch(input.value)
    const typed = input.value.trim()
    menu.replaceChildren(...options.map((option, k) => h('button', {
      class: 'autocomplete-option',
      role: 'option',
      'aria-selected': k === current ? 'true' : 'false',
      onmousedown: pressOption(() => choose(option)),
    }, h('span', { class: 'tally-label' }, option.kind === 'topic' ? 'Topic' : 'Phrase'), h('span', {}, highlight(option.label)), h('small', {}, count(option.n, 'item')))))
    if (typed.length > 1 && !options.some(option => normalize(option.label) === normalize(typed))) {
      menu.append(h('button', { class: 'autocomplete-option', role: 'option', onmousedown: pressOption(() => choose(null)) },
        h('span', { class: 'tally-label' }, 'Add'), h('span', {}, `“${typed}”, as typed`)))
    }
    menu.hidden = !menu.children.length
    input.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true')
  }

  let typingTimer
  input.addEventListener('input', () => {
    clearTimeout(typingTimer)
    current = -1
    typingTimer = setTimeout(openMenu, 40)
  })
  input.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      if (menu.hidden) openMenu()
      const total = menu.children.length
      if (!total) return
      current = (current + (ev.key === 'ArrowDown' ? 1 : -1) + total) % total
      for (const [k, node] of [...menu.children].entries()) node.setAttribute('aria-selected', k === current ? 'true' : 'false')
      menu.children[current].scrollIntoView({ block: 'nearest' })
    } else if (ev.key === 'Enter') {
      ev.preventDefault()
      if (current >= 0 && current < options.length) choose(options[current])
      else if (input.value.trim()) choose(null)
    } else if (ev.key === 'Escape') {
      closeMenu()
      ev.stopPropagation()
    }
  })
  // Delay so a click on an option lands before the menu disappears.
  input.addEventListener('blur', () => setTimeout(closeMenu, 160))

  const addButton = h('button', {
    class: 'button is-primary',
    onmousedown: ev => ev.preventDefault(),
    onclick: () => { if (input.value.trim()) choose(current >= 0 ? options[current] : null) },
  }, 'Add')
  return h('div', { class: 'autocomplete' }, h('div', { class: 'autocomplete-row' }, input, addButton), menu)
}

function interestRow (interest, at) {
  const { text, active } = interest
  const from = INTEREST_SOURCE_LABELS[interest.source]
  return h('div', { class: active ? 'interest' : 'interest is-paused' },
    h('span', { class: 'interest-text' }, text, from ? h('small', {}, 'from ' + from) : null, active ? null : h('small', {}, 'paused')),
    h('span', { class: 'interest-count' }, count(interestCount[at] || 0, 'match', 'matches')),
    h('span', { class: 'weight' },
      h('button', { class: 'step', 'aria-label': `Lower weight of ${text}`, title: 'Lower weight', onclick: () => stepWeight(at, -0.5) }, '−'),
      h('span', { class: 'weight-value', title: 'Weight' }, String(interest.weight)),
      h('button', { class: 'step', 'aria-label': `Raise weight of ${text}`, title: 'Raise weight', onclick: () => stepWeight(at, 0.5) }, '+')),
    h('button', {
      class: 'step',
      'aria-pressed': active ? 'false' : 'true',
      'aria-label': `${active ? 'Pause' : 'Resume'} ${text}`,
      title: active ? 'Pause' : 'Resume',
      onclick: () => { interest.active = !interest.active; interestsChanged() },
    }, icon(active ? 'pause' : 'play')),
    h('button', { class: 'remove', 'aria-label': `Remove ${text}`, title: 'Remove', onclick: () => removeInterest(at) }, icon('x')))
}

function interestList () {
  if (!data.interests.length) return h('p', { class: 'helper' }, 'No interests yet. Add one above, pick a popular topic, or import below.')
  return h('div', { class: 'interest-list' }, data.interests.map(interestRow))
}

// Popular topics the interests do not already cover, as one-tap buttons.
function popularRow (label, limit) {
  const have = data.interests.map(x => normalize(x.text))
  const popular = suggestTopics().filter(topic => !have.some(k => normalize(topic).startsWith(k))).slice(0, limit)
  return popular.length
    ? h('div', { class: 'quick-adds' }, h('span', {}, label), popular.map(topic => h('button', { onclick: () => addInterest(topic, 1, 'topic') }, topic)))
    : null
}

const openImports = () => { ui.importOpen = true; showPanel('you') }

// The compact editor: the field, the interests as removable chips, popular topics while there are
// few, and the imports and the full editor (weights, pause) one tap away.
export function interestQuickEditor () {
  ensureTermIndex()
  const chips = data.interests.map((interest, at) => h('span', { class: interest.active ? 'interest-chip' : 'interest-chip is-paused' },
    h('span', {}, interest.text),
    h('small', { title: count(interestCount[at] || 0, 'match', 'matches') }, num(interestCount[at] || 0)),
    h('button', { 'aria-label': `Remove ${interest.text}`, title: 'Remove', onclick: () => removeInterest(at) }, icon('x'))))
  return h('div', { class: 'quick-interests' },
    interestInput('interest-inline'),
    chips.length ? h('div', { class: 'interest-chips' }, chips) : null,
    data.interests.length < 5 ? popularRow(data.interests.length ? 'More:' : 'Popular:', 8) : null,
    h('p', { class: 'quick-links' },
      h('button', { class: 'text-button', onclick: openImports }, 'Import from your papers or website'),
      data.interests.length ? h('button', { class: 'text-button', onclick: () => showPanel('you') }, 'Weights and pausing') : null))
}

// The interests part of the account panel: a pending import review first, then the editor,
// popular topics not yet covered, and the importers (their open state survives re-renders).
export function interestSections () {
  ensureTermIndex()
  const editor = h('div', { class: 'overlay-section', id: 'interest-editor' },
    h('h3', {}, 'Interests'),
    h('p', { class: 'section-note' }, 'They rank Today’s suggestions, Suggested for you, and people to meet. Higher weight ranks matches higher.'),
    interestInput(),
    interestList(),
    popularRow('Popular:', 10),
    data.interests.length
      ? h('div', { class: 'actions' },
        h('button', { class: 'button', onclick: () => { hidePanel(); navigate('foryou') } }, 'See suggestions'),
        h('button', { class: 'text-button is-danger', onclick: clearInterests }, 'Clear all'))
      : null,
    importersBox())
  return [ui.review ? importReview() : null, editor]
}
