// Not code: export const commentFake = 1; import { q } from './nope.js'
/* export function blockFake () {}
   import { r } from './nope.js' */
export function f () {
  return 'export const insideString = 1'
}

export async function g () {
  return `import { s } from './nope.js' ${'export let ' + `nested ${1 + 1}`} }`
}

export const x = 1, y = { a: [1, 2], b: 'export' }
export let z = x + 1
export class K {
  constructor () { this.name = 'export class' }
}
export const template = `${x}/${y.a.length}` + '/'
export const pattern = /export [a-z]+\/[^/]*/g
export const ratio = z / 2 / 1
export const { picked, ...rest } = { picked: 'p', other: 'o' }
export const [first, , third = 3] = ['one', 'two']
const privateHelper = () => third
privateHelper()
