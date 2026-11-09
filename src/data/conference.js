// Conference settings shipped inside the catalog (from conferences/<id>/conference.json, every
// optional key filled in by the build).
import { EMBEDDED_CATALOG } from './embedded.js'

const conferenceSettings = EMBEDDED_CATALOG.conference

export const CONFERENCE_ID = conferenceSettings.id
export const CONFERENCE_NAME = conferenceSettings.name
// The series name without the year, for UI text and file names.
export const CONFERENCE_SHORT = conferenceSettings.shortName
export const STORAGE_NAMESPACE = conferenceSettings.storageNamespace
export const DEFAULT_LOCATION = conferenceSettings.defaultLocation
export const ORGANIZER = conferenceSettings.page.organizer
// Where the schedule data comes from, e.g. a domain; also the label of the event-page link.
export const SOURCE_NAME = conferenceSettings.page.sourceName
export const CANONICAL_URL = conferenceSettings.page.canonical
export const OFFICIAL_SCHEDULE_URL = conferenceSettings.page.officialSchedule
// Text above the list of items whose time is not yet published.
export const UNTIMED_NOTE = conferenceSettings.notes.untimed

// Keyed by location code, in config order (the location picker lists them in this order).
// tz is the UTC offset in hours during the conference.
export const LOCATIONS = Object.fromEntries(conferenceSettings.locations.map(loc => [
  loc.key, { name: loc.name, tz: loc.utcOffsetHours, zone: loc.zone, venue: loc.venue },
]))
// The "every site" pseudo-location, if the conference has one.
export const ALL_LOCATION = (conferenceSettings.locations.find(loc => loc.all) || { key: null }).key
export const HAS_LOCATION_CHOICE = conferenceSettings.locations.length > 1

export const TRACKS = conferenceSettings.tracks.map((track, rank) => ({
  key: track.key, label: track.label, singular: track.singular, kinds: [...track.kinds], rank,
}))
// Separate objects, so adding an entry here (the planner adds 'personal') never touches TRACKS.
export const TRACK_BY_KEY = Object.fromEntries(TRACKS.map(track => [track.key, { ...track }]))
// Tracks off by default in the Schedule (breaks and the like). Their items are also filler elsewhere:
// not indexed for search or suggestions, not in the rooms grid, never "next up".
export const HIDDEN_TRACKS = new Set(conferenceSettings.hiddenTracks)
export const DEFAULT_TRACKS = TRACKS.filter(track => !HIDDEN_TRACKS.has(track.key)).map(track => track.key)
// Tracks whose items are papers (reading list, BibTeX).
export const PAPER_TRACKS = new Set(conferenceSettings.tracks.filter(track => track.papers).map(track => track.key))

// What a day is called after the tracks that dominate it (see dayShort in plan/filters.js).
export const DAY_LABELS = conferenceSettings.dayLabels.map(entry => ({
  label: entry.label, title: entry.title, tracks: new Set(entry.tracks),
}))
// Kinds that only hold talks and are never documents themselves.
export const CONTAINER_KINDS = new Set(conferenceSettings.containerKinds)
// Session titles that say nothing about content (like "Poster Session 3"); null when there are none.
export const GENERIC_SESSION_TITLE = conferenceSettings.genericSessionTitles ? new RegExp(conferenceSettings.genericSessionTitles) : null
// Walking-time model of the venue (see plan/venue.js), or null.
export const VENUE = conferenceSettings.venue

// Links built from the config's URL templates; '' when the conference has no such link.
function fillUrlTemplate (template, values) {
  return template.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole))
}

export const hasEventPage = () => !!conferenceSettings.urls.event

export function eventPageUrl (e) {
  return fillUrlTemplate(conferenceSettings.urls.event, { id: e.id })
}

export function posterImageUrl (e) {
  return fillUrlTemplate(conferenceSettings.urls.poster, { id: e.id })
}

export function openreviewUrl (e) {
  return fillUrlTemplate(conferenceSettings.urls.openreview, { openreviewId: encodeURIComponent(e.openreviewId) })
}
