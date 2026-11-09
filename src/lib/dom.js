// DOM building blocks: element factory, child replacement, the snackbar, file download, clipboard.

export const qs = selector => document.querySelector(selector)

// Children may be nodes, strings, numbers or nested arrays; null, undefined and false are skipped.
function appendKids (node, kids) {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue
    if (Array.isArray(kid)) appendKids(node, kid)
    else node.append(kid)
  }
}

function applyAttr (node, name, value) {
  if (value === undefined || value === null || value === false) return
  if (name === 'class') node.className = value
  else if (name === 'style') node.style.cssText = value
  else if (name.startsWith('on')) node.addEventListener(name.slice(2), value)
  else if (name === 'value') node.value = value
  else node.setAttribute(name, value === true ? '' : value)
}

export function h (tag, attrs, ...kids) {
  const node = document.createElement(tag)
  if (attrs) for (const name in attrs) applyAttr(node, name, attrs[name])
  appendKids(node, kids)
  return node
}

// Like replaceChildren(), but drops null/undefined/false instead of printing them and flattens arrays.
export function fill (node, ...kids) {
  const flat = kids.flat(Infinity).filter(kid => kid !== null && kid !== undefined && kid !== false)
  node.replaceChildren(...flat)
}

let snackbarTimer
export function notify (message, { action, run } = {}) {
  const bar = qs('#snackbar')
  const hide = () => bar.classList.remove('is-visible', 'has-action')
  const button = action ? h('button', { onclick: () => { hide(); run() } }, action) : null
  fill(bar, h('span', {}, message), button)
  bar.classList.toggle('has-action', !!action)
  bar.classList.add('is-visible')
  clearTimeout(snackbarTimer)
  snackbarTimer = setTimeout(hide, action ? 7000 : 2600)
}

export function saveFile (name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const link = h('a', { href: url, download: name })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

export async function copyText (text, doneMessage) {
  try {
    await navigator.clipboard.writeText(text)
    notify(doneMessage)
  } catch (err) {
    prompt('Copy this:', text)
  }
}
