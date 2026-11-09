// Modal dialog for forms and confirmations (add a person, export, sync, ...). It sits above the
// overlay, so a form can open from an event's details without losing them.
import { qs, h, fill } from '../lib/dom.js'
import { overlayHead } from './overlay.js'

export function openDialog (title, body, actions) {
  const box = qs('#dialog')
  fill(box,
    overlayHead(title, closeDialog, 'dialog-title'),
    h('div', { class: 'overlay-body' }, body),
    h('div', { class: 'overlay-foot' }, actions))
  if (!box.open) box.showModal()
  // Focus the first field, or the primary action when there is nothing to type.
  const first = box.querySelector('.overlay-body input, .overlay-body textarea, .overlay-body select, .overlay-foot .is-primary')
  if (first) setTimeout(() => first.focus(), 30)
}

export function closeDialog () {
  const box = qs('#dialog')
  if (box.open) box.close()
}
