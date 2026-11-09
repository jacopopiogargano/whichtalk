// Evaluation order fixture: every module appends its name when it runs.
import { a } from './a.js'
import { b } from './b.js'

globalThis.__order.push('main:' + a + b())
