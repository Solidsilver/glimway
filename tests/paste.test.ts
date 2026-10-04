import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFields, parsePaste, swapped } from '../src/lib/habitica/paste.ts'

const U = '11111111-aaaa-4bbb-8ccc-222222222222'
const T = '99999999-ffff-4eee-9ddd-888888888888'
const X = 'abcdef01-2345-4678-89ab-cdef01234567'

test('labeled text, user id first', () => {
  assert.deepEqual(parsePaste(`User ID: ${U}\nAPI Token: ${T}`), { kind: 'labeled', userId: U, apiToken: T })
})

test('labeled text, token first (any order)', () => {
  assert.deepEqual(parsePaste(`API Token: ${T}\nUser ID: ${U}`), { kind: 'labeled', userId: U, apiToken: T })
})

test('labels are case-insensitive and tolerate punctuation, quotes and line breaks', () => {
  const shapes = [
    `user id = "${U}", api token = "${T}"`,
    `USER-ID -> ${U}   Api_Token → ${T}`.replace('→', '>'),
    `userid:\n\n${U}\n\napitoken:\n${T}`,
    `{"User ID": "${U}", "API Token": "${T}"}`,
    `User ID – ${U} · API Token – ${T}`,
    `‘User ID’: “${U}”\n‘API Token’: “${T}”`
  ]
  for (const text of shapes) {
    assert.deepEqual(parsePaste(text), { kind: 'labeled', userId: U, apiToken: T }, text)
  }
})

test('a single label decides its value; the other code goes to the other field', () => {
  // label first in the text
  assert.deepEqual(parsePaste(`API Token: ${T}\n${U}`), { kind: 'labeled', userId: U, apiToken: T })
  assert.deepEqual(parsePaste(`User ID: ${U}\n${T}`), { kind: 'labeled', userId: U, apiToken: T })
  // label second in the text (the bare code comes first)
  assert.deepEqual(parsePaste(`${T}\nUser ID: ${U}`), { kind: 'labeled', userId: U, apiToken: T })
  assert.deepEqual(parsePaste(`${U}\nAPI Token: ${T}`), { kind: 'labeled', userId: U, apiToken: T })
  // label contradicts order: the label wins
  assert.deepEqual(parsePaste(`API Token: ${U}\n${T}`), { kind: 'labeled', userId: T, apiToken: U })
  assert.deepEqual(parsePaste(`${U}\nUser ID: ${T}`), { kind: 'labeled', userId: T, apiToken: U })
})

test('two unlabeled UUIDs fill in order of appearance (user id first)', () => {
  assert.deepEqual(parsePaste(`${U}\n${T}`), { kind: 'unlabeled', userId: U, apiToken: T })
  assert.deepEqual(parsePaste(`here you go ${U}, then ${T}!`), { kind: 'unlabeled', userId: U, apiToken: T })
})

test('swap exchanges the two values', () => {
  assert.deepEqual(swapped({ userId: U, apiToken: T }), { userId: T, apiToken: U })
  const r = parsePaste(`${U} ${T}`)
  assert.equal(r.kind, 'unlabeled')
  if (r.kind === 'unlabeled') assert.deepEqual(swapped(r), { userId: T, apiToken: U })
})

test('rejected: zero, one and three-plus UUIDs say what was found', () => {
  const zero = parsePaste('hello there')
  assert.ok(zero.kind === 'error' && zero.found === 0 && /no IDs/.test(zero.message))
  const one = parsePaste(U)
  assert.ok(one.kind === 'error' && one.found === 1 && /one ID/.test(one.message))
  const three = parsePaste(`${U} ${T} ${X}`)
  assert.ok(three.kind === 'error' && three.found === 3 && /3 IDs/.test(three.message))
  assert.equal(parsePaste('').kind, 'error')
})

test('rejected: the same value twice', () => {
  assert.equal(parsePaste(`${U} ${U}`).kind, 'error')
  assert.equal(parsePaste(`User ID: ${U} API Token: ${U}`).kind, 'error')
})

test('three UUIDs with both labels present use the labels', () => {
  assert.deepEqual(parsePaste(`${X}\nUser ID: ${U}\nAPI Token: ${T}`), { kind: 'labeled', userId: U, apiToken: T })
})

test('error messages never echo pasted values', () => {
  for (const text of [U, `${U} ${T} ${X}`, 'nothing']) {
    const r = parsePaste(text)
    assert.ok(r.kind === 'error')
    assert.ok(!r.message.includes(U) && !r.message.includes(T))
  }
})

test('separate fields: valid, missing, malformed, identical', () => {
  assert.deepEqual(parseFields(` ${U} `, T), { kind: 'labeled', userId: U, apiToken: T })
  assert.equal(parseFields('', T).kind, 'error')
  assert.equal(parseFields(U, '').kind, 'error')
  assert.equal(parseFields('nope', T).kind, 'error')
  assert.equal(parseFields(U, 'nope').kind, 'error')
  assert.equal(parseFields(U, U).kind, 'error')
})
