// Offline support when hosted: network-first for every same-origin GET (fresh schedule and
// description shards when online), the last cached copy when offline.
// One cache per conference: building another conference or year never deletes this one's offline copy.
const PREFIX = 'whichtalk-{{id}}-'
const CACHE = PREFIX + 'v3'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
))

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(CACHE).then(cache => cache.put(req, copy))
        }
        return res
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  )
})
