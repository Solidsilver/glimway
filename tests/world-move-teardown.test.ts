/**
 * A world move without a reload (step-back 2 2026-10-18, C1): App destroys
 * the old game and builds a new one. A destroyed scene gets `destroy`, never
 * `shutdown`, so whatever the old scene hung on the bus must let go then, or
 * it answers the new world's events first: its belt tracker swaps the
 * current pack model for a stale one, its relocation throws before the new
 * scene hears it, and its late naming read opens a panel over the new world.
 *
 * These build the real controllers and WorldScene's own bus wiring on scene
 * doubles, destroy the first, build the second, then play the new world.
 */
import './helpers/svelte-runes.ts'
import './helpers/scene-modules.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

// WorldScene extends Phaser.Scene and its imports name Phaser at load: a stub
// where every name is another stub (nothing here draws). `store.svelte`
// imports carry no `.ts`.
const PHASER = 'data:text/javascript,' + encodeURIComponent(`
const make = () => new Proxy(class {}, { get: (t, p) => (p in t ? t[p] : p === Symbol.toPrimitive ? undefined : make()) })
export default make()
`)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'phaser') return { url: PHASER, shortCircuit: true }
    if (specifier.startsWith('.') && specifier.endsWith('.svelte') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context)
    }
    return nextResolve(specifier, context)
  }
})

const { bus, EV } = await import('../src/game/events.ts')
const { itemsFor } = await import('../src/game/items.ts')
const { WorldControls } = await import('../src/game/scenes/world-controls.ts')
const { WorldScene } = await import('../src/game/scenes/WorldScene.ts')
const { WildsCamps } = await import('../src/game/wilds/camps.ts')
const { WildsCommunalLamps } = await import('../src/game/wilds/communal-lamps.ts')
const { WaysHome } = await import('../src/game/ways-home.ts')

const flush = () => new Promise((r) => setTimeout(r, 0))

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => (resolve = res))
  return { promise, resolve }
}

/** Anything called or read on it is itself (a drawing that draws nothing). */
const inert: any = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : inert), apply: () => inert })

/** A scene that shuts down or is destroyed when told, as Phaser's do. */
function scene() {
  const ends = new Map<string, Set<() => void>>()
  const end = (name: string) => {
    const fns = [...(ends.get(name) ?? [])]
    ends.delete(name)
    for (const fn of fns) fn()
  }
  const key = () => ({ on: () => {}, removeAllListeners: () => {} })
  return {
    events: {
      once: (name: string, fn: () => void) => void (ends.get(name) ?? ends.set(name, new Set()).get(name)!).add(fn),
      off: (name: string, fn: () => void) => void ends.get(name)?.delete(fn),
      on: () => {}
    },
    add: inert,
    textures: { exists: () => false },
    input: {
      keyboard: {
        addCapture: () => {},
        createCursorKeys: () => ({}),
        addKeys: (names: string) => Object.fromEntries(names.split(',').map((k) => [k, key()])),
        on: () => {},
        off: () => {}
      },
      on: () => {},
      off: () => {},
      mouse: { disableContextMenu: () => {} }
    },
    shutdown: () => end('shutdown'),
    destroy: () => end('destroy')
  }
}

/** A world's session: a link answering only what the test gives it. */
function session(worldId: string, answers: Record<string, (...args: never[]) => unknown> = {}) {
  const link = { worldId, accountId: 'acct', online: true, status: 'online', readWith: async () => ({ ok: false, code: 'offline' }), ...answers }
  return { link, state: { flags: {}, area: 'wilds', position: { x: 8, y: 8 } } } as never as { link: typeof link }
}

/** WorldScene's own bus wiring, on a double that records what reaches it. */
function sceneBus(s: ReturnType<typeof scene>, onRelocate: (p: unknown) => void) {
  const host = { events: s.events, onRelocate, refreshMarkers() {}, onProfileChanged() {}, onWorldRefresh() {}, notePosition() {}, onDialogueClosed() {} }
  ;(WorldScene.prototype as unknown as { listenBus(this: unknown): void }).listenBus.call(host)
}

/** One world's scene: the controllers C1 found holding on past a destroy. */
function build(s: ReturnType<typeof scene>, sess: ReturnType<typeof session>, onRelocate: (p: unknown) => void) {
  const deps = {
    session: sess as never,
    interactables: { register: () => {}, invalidatePrompt: () => {} } as never,
    solids: { children: null, add: () => {}, remove: () => {} } as never,
    hero: () => ({ x: 8, y: 8 }),
    notePosition: () => {},
    reducedMotion: true
  }
  sceneBus(s, onRelocate)
  new WorldControls(s as never, { session: sess as never, hero: () => inert, avatar: () => inert, interactables: deps.interactables, gathering: () => null, reducedMotion: true, live: () => true, act: () => {} })
  const camps = new WildsCamps(s as never, deps)
  const communal = new WildsCommunalLamps(s as never, deps)
  new WaysHome(s as never, { session: sess as never, hero: () => ({ x: 8, y: 8 }), threatened: () => false, transitioning: () => false, notePosition: () => {}, reducedMotion: true })
  return { camps, communal }
}

const WATCHED = [EV.relocate, EV.quest, EV.dialogueClosed, EV.itemsChanged, EV.held, EV.action, EV.cast, EV.dodge, EV.campDo, EV.lampNamed, EV.communalPost, EV.lampStoneLook, EV.waysHome, EV.waysHomeBind] as const
const counts = () => WATCHED.map((name) => bus.listenerCount(name))

test('a destroyed world lets go of the bus: the pack model, a relocation, a way home and a late naming are the new world’s', async () => {
  const opened: unknown[] = []
  const onOpen = (p: unknown) => opened.push(p)
  bus.on(EV.lampNamingOpen, onOpen)
  try {
    const before = counts()
    // World A, with a naming read for each kind of lamp still out when the move comes.
    const landmarks = { camp: deferred<unknown>(), communal: deferred<unknown>() }
    const bound = { a: 0, b: 0 }
    const sceneA = scene()
    const sessA = session('world-a', { lampLandmarksRead: () => (landmarks.camp.promise), waysHome: async () => (bound.a++, { ok: false, code: 'offline' }) })
    const relocatedA: unknown[] = []
    const a = build(sceneA, sessA, (p) => {
      relocatedA.push(p)
      // As the destroyed scene did: its camera is gone (step-back 2, C1).
      throw new Error('the old scene has no camera')
    })
    a.camps.onAction('name:lamp-1')
    ;(sessA.link as Record<string, unknown>).lampLandmarksRead = () => landmarks.communal.promise
    a.communal.onAction('name:lamp-2')

    // App's world move: the old game is destroyed (no shutdown), then the new one builds.
    sceneA.destroy()
    assert.deepEqual(counts(), before, 'world A holds nothing on the bus')
    const sceneB = scene()
    const sessB = session('world-b', { waysHome: async () => (bound.b++, { ok: false, code: 'offline' }) })
    const relocatedB: unknown[] = []
    build(sceneB, sessB, (p) => relocatedB.push(p))

    // An ordinary pack refresh keeps world B's model current.
    const model = itemsFor(sessB as never)
    model.adoptView({ instances: [] } as never)
    assert.equal(itemsFor(sessB as never), model, 'the loaded pack model is still the current one')
    assert.notEqual(model.view, null)

    // A relocation (a distant way home landing) reaches the new scene, and only it.
    bus.emit(EV.relocate, { area: 'wilds', x: 1, y: 2 } as never)
    assert.equal(relocatedA.length, 0)
    assert.equal(relocatedB.length, 1)

    // Binding a way home asks once, for world B.
    bus.emit(EV.waysHomeBind)
    await flush()
    assert.deepEqual(bound, { a: 0, b: 1 })

    // World A's naming reads, answered after its destroy: no panel over world B.
    const answer = { ok: true, value: { landmarks: [{ id: 'm', phrase: 'by the mere' }] } }
    landmarks.camp.resolve(answer)
    landmarks.communal.resolve(answer)
    await flush()
    assert.deepEqual(opened, [])

    sceneB.destroy()
    assert.deepEqual(counts(), before, 'world B lets go too')
  } finally {
    bus.off(EV.lampNamingOpen, onOpen)
  }
})

test('a destroyed scene’s cleanup leaves what Phaser already tore down alone', () => {
  // On destroy Phaser's cameras, input and display list are gone first: the
  // camps and lamps drop their references instead of tidying.
  const s = scene()
  const sess = session('w')
  const solids = { children: null, add: () => {}, remove: () => assert.fail('no tidying a destroyed group') }
  const deps = { session: sess as never, interactables: { register: () => assert.fail('no markers on a destroyed scene') } as never, solids: solids as never, hero: () => ({ x: 8, y: 8 }), notePosition: () => {}, reducedMotion: true }
  new WildsCamps(s as never, deps)
  new WildsCommunalLamps(s as never, deps)
  s.destroy()
})
