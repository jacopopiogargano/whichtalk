// d and b import each other: b is still being visited when d is reached, so d runs first.
import { b } from './b.js'

export const d = 'd'
export function callsBack () {
  return b()
}
globalThis.__order.push('d')
