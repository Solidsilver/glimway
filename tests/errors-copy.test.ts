import test from 'node:test'
import assert from 'node:assert/strict'
import { COMPANION_ERRORS, HOME_ERRORS, ITEM_ERRORS, TRANSPORT_ERRORS, VILLAGE_ERRORS, errorText, homeErrorText, itemErrorText, villageErrorText } from '../src/content/errors.ts'
import { SERVER_ERROR_CODES } from '../src/lib/api/errors.ts'

/** The client's own outcomes for a write (src/game/link.ts), and the guest refusal. */
const CLIENT_CODES = ['offline', 'superseded', 'busy', 'pending', 'resolved', 'guest']

test('every worded code is one the server or the client can actually give', () => {
  const known = new Set<string>([...SERVER_ERROR_CODES, ...CLIENT_CODES])
  for (const [name, table] of Object.entries({ ITEM_ERRORS, VILLAGE_ERRORS, HOME_ERRORS, COMPANION_ERRORS, TRANSPORT_ERRORS })) {
    const strays = Object.keys(table).filter((code) => !known.has(code))
    assert.deepEqual(strays, [], `${name} words codes nobody sends`)
  }
})

test('the transport lines are the same in every domain', () => {
  for (const code of Object.keys(TRANSPORT_ERRORS)) {
    assert.equal(itemErrorText(code), TRANSPORT_ERRORS[code])
    assert.equal(villageErrorText(code), TRANSPORT_ERRORS[code])
    assert.equal(homeErrorText(code), TRANSPORT_ERRORS[code])
  }
})

test('a domain words its own codes its own way, and falls back for the rest', () => {
  assert.match(itemErrorText('tier-required'), /workshop bench/)
  assert.match(villageErrorText('tier-required'), /the workshop\./)
  assert.match(homeErrorText('tier-required'), /cottage/)
  assert.match(homeErrorText('pending'), /charged twice/)
  assert.match(itemErrorText('pending'), /taken twice/)
  assert.equal(itemErrorText('no-such-code'), villageErrorText('no-such-code'))
  assert.match(homeErrorText('no-such-code'), /^Silas didn’t catch that/)
  // Object keys never leak through as words.
  assert.equal(errorText(ITEM_ERRORS, 'constructor', 'fallback'), 'fallback')
})
