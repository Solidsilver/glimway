import test from 'node:test'
import assert from 'node:assert/strict'
import { devFightFall, DEV_FIGHT_FALL_JOIN_MS, DEV_FIGHT_FALL_PATH } from '../src/game/wilds/dev-fight-fall.ts'

const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

function deps(over: Partial<Parameters<typeof devFightFall>[1]> = {}) {
  let clock = 0, reads = 0
  return {
    deps: { read: () => { reads++ }, joined: () => true, sleep: async (ms: number) => { clock += ms }, now: () => clock, ...over },
    get reads() { return reads },
    get clock() { return clock }
  }
}

test('dev fight-fall posts the camp id and reads the Wilds again on success', async () => {
  const calls: { url: string; body: string }[] = []
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) })
    return new Response(JSON.stringify({ entity: 'camp:1:2:0', room: 4, epoch: 'still', cycle: 3, fellAt: 1791400000123, witnesses: ['a', 'me'] }), { status: 200 })
  }) as unknown as typeof fetch
  const r = deps({ fetcher })
  assert.deepEqual(await devFightFall('camp:1:2:0', r.deps), { ok: true, status: 200, room: 4, epoch: 'still', cycle: 3, fellAt: 1791400000123, witnesses: ['a', 'me'] })
  assert.deepEqual(calls, [{ url: DEV_FIGHT_FALL_PATH, body: '{"entity":"camp:1:2:0"}' }])
  assert.equal(r.reads, 1)
})

test('it waits for this socket’s join of the camp’s room (the server clears only a covered room)', async () => {
  let joinedAt = 300
  const r = deps({ joined: (cx: number, cy: number) => { assert.deepEqual([cx, cy], [1, 2]); return r.clock >= joinedAt }, fetcher: answer(200, { room: 1, epoch: 'still', cycle: 0, fellAt: 0, witnesses: [] }) })
  await devFightFall('camp:1:2:0', r.deps)
  assert.equal(r.clock, 300, 'posted as soon as the join landed')
  joinedAt = Infinity
  const late = deps({ joined: () => false, fetcher: answer(409, { error: { code: 'not-here' } }) })
  assert.deepEqual(await devFightFall('camp:1:2:0', late.deps), { ok: false, status: 409, code: 'not-here' })
  assert.equal(late.clock, DEV_FIGHT_FALL_JOIN_MS, 'bounded wait, then the server’s word')
})

test('without a dev server (404) or on a refusal nothing is read and nothing falls back', async () => {
  const r = deps({ fetcher: answer(404, {}) })
  assert.deepEqual(await devFightFall('camp:1:2:0', r.deps), { ok: false, status: 404, code: '' })
  assert.deepEqual(await devFightFall('nonsense', deps().deps), { ok: false, status: 0, code: 'entity-not-found' })
  assert.equal(r.reads, 0)
})
