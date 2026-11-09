// Schedule events decoded from the embedded catalog's columns, plus lookups built on them.
import { EMBEDDED_CATALOG } from './embedded.js'
import { LOCATIONS, TRACKS, TRACK_BY_KEY } from './conference.js'

const catalogTrackOfKind = new Map(TRACKS.flatMap(track => track.kinds.map(kind => [kind, track.key])))
const catalogFallbackTrack = EMBEDDED_CATALOG.conference.fallbackTrack

export const catalogInfo = {
  format: EMBEDDED_CATALOG.format,
  version: EMBEDDED_CATALOG.version,
  generatedAt: EMBEDDED_CATALOG.generatedAt,
  enriched: !!EMBEDDED_CATALOG.enriched,
  abstractCount: EMBEDDED_CATALOG.abstracts.count,
  abstractShards: EMBEDDED_CATALOG.abstracts.shards,
}

function decodeCatalogEvents () {
  const cols = EMBEDDED_CATALOG.events
  const text = EMBEDDED_CATALOG.strings
  const list = new Array(cols.count)
  for (let i = 0; i < cols.count; i++) {
    const kind = text[cols.kind[i]]
    const start = cols.start[i]
    const institutions = cols.institutions[i]
    list[i] = {
      idx: i,
      id: cols.id[i],
      kind,
      track: catalogTrackOfKind.get(kind) || catalogFallbackTrack,
      title: cols.title[i],
      authors: cols.authors[i],
      room: text[cols.room[i]],
      start,
      end: start ? start + cols.durationMinutes[i] * 60 : 0,
      location: text[cols.location[i]],
      parentId: cols.parentId[i],
      parentTitle: text[cols.parentTitle[i]],
      openreviewId: cols.openreviewId[i],
      hasPoster: cols.hasPoster[i] === 1,
      links: cols.links[i] || null,
      topic: text[cols.topic[i]],
      institutions: institutions ? institutions.map(n => text[n]) : null,
      keywords: cols.keywords[i],
      hasAbstract: cols.hasAbstract[i] === 1,
    }
  }
  return list
}

export const EVENTS = decodeCatalogEvents()
export const EVENT_COUNT = EVENTS.length
export const eventsById = new Map(EVENTS.map(e => [e.id, e]))

// Parent id -> child events (posters of a session, talks of a workshop), sorted by title.
function groupCatalogChildren () {
  const groups = new Map()
  for (const e of EVENTS) {
    if (!e.parentId || !eventsById.has(e.parentId)) continue
    const siblings = groups.get(e.parentId)
    if (siblings) siblings.push(e)
    else groups.set(e.parentId, [e])
  }
  for (const siblings of groups.values()) siblings.sort((a, b) => a.title.localeCompare(b.title))
  return groups
}

export const childrenByParent = groupCatalogChildren()

export function isNested (e) {
  return !!e.parentId && childrenByParent.has(e.parentId)
}

export function isGroupEvent (e) {
  return childrenByParent.has(e.id)
}

// What the children of a session are called, after their track: { one: 'poster', label: 'Posters' }
// (one is the count noun), or item/Items when they span several tracks.
const childNounMemo = new Map()
export function childNoun (session) {
  if (!childNounMemo.has(session.id)) {
    const tracks = new Set((childrenByParent.get(session.id) || []).map(e => e.track))
    const track = tracks.size === 1 ? TRACK_BY_KEY[[...tracks][0]] : null
    childNounMemo.set(session.id, track ? { one: track.singular.toLowerCase(), label: track.label } : { one: 'item', label: 'Items' })
  }
  return childNounMemo.get(session.id)
}

export function authorLine (e) {
  return (e.authors || []).join(', ')
}

// Config kindLabels: exact kinds, or '*suffix' for every kind ending in suffix.
const catalogKindLabels = EMBEDDED_CATALOG.conference.kindLabels || {}
const catalogKindSuffixes = Object.keys(catalogKindLabels)
  .filter(pattern => pattern.startsWith('*'))
  .map(pattern => [pattern.slice(1), catalogKindLabels[pattern]])

export function kindName (e) {
  const kind = e.kind
  if (typeof kind !== 'string') return kind
  if (Object.prototype.hasOwnProperty.call(catalogKindLabels, kind) && !kind.startsWith('*')) return catalogKindLabels[kind]
  for (const [suffix, label] of catalogKindSuffixes) {
    if (kind.endsWith(suffix)) return label
  }
  return kind
}

export function locationName (e) {
  return Object.prototype.hasOwnProperty.call(LOCATIONS, e.location) ? LOCATIONS[e.location].name : ''
}
