/**
 * A way home's pause in the scene (src/game/ways-home.ts): a slow frame is not
 * something taking the screen. CI, 2026-10-19: one 2.2 s frame while the hero
 * stood still let go of a turncap with "You moved", and the way home was
 * never asked for. Only a held frame (the scene's playHold) or a hidden tab
 * lets go.
 */
import './helpers/svelte-runes.ts'
import './helpers/scene-modules.ts'
import test from 'node:test'
import assert from 'node:assert/strict'

const { bus, EV } = await import('../src/game/events.ts')
const { WaysHome } = await import('../src/game/ways-home.ts')
const { WAYS_HOME_LINES } = await import('../src/lib/ways-home.ts')

/** Anything called or read on it is itself (a drawing that draws nothing). */
const inert: any = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : inert), apply: () => inert })

function world() {
  const ends: (() => void)[] = []
  const scene = { add: inert, time: { now: 0 }, events: { once: (_n: string, fn: () => void) => void ends.push(fn), off: () => {}, on: () => {} } }
  const asked: unknown[] = []
  const link = { waysHome: async (f: unknown) => (asked.push(f), { ok: false, code: 'offline' }) }
  const ways = new WaysHome(scene as never, { session: { link } as never, hero: () => ({ x: 40, y: 40 }), threatened: () => false, transitioning: () => false, notePosition: () => {}, reducedMotion: true })
  const toasts: string[] = []
  const onToast = (t: { text: string }) => void toasts.push(t.text)
  bus.on(EV.toast, onToast)
  const end = () => { bus.off(EV.toast, onToast); for (const fn of ends) fn() }
  return { scene, ways, asked, toasts, end }
}

test('a slow frame mid-pause is not a step: the way home is asked for once the pause has passed', async () => {
  const w = world()
  try {
    bus.emit(EV.waysHome, { way: 'turncap' })
    for (const t of [16, 32, 800, 2952, 3100]) {
      w.scene.time.now = t
      w.ways.update()
    }
    await Promise.resolve()
    assert.deepEqual(w.asked, [{ action: 'turncap', lamp: '' }])
    assert.ok(!w.toasts.includes(WAYS_HOME_LINES.moved), `no "You moved": ${JSON.stringify(w.toasts)}`)
  } finally {
    w.end()
  }
})

test('play held (a panel took the screen) lets go of the pause, and nothing is asked for', async () => {
  const w = world()
  try {
    bus.emit(EV.waysHome, { way: 'turncap' })
    w.scene.time.now = 16
    w.ways.update()
    w.ways.letGo()
    w.scene.time.now = 3100
    w.ways.update()
    await Promise.resolve()
    assert.deepEqual(w.asked, [])
    assert.ok(w.toasts.includes(WAYS_HOME_LINES.moved), JSON.stringify(w.toasts))
  } finally {
    w.end()
  }
})
