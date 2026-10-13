import test from 'node:test'
import assert from 'node:assert/strict'
import { isConnectionReset, retryConnectionResetRead } from '../e2e/read-retry.ts'

test('safe reads retry one connection reset and return the successful read', async () => {
  let calls = 0
  const diagnostics: unknown[] = []
  const result = await retryConnectionResetRead(async () => {
    calls++
    if (calls === 1) throw Object.assign(new Error('read failed'), { cause: { code: 'ECONNRESET' } })
    return 'ok'
  }, (error) => diagnostics.push(error))
  assert.equal(result, 'ok')
  assert.equal(calls, 2)
  assert.equal(diagnostics.length, 1)
})

test('safe reads do not retry other failures or a second reset', async () => {
  let calls = 0
  const ordinary = new Error('bad response')
  await assert.rejects(retryConnectionResetRead(async () => { calls++; throw ordinary }, () => {}), ordinary)
  assert.equal(calls, 1)

  calls = 0
  const reset = Object.assign(new Error('read ECONNRESET'), { cause: { code: 'ECONNRESET' } })
  await assert.rejects(retryConnectionResetRead(async () => { calls++; throw reset }, () => {}), reset)
  assert.equal(calls, 2)
})

test('connection reset detection recognizes node transport errors only', () => {
  assert.equal(isConnectionReset(Object.assign(new Error('read failed'), { cause: { code: 'ECONNRESET' } })), true)
  assert.equal(isConnectionReset(new Error('connection reset by peer')), true)
  assert.equal(isConnectionReset(new Error('server returned 500')), false)
})
