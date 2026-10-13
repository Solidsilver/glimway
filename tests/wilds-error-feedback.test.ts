import './helpers/scene-modules.ts'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fromJson, type JsonValue } from '@bufbuild/protobuf'
import { ITEM_ERRORS, TRANSPORT_ERRORS } from '../src/content/errors.ts'

const { WildsEntities } = await import('../src/game/wilds/entities.ts')
const { WildsSites } = await import('../src/game/wilds/sites.ts')
const { bus, EV } = await import('../src/game/events.ts')
const store = await import('../src/game/wilds/store.ts')
const { forgetChunks } = await import('../src/game/wilds/chunks.ts')
const { WildsNearResultSchema } = await import('../src/lib/gen/glimway/v1/wilds_pb.js')
const fixtures = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8')) as { case: string; json: JsonValue }[]
const near = fromJson(WildsNearResultSchema, fixtures.find((f) => f.case === 'valid-near')!.json)

function toasts(t: TestContext) {
  const messages: { text: string; kind?: string }[] = []
  const listen = (message: { text: string; kind?: string }) => messages.push(message)
  bus.on(EV.toast, listen)
  t.after(() => bus.off(EV.toast, listen))
  return messages
}

function rig(t: TestContext) {
  store.resetWilds({ quiet: true })
  forgetChunks()
  store.applyNear(near)
  t.after(() => { store.resetWilds({ quiet: true }); forgetChunks() })
  const session = {
    state: { area: 'wilds' },
    link: {
      status: 'online', accountId: 'hero',
      api: { operations: {
        near: async () => near,
        // These refusal paths do not draw or need any chunk geometry.
        chunk: async () => { throw new Error('no rendered chunks in this test') }
      } },
      wildsClaim: async (_request: unknown) => ({ ok: false, code: 'pending' }),
      wildsRelight: async (_request: unknown): Promise<any> => ({ ok: false, code: 'pending' })
    }
  }
  const deps = { session, hero: () => ({ x: -768, y: -1536 }), fx: { sparkBurst() {} } }
  const entities = Object.create(WildsEntities.prototype) as any
  entities.deps = deps
  const sites = Object.create(WildsSites.prototype) as any
  Object.assign(sites, { deps, cx: -2, cy: -4, epoch: { id: near.wick!.id }, opening: false, gone: false })
  return { session, entities, sites }
}

test('the production claim refusal path preserves pending copy and distinguishes malformed requests', (t) => {
  const messages = toasts(t)
  const entities = Object.create(WildsEntities.prototype) as any
  for (const [code, expected] of [
    ['pending', ITEM_ERRORS.pending], ['busy', TRANSPORT_ERRORS.busy], ['superseded', TRANSPORT_ERRORS.superseded],
    ['invalid-claim', 'That request was not understood. Try again.'],
    ['lantern-id-required', 'That request was not understood. Try again.'],
    ['new-server-code', 'The Wilds didn’t answer. Nothing was taken — try again in a moment.']
  ]) {
    entities.claimError(code)
    assert.deepEqual(messages.at(-1), { text: expected, kind: 'error' }, code)
  }
})

test('the production relight and rumour paths both tell the player a pending write may have applied', async (t) => {
  const messages = toasts(t)
  const { entities, sites } = rig(t)
  await entities.relight({ id: 'fallen-lantern', ownerId: 'hero', x: -48, y: -96 })
  assert.deepEqual(messages, [{ text: ITEM_ERRORS.pending, kind: 'error' }])
  await sites.openRumour({ id: 'rumour-feedback-test' })
  assert.deepEqual(messages, Array.from({ length: 2 }, () => ({ text: ITEM_ERRORS.pending, kind: 'error' })))
  assert.equal(sites.opening, false, 'the refusal releases the in-flight guard')
})

test('a second relight produces the already-lit refusal rather than transport-failure copy', async (t) => {
  const messages = toasts(t)
  const { session, entities } = rig(t)
  const requests: unknown[] = []
  session.link.wildsRelight = async (request) => {
    requests.push(request)
    return requests.length === 1
      ? { ok: true, result: { epoch: near.wick!.id, lanterns: [], rewarded: false } }
      : { ok: false, code: 'already-lit' }
  }
  const lantern = { id: 'fallen-lantern', ownerId: 'hero', x: -48, y: -96 }
  await entities.relight(lantern)
  await entities.relight(lantern)
  assert.equal(requests.length, 2)
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[1], { text: 'That lantern is already lit.', kind: 'error' })
})
