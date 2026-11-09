// Conference-local time. Event times are epoch seconds; every label is computed in the zone of
// the chosen location (setZoneOffset), never in the browser's own zone. `?now=ISO` pins the clock.
import { URL_PARAMS } from './env.js'
import { count } from './text.js'

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const abbrevName = name => name.slice(0, 3)
const padTwo = n => (n < 10 ? '0' : '') + n

let zoneSeconds = 11 * 3600
export function setZoneOffset (hours) { zoneSeconds = hours * 3600 }

let pinnedNow
export function nowSec () {
  if (pinnedNow === undefined) {
    const fixed = URL_PARAMS.get('now')
    pinnedNow = fixed ? Math.floor(Date.parse(fixed) / 1000) : 0
  }
  return pinnedNow || Math.floor(Date.now() / 1000)
}

let twelveHour
function prefers12h () {
  if (twelveHour === undefined) {
    try { twelveHour = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 === true } catch (err) { twelveHour = false }
  }
  return twelveHour
}

// Day keys are asked for thousands of times per render; the ISO string per day number is cached.
const keyForDayNumber = new Map()
export function dayOf (sec) {
  const dayNumber = Math.floor((sec + zoneSeconds) / 86400)
  let key = keyForDayNumber.get(dayNumber)
  if (!key) {
    key = new Date(dayNumber * 864e5).toISOString().slice(0, 10)
    keyForDayNumber.set(dayNumber, key)
  }
  return key
}

export const minuteOfDay = sec => Math.floor((((sec + zoneSeconds) % 86400) + 86400) % 86400 / 60)

export function clockFromMinutes (m) {
  const hour = Math.floor(m / 60) % 24
  const mins = padTwo(m % 60)
  if (!prefers12h()) return `${padTwo(hour)}:${mins}`
  return `${hour % 12 || 12}${mins === '00' ? '' : ':' + mins}${hour < 12 ? 'am' : 'pm'}`
}

export const clock = sec => clockFromMinutes(minuteOfDay(sec))
export const timeRange = e => `${clock(e.start)}–${clock(e.end)}`

export function duration (e) {
  const total = Math.round((e.end - e.start) / 60)
  if (total < 60) return `${total}m`
  const rest = total % 60
  return `${Math.floor(total / 60)}h${rest ? ' ' + rest + 'm' : ''}`
}

export function dayInfo (key) {
  const d = new Date(key + 'T00:00:00Z')
  const weekday = WEEKDAY_NAMES[d.getUTCDay()]
  const month = MONTH_NAMES[d.getUTCMonth()]
  const date = d.getUTCDate()
  return { weekday: abbrevName(weekday), date, long: `${weekday}, ${month} ${date}`, short: `${abbrevName(weekday)} ${date} ${abbrevName(month)}` }
}

export const whenLabel = e => (e.start ? `${dayInfo(dayOf(e.start)).weekday} ${timeRange(e)}` : 'Time TBA')

export function isOngoing (e) {
  const t = nowSec()
  return !!e.start && e.start <= t && t < e.end
}

export const isOver = e => !!e.end && e.end <= nowSec()

// "in 25 min", "in 3 h 10 min", "in 4 days"; compact: "in 25m", "in 3h 10m".
export function countdown (sec, compact) {
  const m = Math.round(sec / 60)
  if (m < 1) return 'now'
  if (m < 60) return compact ? `in ${m}m` : `in ${m} min`
  if (m >= 1440) return `in ${count(Math.ceil(m / 1440), 'day')}`
  const hours = Math.floor(m / 60)
  const rest = m % 60
  return compact ? `in ${hours}h${rest ? ' ' + rest + 'm' : ''}` : `in ${hours} h${rest ? ' ' + rest + ' min' : ''}`
}

export function timeAgo (ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  if (m < 2880) return `${Math.round(m / 60)} h ago`
  return `${Math.round(m / 1440)} days ago`
}

export function stamp (ms) {
  const d = new Date(ms)
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}
