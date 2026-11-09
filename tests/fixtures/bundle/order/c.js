import { LOG_READY } from './log.js'

export const c = 'c'
globalThis.__order.push('c' + (LOG_READY ? '' : '!'))
