import { Bus, EV, type EventMap } from '../src/game/events.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { effectRoot, flushEffects } from './helpers/svelte-runes.ts'

const { actionRunner, busVersion, latestRead, retryableRead } = await import('../src/ui/panel-state.svelte.ts')

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

/** A load whose answers the test hands out by hand, in any order. */
function pending<T>() {
  const asks: ((r: { ok: true; value: T } | { ok: false; code: string }) => void)[] = []
  const load = () => new Promise<{ ok: true; value: T } | { ok: false; code: string }>((r) => asks.push(r))
  return { asks, load }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

test('before anything is shown any good read is; after, only the newest', async () => {
  const { asks, load } = pending<string>()
  const view = latestRead(load)
  const first = view.read()
  const second = view.read()
  asks[0]({ ok: true, value: 'older' })
  await first
  assert.equal(view.value, 'older', 'an older answer shows while nothing else has')
  const third = view.read()
  asks[1]({ ok: true, value: 'stale' })
  await second
  assert.equal(view.value, 'older', 'an older answer landing late is dropped once something shows')
  asks[2]({ ok: true, value: 'newest' })
  await third
  assert.equal(view.value, 'newest')
  assert.equal(view.error, null)
})

test('an adopted answer counts as the newest: reads already out are older', async () => {
  const { asks, load } = pending<string[]>()
  const view = latestRead(load)
  const out = view.read()
  view.adopt(['b'])
  asks[0]({ ok: true, value: ['a', 'b'] })
  await out
  assert.deepEqual(view.value, ['b'], 'the read from before the take does not bring back what was taken')
})

test('a failure out of reach is asked again; a refusal is not', async () => {
  let calls = 0
  const answers = [{ ok: false as const, code: 'offline' }, { ok: false as const, code: 'internal' }, { ok: true as const, value: 7 }]
  const view = latestRead(async () => answers[calls++], 1)
  await view.read()
  assert.equal(view.error, 'offline', 'nothing shown yet: the panel says why')
  while (calls < 3) await new Promise((r) => setTimeout(r, 2))
  await settle()
  assert.equal(view.value, 7)
  assert.equal(view.error, null)

  let refusals = 0
  const gone = latestRead(async () => (refusals++, { ok: false as const, code: 'homestead-not-found' }), 1)
  await gone.read()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(refusals, 1, 'a refusal answers the same each time, so it is not asked again')
  assert.equal(gone.error, 'homestead-not-found')
  assert.equal(retryableRead('network'), true)
  assert.equal(retryableRead('not-found'), false)
})

test('a failed read after a good one keeps what is shown, and a stopped read asks no more', async () => {
  let calls = 0
  const answers = [{ ok: true as const, value: 'shown' }, { ok: false as const, code: 'offline' }]
  const view = latestRead(async () => answers[Math.min(calls++, 1)], 1)
  await view.read()
  await view.read()
  assert.equal(view.value, 'shown')
  assert.equal(view.error, null, 'the failure is not shown over a good view')
  view.stop()
  const before = calls
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(calls, before, 'the retry stops with the panel')
  await view.read()
  assert.equal(calls, before)
})

test('a retry stands down when a newer read is out', async () => {
  let calls = 0
  const { asks, load } = pending<number>()
  const view = latestRead(() => (calls++, load()), 1)
  const first = view.read()
  asks[0]({ ok: false, code: 'offline' })
  await settle()
  void view.read()
  await first
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(calls, 2, 'only the newer read is out; the failed one did not ask again')
})
