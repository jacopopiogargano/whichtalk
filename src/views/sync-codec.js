// Sync payload codec. A payload is "w1.<crc32>.<base64url(deflate-raw(json))>", where the JSON is
// { format: 'whichtalk-sync', version: 1, at, data } and the checksum covers the compressed bytes,
// so a link cut short by a chat app is caught before anything is decompressed.
import { toBase64Url, fromBase64Url } from '../lib/text.js'

const SYNC_FORMAT = 'whichtalk-sync'
const SYNC_PAYLOAD_PATTERN = /^w1\.([0-9a-f]{8})\.([A-Za-z0-9_-]+)$/

let syncCrcTable = null

export function crc32Hex (bytes) {
  if (!syncCrcTable) {
    syncCrcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      syncCrcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = syncCrcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

async function syncTransform (bytes, stream) {
  const piped = new Blob([bytes]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(piped).arrayBuffer())
}

// `data` is a plain copy of the user data (exportData()).
export async function encodeSyncPayload (data) {
  if (typeof CompressionStream === 'undefined') throw new Error('This browser can’t compress data (CompressionStream missing)')
  const json = JSON.stringify({ format: SYNC_FORMAT, version: 1, at: Date.now(), data })
  const packed = await syncTransform(new TextEncoder().encode(json), new CompressionStream('deflate-raw'))
  return `w1.${crc32Hex(packed)}.${toBase64Url(packed)}`
}

// Resolves to { format, version, at, data }; throws with a message fit for the user.
export async function decodeSyncPayload (payload) {
  const parts = SYNC_PAYLOAD_PATTERN.exec(payload || '')
  if (!parts) throw new Error('This isn’t a valid sync link')
  let packed
  try {
    packed = fromBase64Url(parts[2], true)
  } catch (err) {
    throw new Error('The sync link is damaged (bad encoding)')
  }
  if (crc32Hex(packed) !== parts[1]) throw new Error('Checksum mismatch: the link is incomplete or corrupted. Create a new one.')
  const decoded = JSON.parse(new TextDecoder().decode(await syncTransform(packed, new DecompressionStream('deflate-raw'))))
  if (!decoded || decoded.format !== SYNC_FORMAT || decoded.version !== 1 || !decoded.data) throw new Error('Unsupported sync version')
  return decoded
}
