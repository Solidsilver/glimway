import { Bus, EV, type EventMap } from '../src/game/events.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { effectRoot, flushEffects } from './helpers/svelte-runes.ts'

const { actionRunner, busVersion } = await import('../src/ui/panel-state.svelte.ts')

test('an action runs alone, holds busy while it runs, and leaves its line', async () => {
  const a = actionRunner()
  a.say('old line')
  let answer!: (v: { ok: true; value: number }) => void
  const first = a.run('make', () => new Promise<{ ok: true; value: number }>((r) => (answer = r)), (done) => `Made ${done.value}.`)
  assert.equal(a.busy, 'make')
  assert.equal(a.message, null, 'the old line clears when an action starts')
  assert.equal(await a.run('other', async () => ({ ok: true, value: 0 }), 'no'), null, 'a second action waits its turn')
  answer({ ok: true, value: 3 })
  assert.deepEqual(await first, { ok: true, value: 3 })
  assert.equal(a.busy, null)
  assert.deepEqual(a.message, { text: 'Made 3.', kind: 'ok' })
})

test('a refusal says its own words, or the panel’s', async () => {
  const a = actionRunner()
  await a.run('x', async () => ({ ok: false, code: 'busy', text: 'Hold on.' }), 'fine')
  assert.deepEqual(a.message, { text: 'Hold on.', kind: 'error' })
  await a.run('x', async () => ({ ok: false, code: 'insufficient-glims', text: 'Short.' }), 'fine', (r) => `Silas: ${r.code}`)
  assert.deepEqual(a.message, { text: 'Silas: insufficient-glims', kind: 'error' })
  await a.run('x', async () => ({ ok: true, value: undefined }), null)
  assert.equal(a.message, null, 'a null success line says nothing')
})

test('a throwing action still frees the panel', async () => {
  const a = actionRunner()
  await assert.rejects(a.run('x', async () => Promise.reject(new Error('boom')), 'fine'))
  assert.equal(a.busy, null)
})

test('the bus counter bumps on its events and stops listening when its owner goes', async () => {
  const bus = new Bus<EventMap>()
  let v!: { readonly value: number }
  const stop = await effectRoot(() => {
    v = busVersion(bus, EV.companions, EV.wardrobe)
  })
  assert.equal(v.value, 0)
  bus.emit(EV.companions)
  bus.emit(EV.wardrobe)
  bus.emit(EV.clock)
  await flushEffects()
  assert.equal(v.value, 2)
  stop()
  assert.equal(bus.listenerCount(EV.companions), 0)
  assert.equal(bus.listenerCount(EV.wardrobe), 0)
})
