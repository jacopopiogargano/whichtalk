// iCalendar export for starred and personal events (one file or one event).
import { prefs } from '../state/store.js'
import { authorLine, kindName } from '../data/catalog.js'
import { LOCATIONS, CONFERENCE_ID, CONFERENCE_NAME, CONFERENCE_SHORT, eventPageUrl } from '../data/conference.js'
import { visitStart, visitEnd } from './clashes.js'

const icsEscape = value => String(value || '')
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n')

// 20261208T013000Z
const icsTimestamp = seconds => new Date(seconds * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

function icsVenue (e) {
  const where = LOCATIONS[e.location]
  return [e.room, where ? where.venue || where.name : ''].filter(Boolean).join(', ')
}

function icsAlarm () {
  const minutes = prefs.reminderMinutes
  if (!minutes) return []
  return ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', `TRIGGER:-PT${minutes}M`, 'END:VALARM']
}

function personalVevent (e, stampNow, alarm) {
  return [
    'BEGIN:VEVENT',
    `UID:personal-${e.localId}@whichtalk.com`,
    `DTSTAMP:${stampNow}`,
    `DTSTART:${icsTimestamp(e.start)}`,
    `DTEND:${icsTimestamp(e.end)}`,
    `SUMMARY:${icsEscape(e.title)}`,
    `LOCATION:${icsEscape(e.room)}`,
    `DESCRIPTION:${icsEscape([kindName(e), e.notes].filter(Boolean).join('\n'))}`,
    `CATEGORIES:${icsEscape(e.personalKindLabel)}`,
    ...alarm,
    'END:VEVENT',
  ]
}

function catalogVevent (e, stampNow, alarm) {
  const url = eventPageUrl(e)
  const people = e.authors && e.authors.length ? '\n' + authorLine(e) : ''
  return [
    'BEGIN:VEVENT',
    `UID:${CONFERENCE_ID.replace(/-/g, '')}-${e.id}@whichtalk.com`,
    `DTSTAMP:${stampNow}`,
    `DTSTART:${icsTimestamp(visitStart(e))}`,
    `DTEND:${icsTimestamp(visitEnd(e))}`,
    `SUMMARY:${icsEscape(`[${CONFERENCE_SHORT}] ${e.title}`)}`,
    `LOCATION:${icsEscape(icsVenue(e))}`,
    `DESCRIPTION:${icsEscape(`${kindName(e)}${people}${url ? '\n' + url : ''}`)}`,
    ...(url ? [`URL:${url}`] : []),
    ...alarm,
    'END:VEVENT',
  ]
}

export function buildIcs (events) {
  const stampNow = icsTimestamp(Math.floor(Date.now() / 1000))
  const alarm = icsAlarm()
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//WhichTalk//${CONFERENCE_NAME}//EN`,
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${CONFERENCE_NAME}`,
  ]
  for (const e of events) {
    if (!e.start) continue
    lines.push(...(e.personal ? personalVevent(e, stampNow, alarm) : catalogVevent(e, stampNow, alarm)))
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}
