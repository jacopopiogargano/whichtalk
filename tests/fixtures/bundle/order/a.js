import { LOG_READY } from './log.js'
import { c } from './c.js'

export const a = 'a' + c
globalThis.__order.push('a' + (LOG_READY ? '' : '!'))
