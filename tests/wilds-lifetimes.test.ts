/**
 * The open map's lamp models live as long as their world and scene (step-back
 * 2026-10-18, G2 and G3): a world move draws none of the old world's camps,
 * a naming read that lands after its scene has gone opens no panel, a land
 * status read that failed recovers while you stand still, and your own land
 * changes (a lamp relit, a path laid) make the chip ask again.
 */
import './helpers/scene-modules.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { create, fromJson, type JsonValue } from '@bufbuild/protobuf'

const { CampViewSchema } = await import('../src/lib/gen/glimway/v1/camps_pb.js')
const { ChunkLandStatusSchema, WildsNearResultSchema } = await import('../src/lib/gen/glimway/v1/wilds_pb.js')
const { WildsCamps } = await import('../src/game/wilds/camps.ts')
const { WildsCommunalLamps } = await import('../src/game/wilds/communal-lamps.ts')
const { adoptCamps, campsKnown, forgetCamps } = await import('../src/game/wilds/camps-state.ts')
const store = await import('../src/game/wilds/store.ts')
const ops = await import('../src/game/wilds/ops.ts')
const { forgetChunks } = await import('../src/game/wilds/chunks.ts')
const { LandHere, RETRY_MS } = await import('../src/game/wilds/land-here.ts')
const { bus, EV } = await import('../src/game/events.ts')

/** A promise and its settling, for answers held back. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

/** A scene that draws nothing and shuts down when told. */
function scene() {
  const ends: (() => void)[] = []
  return {
    events: { once: (name: string, fn: () => void) => void (name === 'shutdown' && ends.push(fn)) },
    textures: { exists: () => false },
    shutdown: () => ends.splice(0).forEach((fn) => fn()),
  }
}

/** A link that only answers what a test gives it; anything else is offline. */
function link(worldId: string, accountId: string, answers: Record<string, (...args: never[]) => unknown> = {}) {
  const base = { worldId, accountId, online: true, status: 'online', readWith: async () => ({ ok: false, code: 'offline' }), ...answers }
  return base as never as { worldId: string; accountId: string }
}

function controllerDeps(l: unknown) {
  const registered: unknown[][] = []
  return {
    registered,
    deps: {
      session: { link: l, state: { flags: {} } } as never,
      interactables: { register: (_owner: unknown, points: unknown[]) => void registered.push(points) } as never,
      solids: { children: null, add: () => {}, remove: () => {} } as never,
      hero: () => ({ x: 8, y: 8 }),
      notePosition: () => {},
      reducedMotion: true,
    },
  }
}

const campAt = (id: string, cx: number, cy: number) => create(CampViewSchema, { id, cx, cy, x: cx * 32 + 4, y: cy * 32 + 4, setterId: 'someone', oil: 1, pieces: [{ id, itemDef: 'way-lamp', x: cx * 32 + 4, y: cy * 32 + 4, ownerId: 'someone' }] })

// ------------------------------------------------------------ G2: the camp cache and its world

test('a world move draws none of the old world’s camps, and a departed scene’s late read keeps nothing', async () => {
  forgetCamps()
  // World A: its read lands and its camps are known, for A only.
  const heldA = deferred<unknown>()
  const linkA = link('world-a', 'acct', { campsRead: () => heldA.promise })
  const a = controllerDeps(linkA)
  const sceneA = scene()
  const campsA = new WildsCamps(sceneA as never, a.deps)
  adoptCamps(linkA, { list: [campAt('camp-a', 0, 0)], me: 'acct' })
  assert.equal(campsKnown(linkA).list.length, 1)
  // A second read of A is out when the move comes.
  const lateA = campsA.read()
  sceneA.shutdown()

  // World B, the same account: the first draw, before B's own read, has no camps at all.
  const heldB = deferred<unknown>()
  const linkB = link('world-b', 'acct', { campsRead: () => heldB.promise })
  const b = controllerDeps(linkB)
  const campsB = new WildsCamps(scene() as never, b.deps)
  campsB.update()
  assert.deepEqual(b.registered.at(-1), [], 'nothing of world A is drawn or offered in world B')
  assert.deepEqual(campsKnown(linkB).list, [], 'the pack sees no camp here either')

  heldB.resolve({ ok: true, value: { camps: [campAt('camp-b', 9, 9)], people: [] } })
  await flush()
  assert.deepEqual(campsKnown(linkB).list.map((c) => c.id), ['camp-b'])
  assert.equal(campsKnown(linkB).me, 'acct')
  // World A's read, answered after the move: it belongs to a scene that has gone.
  heldA.resolve({ ok: true, value: { camps: [campAt('camp-a', 0, 0)], people: [] } })
  await lateA
  assert.deepEqual(campsKnown(linkB).list.map((c) => c.id), ['camp-b'], 'B keeps its own camps')
  assert.deepEqual(campsKnown(linkA).list, [])
})

test('another account on the same page, or leaving the world, sees no camps', () => {
  forgetCamps()
  adoptCamps({ worldId: 'w', accountId: 'ana' }, { list: [campAt('c', 0, 0)], me: 'ana' })
  assert.equal(campsKnown({ worldId: 'w', accountId: 'ana' }).list.length, 1)
  assert.deepEqual(campsKnown({ worldId: 'w', accountId: 'bo' }).list, [])
  assert.deepEqual(campsKnown(null).list, [])
  forgetCamps()
  assert.deepEqual(campsKnown({ worldId: 'w', accountId: 'ana' }).list, [])
})

// ------------------------------------------------------------ G2: naming after the scene has gone

for (const kind of ['camp', 'communal'] as const) {
  test(`a ${kind} naming read that lands after its scene shut down opens no panel`, async () => {
    const opened: unknown[] = []
    const listen = (p: unknown) => opened.push(p)
    bus.on(EV.lampNamingOpen, listen)
    try {
      const make = (held: Promise<unknown>) => {
        const s = scene()
        const { deps } = controllerDeps(link('w', 'acct', { lampLandmarksRead: () => held }))
        const c = kind === 'camp' ? new WildsCamps(s as never, deps) : new WildsCommunalLamps(s as never, deps)
        return { s, c }
      }
      const answer = { ok: true, value: { landmarks: [{ id: 'm', phrase: 'by the mere' }] } }
      // Still here: the panel opens.
      const live = deferred<unknown>()
      const here = make(live.promise)
      here.c.onAction('name:lamp-1')
      live.resolve(answer)
      await flush()
      assert.equal(opened.length, 1)
      // Walked through a door while it was read: no panel for the lamp left behind.
      const late = deferred<unknown>()
      const gone = make(late.promise)
      gone.c.onAction('name:lamp-2')
      gone.s.shutdown()
      late.resolve(answer)
      await flush()
      assert.equal(opened.length, 1)
      here.s.shutdown()
    } finally {
      bus.off(EV.lampNamingOpen, listen)
    }
  })
}

// ------------------------------------------------------------ G2: an operation's outcome after the scene has gone

for (const kind of ['camp', 'communal'] as const) {
  test(`a ${kind} operation’s refusal or pending, answered after its scene shut down, is still told; its panel is not`, async () => {
    const toasts: { text: string; kind?: string }[] = []
    const panels: unknown[] = []
    const onToast = (p: { text: string; kind?: string }) => toasts.push(p)
    const onPanel = (p: unknown) => panels.push(p)
    bus.on(EV.toast, onToast)
    bus.on(EV.dialogue, onPanel)
    try {
      /** Start an operation, walk through a door, then answer it. */
      const across = async (action: string, answer: unknown) => {
        const held = deferred<unknown>()
        const s = scene()
        const { deps } = controllerDeps(link('w', 'acct', kind === 'camp' ? { camp: () => held.promise, readCommons: async () => ({ ok: false, code: 'offline' }) } : { communalLamp: () => held.promise }))
        const c = kind === 'camp' ? new WildsCamps(s as never, deps) : new WildsCommunalLamps(s as never, deps)
        c.onAction(action)
        s.shutdown()
        held.resolve(answer)
        await flush()
      }
      await across(kind === 'camp' ? 'down:camp-1' : 'relight:stone-1', { ok: false, code: 'pending' })
      assert.equal(toasts.length, 1)
      assert.match(toasts[0]!.text, /may have gone through/)
      assert.equal(toasts[0]!.kind, 'error')
      await across(kind === 'camp' ? 'down:camp-1' : 'relight:stone-1', { ok: false, code: 'too-far-away' })
      assert.equal(toasts.length, 2, 'a refusal is told too')
      assert.equal(toasts[1]!.kind, 'error')
      if (kind === 'camp') {
        // A fill that went through: its toast-less panel is for the scene left behind.
        await across('fill:camp-1', { ok: true, result: { camp: campAt('camp-1', 0, 0) } })
        assert.deepEqual(panels, [])
      } else {
        // A relight that went through: its toast is told.
        await across('relight:stone-1', { ok: true, result: { lamp: null } })
        assert.equal(toasts.length, 3)
      }
    } finally {
      bus.off(EV.toast, onToast)
      bus.off(EV.dialogue, onPanel)
    }
  })
}

// ------------------------------------------------------------ G3: the land chip recovers and is told

const fixtures = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8')) as { case: string; json: JsonValue }[]
const NEAR = fixtures.find((f) => f.case === 'valid-near')!.json as Record<string, any>
const WICK = NEAR.wick.id as string
const wild = create(ChunkLandStatusSchema, { tier: 'wild', nextTurning: 'detail-turns' })
const common = create(ChunkLandStatusSchema, { tier: 'common', nextTurning: 'carries', visited: true })

function start(): void {
  store.resetWilds({ quiet: true })
  forgetChunks()
  ops.forgetOps()
  store.applyNear(fromJson(WildsNearResultSchema, structuredClone(NEAR) as JsonValue))
  store.takeReadRequest()
}

/** A session whose status reads answer from `answers` in turn (an Error fails one). */
function statusSession(answers: (unknown | Error)[]) {
  const asked: string[] = []
  const l = {
    online: true,
    api: {
      operations: {
        mapStatus: async (chunks: { cx: number; cy: number }[]) => {
          asked.push(`${chunks[0]!.cx},${chunks[0]!.cy}`)
          const next = answers.shift()
          if (next instanceof Error || next === undefined) throw next ?? new Error('no answer')
          return { wick: WICK, chunks: [next] }
        },
      },
    },
  }
  return { asked, session: { link: l } as never }
}

test('a failed status read is asked again while you stand still, and the chip recovers', async () => {
  start()
  const chips: (string | null)[] = []
  const listen = (p: { chip: { text: string } | null }) => chips.push(p.chip?.text ?? null)
  const { asked, session } = statusSession([new Error('down'), new Error('still down'), wild])
  let clock = 0
  const here = new LandHere((cx, cy) => store.refreshLand(session, cx, cy), () => clock)
  bus.on(EV.landHere, listen)
  try {
    const frame = async () => {
      here.update(0, 0, store.wildsView(), store.landRevision())
      await flush()
    }
    await frame()
    assert.equal(asked.length, 1)
    // Standing still: no read again until the wait is over, however many frames pass.
    for (let i = 0; i < 5; i++) await frame()
    clock += RETRY_MS - 1
    await frame()
    assert.equal(asked.length, 1)
    clock += 1
    await frame()
    assert.equal(asked.length, 2, 'asked again without a step')
    // A second failure waits longer.
    clock += RETRY_MS
    await frame()
    assert.equal(asked.length, 2)
    clock += RETRY_MS
    await frame()
    assert.equal(asked.length, 3)
    await frame()
    assert.equal(chips.at(-1), 'Turning', 'the answer reaches the chip')
    clock += 60_000
    await frame()
    assert.equal(asked.length, 3, 'once answered, standing still asks no more')
  } finally {
    bus.off(EV.landHere, listen)
    here.clear()
  }
})

test('a lamp relit and a path laid make the chip ask again while you stand still', async () => {
  start()
  const { asked, session } = statusSession([wild, common, wild])
  let clock = 0
  const here = new LandHere((cx, cy) => store.refreshLand(session, cx, cy), () => clock)
  const frame = async () => {
    here.update(0, 0, store.wildsView(), store.landRevision())
    await flush()
  }
  await frame()
  await frame()
  assert.equal(asked.length, 1)

  // The real communal act: a first lamp relit here.
  const relit = deferred<unknown>()
  const { deps } = controllerDeps(link('w', 'acct', { communalLamp: () => relit.promise }))
  const s = scene()
  const lamps = new WildsCommunalLamps(s as never, deps)
  lamps.onAction('relight:stone-1')
  relit.resolve({ ok: true, result: { lamp: null } })
  await flush()
  await frame()
  assert.equal(asked.length, 2, 'the chip asks again without a step')
  await frame()
  assert.equal(store.wildsView()!.land.get('0,0')?.tier, 'common')

  // A path laid: the real answer path, its chunk's tier may change.
  ops.trackOp({ key: 'lay-1', kind: 'lay', world: 'w', wick: WICK, epoch: WICK, cx: -2, cy: -4, token: null, material: 'stone' })
  ops.settleWildsOp({ kind: 'wilds-lay', key: 'lay-1', world: 'w', outcome: { ok: true, result: { $typeName: 'glimway.v1.WildsLayResult', materials: { stone: 3 }, waysMade: [] } as never } })
  await frame()
  assert.equal(asked.length, 3)
  s.shutdown()
  here.clear()
})

test('a land change while a status read is out asks once more, after it comes back', async () => {
  const held: ReturnType<typeof deferred<boolean>>[] = []
  const here = new LandHere(() => {
    const d = deferred<boolean>()
    held.push(d)
    return d.promise
  }, () => 0)
  const view = { version: 1, wick: { id: 'w1' }, land: new Map() } as never
  here.update(0, 0, view, 0)
  here.update(0, 0, view, 1)
  here.update(0, 0, view, 2)
  assert.equal(held.length, 1, 'no second read while one is out')
  held[0]!.resolve(true)
  await flush()
  here.update(0, 0, view, 2)
  assert.equal(held.length, 2, 'the change made meanwhile is asked about')
  held[1]!.resolve(true)
  await flush()
  here.update(0, 0, view, 2)
  assert.equal(held.length, 2)
  here.clear()
})

test('the first draw after a world move asks the new world, and shows none of the old land meanwhile', () => {
  const asked: string[] = []
  const chips: (string | null)[] = []
  const listen = (p: { chip: { text: string } | null }) => chips.push(p.chip?.text ?? null)
  bus.on(EV.landHere, listen)
  try {
    const here = new LandHere((cx, cy) => {
      asked.push(`${cx},${cy}`)
    }, () => 0)
    // The same chunk, wick id and version in both worlds: only the view differs.
    const worldA = { version: 3, wick: { id: 'w1' }, land: new Map([['0,0', common]]) } as never
    const worldB = { version: 3, wick: { id: 'w1' }, land: new Map() } as never
    here.update(0, 0, worldA)
    assert.deepEqual(chips, ['Common'])
    // The move forgets the Wilds: no view, no chip.
    here.update(0, 0, null)
    assert.deepEqual(chips, ['Common', null])
    here.update(0, 0, worldB)
    assert.deepEqual(asked, ['0,0', '0,0'], 'the new world is asked, though the old one was asked a moment ago')
    assert.deepEqual(chips, ['Common', null])
    here.clear()
  } finally {
    bus.off(EV.landHere, listen)
  }
})
