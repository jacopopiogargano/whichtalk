// Descriptions and abstracts, loaded on demand. They live in abstracts/part-<n>.js (n = id % shards):
// classic scripts that call window.__whichtalkAbstracts(n, { id: text }), so they load from file://
// as well as from a web server. The ?v= query keeps a browser from reusing an older build's shard.
import { catalogInfo } from './catalog.js'

const abstractTexts = new Map()
const abstractShardLoads = new Map()
const abstractShardsSeen = new Set()

function receiveAbstractShard (shard, items) {
  for (const id in items) abstractTexts.set(Number(id), String(items[id]))
  abstractShardsSeen.add(shard)
}

function loadAbstractShard (shard) {
  const known = abstractShardLoads.get(shard)
  if (known) return known
  window.__whichtalkAbstracts = receiveAbstractShard
  const loading = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    const fail = () => {
      abstractShardLoads.delete(shard) // allow a retry later
      reject(new Error('Description file not found'))
    }
    script.src = `abstracts/part-${shard}.js?v=${encodeURIComponent(catalogInfo.generatedAt)}`
    script.async = true
    // A classic script has run by the time onload fires, so the shard has reported itself unless the
    // file is not a shard of this format (for example an outdated copy from an offline cache).
    script.onload = () => {
      script.remove()
      if (abstractShardsSeen.has(shard)) resolve()
      else fail()
    }
    script.onerror = () => {
      script.remove()
      fail()
    }
    document.head.append(script)
  })
  abstractShardLoads.set(shard, loading)
  return loading
}

export function hasAbstract (e) {
  return !!(e && e.hasAbstract)
}

export async function abstractFor (e) {
  if (!hasAbstract(e)) return null
  if (abstractTexts.has(e.id)) return abstractTexts.get(e.id)
  await loadAbstractShard(e.id % catalogInfo.abstractShards)
  return abstractTexts.get(e.id) || null
}
