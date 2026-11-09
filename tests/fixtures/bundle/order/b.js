import { a } from './a.js'
import { d } from './d.js'

export function b () {
  return a + d
}
globalThis.__order.push('b')
