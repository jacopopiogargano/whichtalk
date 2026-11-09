// Text helpers shared by every layer: numbers and plurals, URL checks, ids, accent folding for
// search, regex escaping and base64url.

export const num = n => n.toLocaleString('en-US')

export const count = (n, one, many) => `${num(n)} ${n === 1 ? one : (many || one + 's')}`

// File-name form: "My Conf 2026" -> "my-conf-2026".
export const slug = s => normalize(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export const httpUrl = u => (/^https?:\/\//i.test(u || '') ? u : null)

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

const DIACRITICS = /[̀-ͯ]/g

// Lower case without accents: the form every search haystack, query and interest is compared in.
export const normalize = s => (s || '').normalize('NFD').replace(DIACRITICS, '').toLowerCase()

// Folding one UTF-16 unit at a time keeps the folded copy exactly as long as the original, so
// match offsets found in it can slice the original text (used for <mark> highlighting).
const unitFolds = new Map()
function foldUnit (ch) {
  let folded = unitFolds.get(ch)
  if (folded === undefined) {
    folded = ch.charCodeAt(0) < 128 ? ch.toLowerCase() : ch.normalize('NFD')[0].toLowerCase()
    if (folded.length !== 1) folded = ch
    unitFolds.set(ch, folded)
  }
  return folded
}
export const normalizeKeepCase = s => (s || '').replace(/[^a-z0-9 ]/g, foldUnit)

export const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// base64url without padding. Strings travel as UTF-8; a Uint8Array is encoded as is.
export function toBase64Url (input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url (text, asBytes = false) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let k = 0; k < binary.length; k++) bytes[k] = binary.charCodeAt(k)
  return asBytes ? bytes : new TextDecoder().decode(bytes)
}
