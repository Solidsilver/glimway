import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { Bus, bus, EV, type EventMap } from '../src/game/events.ts'
import { TERRAIN } from '../src/lib/tile.ts'
import { BANK, sampleFiles, type CueDef } from '../src/game/sound-bank.ts'
import { groundOf, PAUSED_DUCK, routeSounds, SoundDirector, volumeGain, type PlayRequest, type SoundBackend } from '../src/game/sound.ts'
import { parseSoundPrefs, SOUND_DEFAULTS, SOUND_KEY, soundSettings } from '../src/game/sound-settings.ts'
import { sfx, voiceBlip } from '../src/game/sfx.ts'

/**
 * The sound module (src/game/sound.ts): which event plays which sound, the
 * rate cap and pitch variation, when it stays quiet, and the setting.
 */

/** A backend that records instead of making noise; the clock is set by hand. */
class FakeBackend implements SoundBackend {
  t = 0
  played: PlayRequest[] = []
  volume = -1
  loops: Array<string | null> = []
  ducks: number[] = []
  calls: string[] = []
  now() { return this.t }
  play(req: PlayRequest) { this.played.push(req) }
  setVolume(gain: number) { this.volume = gain }
  ambience(file: string | null) { this.loops.push(file) }
  duck(level: number) { this.ducks.push(level) }
  start() { this.calls.push('start') }
  suspend() { this.calls.push('suspend') }
  resume() { this.calls.push('resume') }
  cues() { return this.played.map((p) => p.cue) }
}

/** A director already past the first input, on its own bus. */
function rig(prefs = SOUND_DEFAULTS, random = () => 0.5) {
  const backend = new FakeBackend()
  const director = new SoundDirector(backend, prefs, random)
  const b = new Bus<EventMap>()
  routeSounds(b, director)
  director.start()
  return { backend, director, bus: b, tick: (s = 1) => { backend.t += s } }
}

test('footsteps follow the ground underfoot', () => {
  assert.equal(groundOf(TERRAIN.grass_b), 'grass')
  assert.equal(groundOf(TERRAIN.flowers), 'grass')
  assert.equal(groundOf(TERRAIN.path_a), 'path')
  assert.equal(groundOf(TERRAIN.dirt), 'path')
  assert.equal(groundOf(TERRAIN.cobble_moss), 'stone')
  assert.equal(groundOf(TERRAIN.stone_crack), 'stone')
  assert.equal(groundOf(TERRAIN.planks), 'wood')
  assert.equal(groundOf(TERRAIN.bridge), 'wood')
  assert.equal(groundOf(999), 'grass', 'an unknown tile walks as grass')

  const { bus: b, backend, tick } = rig()
  for (const terrain of [TERRAIN.grass_a, TERRAIN.cobble, TERRAIN.planks_dark, TERRAIN.path_b]) {
    b.emit(EV.footstep, { terrain })
    tick()
  }
  assert.deepEqual(backend.cues(), ['step-grass', 'step-stone', 'step-wood', 'step-path'])
  assert.match(backend.played[1].file ?? '', /^step-stone-\d\.mp3$/)
})

test('game events map to their sounds', () => {
  const { bus: b, backend, tick } = rig()
  const emit = (fn: () => void) => { fn(); tick() }
  emit(() => b.emit(EV.work, { action: 'chop' }))
  emit(() => b.emit(EV.work, { action: 'break' }))
  emit(() => b.emit(EV.work, { action: 'dig' }))
  emit(() => b.emit(EV.rolled, { cooldown: 0.75 }))
  emit(() => b.emit(EV.ability, { status: 'cast', cooldown: 1 }))
  emit(() => b.emit(EV.ability, { status: 'no-mana' }))
  emit(() => b.emit(EV.ability, { status: 'cooldown' })) // nothing: the HUD shows it
  emit(() => b.emit(EV.defeat, { phase: 'falling' }))
  emit(() => b.emit(EV.defeat, { phase: 'woke' })) // nothing
  emit(() => b.emit(EV.discovery, { id: 'well', label: 'The well' }))
  emit(() => b.emit(EV.planted, { plant: {} as never }))
  emit(() => b.emit(EV.homeChanged, { reason: 'buy' }))
  emit(() => b.emit(EV.homeChanged, { reason: 'placed' })) // nothing
  emit(() => b.emit(EV.libraryOpen))
  emit(() => b.emit(EV.sfx, { cue: 'hurt' }))
  emit(() => b.emit(EV.sfx, { cue: 'voice', speaker: 'Pip' }))
  assert.deepEqual(backend.cues(), ['chop', 'quarry', 'dig', 'roll', 'cast', 'fizzle', 'defeat', 'discover', 'plant', 'confirm', 'door-open', 'hurt', 'voice'])
  assert.equal(backend.played.at(-1)?.speaker, 'Pip')
  assert.equal(backend.played.at(-1)?.synth, 'voice', 'the dialogue patter stays procedural')
})

test('toasts: a bag gain rustles, an error refuses, a notice chimes, a thought is silent', () => {
  const { bus: b, backend, tick } = rig()
  b.emit(EV.toast, { text: 'Found: 2 timber.', kind: 'gain', gain: { to: 'bag', itemDef: 'timber', qty: 2 } })
  tick()
  b.emit(EV.toast, { text: 'A page.', kind: 'gain', gain: { to: 'journal', label: 'A page' } })
  tick()
  b.emit(EV.toast, { text: 'No.', kind: 'error' })
  tick()
  b.emit(EV.toast, { text: 'Hello.' })
  tick()
  b.emit(EV.toast, { text: 'Hm.', kind: 'thought' })
  assert.deepEqual(backend.cues(), ['pickup', 'fizzle', 'notice'])
})

test('embers in a toast play the coins once, not a chime as well', async () => {
  // The real emitter: a quest reward credited by the session.
  const w = globalThis as unknown as { window?: unknown }
  const hadWindow = 'window' in w
  if (!hadWindow) w.window = { setTimeout: () => 0, clearTimeout: () => {} }
  const { Session } = await import('../src/game/session.ts')
  const { createNewGame } = await import('../src/lib/state.ts')
  const backend = new FakeBackend()
  const director = new SoundDirector(backend, SOUND_DEFAULTS, () => 0.5)
  const stop = routeSounds(bus, director)
  director.start()
  try {
    new Session(createNewGame()).addEmbers(3, '+3 embers — a little warmth from the road.')
    assert.deepEqual(backend.cues(), ['ember'])
    // A caller that also says the cue: still once.
    backend.t += 1
    sfx('ember')
    bus.emit(EV.toast, { text: '+2 embers', icon: 'ember' })
    assert.deepEqual(backend.cues(), ['ember', 'ember'])
  } finally {
    stop()
    if (!hadWindow) delete w.window
  }
})

test('a notice gives way to the sound its toast came with', () => {
  const { bus: b, backend, tick } = rig()
  sfxOn(b, 'ember')
  b.emit(EV.toast, { text: '+3 embers' })
  assert.deepEqual(backend.cues(), ['ember'])
  tick()
  b.emit(EV.toast, { text: 'Later news' })
  assert.deepEqual(backend.cues(), ['ember', 'notice'])
})

function sfxOn(b: Bus<EventMap>, cue: 'ember') {
  b.emit(EV.sfx, { cue })
}

test('the door sounds going in and out of the cottage, not on other moves', () => {
  const { bus: b, backend, tick } = rig()
  for (const areaId of ['village', 'village', 'cottage', 'village', 'woodland']) {
    b.emit(EV.area, { areaId })
    tick()
  }
  assert.deepEqual(backend.cues(), ['door-open', 'door-close'])
})

test('the same sound never stacks in a frame; hits allow two', () => {
  const { director, backend, tick } = rig()
  assert.equal(director.play('swing'), true)
  assert.equal(director.play('swing'), false, 'same instant: capped')
  backend.t += 0.03
  assert.equal(director.play('swing'), false, 'inside the window')
  backend.t += 0.03
  assert.equal(director.play('swing'), true, 'past the window')
  tick()
  for (let i = 0; i < 6; i++) director.play('hit')
  assert.equal(backend.cues().filter((c) => c === 'hit').length, 2, 'a sweep hitting six plays two')
  tick()
  for (let i = 0; i < 10; i++) director.play('step-grass')
  assert.equal(backend.cues().filter((c) => c === 'step-grass').length, 1)
})

test('pitch varies a little, and a variant never repeats twice running', () => {
  let r = 0
  const seq = [0.0, 0.99, 0.5, 0.1, 0.9, 0.3, 0.7, 0.2]
  const { director, backend, tick } = rig(SOUND_DEFAULTS, () => seq[r++ % seq.length])
  for (let i = 0; i < 12; i++) {
    director.play('step-stone')
    tick()
  }
  const jitter = (BANK['step-stone'] as CueDef).jitter!
  for (const p of backend.played) assert.ok(Math.abs(p.rate - 1) <= jitter + 1e-9, `rate ${p.rate}`)
  assert.ok(new Set(backend.played.map((p) => p.rate.toFixed(3))).size > 3, 'not all the same pitch')
  const files = backend.played.map((p) => p.file)
  for (let i = 1; i < files.length; i++) assert.notEqual(files[i], files[i - 1])
  assert.ok(new Set(files).size >= 3)
})

test('quiet before the first input, while hidden, and with sound off', () => {
  const backend = new FakeBackend()
  const director = new SoundDirector(backend, SOUND_DEFAULTS)
  assert.equal(director.play('click'), false, 'autoplay rules: nothing before an input')
  assert.deepEqual(backend.calls, [])
  director.start()
  assert.deepEqual(backend.calls, ['start'])
  assert.equal(director.play('click'), true)

  backend.t += 1
  director.setHidden(true)
  assert.equal(director.play('click'), false)
  assert.equal(backend.calls.at(-1), 'suspend')
  director.setHidden(false)
  assert.equal(backend.calls.at(-1), 'resume')
  assert.equal(director.play('click'), true)

  backend.t += 1
  director.setPrefs({ on: false, volume: 0.6 })
  assert.equal(backend.volume, 0)
  assert.equal(director.play('click'), false)
  director.setPrefs({ on: true, volume: 0 })
  assert.equal(director.play('click'), false, 'volume at zero is off')
  director.setPrefs({ on: true, volume: 0.5 })
  assert.equal(backend.volume, volumeGain({ on: true, volume: 0.5 }))
  assert.equal(director.play('click'), true)
})

test('a later input wakes the audio again; sound turned on later starts it then', () => {
  const backend = new FakeBackend()
  const director = new SoundDirector(backend, { on: false, volume: 0.6 })
  director.start()
  assert.deepEqual(backend.calls, [], 'off: no context, nothing fetched')
  director.setPrefs({ on: true, volume: 0.6 })
  assert.deepEqual(backend.calls, ['start'])
  director.start()
  assert.deepEqual(backend.calls, ['start', 'resume'])
})

test('paused: the world bus ducks (sounds already playing follow), the interface does not', () => {
  const { director, backend } = rig()
  director.setPaused(true)
  director.setPaused(true) // no change, no second ramp
  director.play('hit')
  director.play('click')
  director.setPaused(false)
  assert.deepEqual(backend.ducks, [PAUSED_DUCK, 1])
  const [hit, click] = backend.played
  assert.equal(hit.world, true)
  assert.equal(click.world, false)
  assert.equal(hit.gain, (BANK.hit as CueDef).gain, 'the duck is on the bus, not baked into the cue')
  assert.ok(backend.loops.every((l) => l === null), 'no ambience delivered yet')
})

test('sfx() and voiceBlip() only say the cue on the bus', () => {
  const heard: unknown[] = []
  const fn = (p: unknown) => heard.push(p)
  bus.on(EV.sfx, fn)
  sfx('lantern')
  voiceBlip('Mara')
  bus.off(EV.sfx, fn)
  assert.deepEqual(heard, [{ cue: 'lantern' }, { cue: 'voice', speaker: 'Mara' }])
})

test('the setting: defaults, clamping, and kept per device', () => {
  assert.deepEqual(parseSoundPrefs(null), SOUND_DEFAULTS)
  assert.deepEqual(SOUND_DEFAULTS, { on: true, volume: 0.6 })
  assert.deepEqual(parseSoundPrefs({ on: false, volume: 3 }), { on: false, volume: 1 })
  assert.deepEqual(parseSoundPrefs({ on: 'yes', volume: 'loud' }), SOUND_DEFAULTS)

  const items = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v)
  }
  soundSettings.reload()
  const seen: boolean[] = []
  const stop = soundSettings.watch((p) => seen.push(p.on))
  soundSettings.set({ on: false })
  soundSettings.set({ volume: 0.25 })
  stop()
  assert.deepEqual(JSON.parse(items.get(SOUND_KEY)!), { on: false, volume: 0.25 })
  assert.deepEqual(seen, [true, false, false])
  soundSettings.reload()
  assert.deepEqual(soundSettings.prefs, { on: false, volume: 0.25 })

  // Storage refused (a private window): the change holds for this visit.
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') }
  }
  soundSettings.reload()
  assert.deepEqual(soundSettings.prefs, SOUND_DEFAULTS)
  soundSettings.set({ volume: 0.9 })
  assert.equal(soundSettings.prefs.volume, 0.9)
  delete (globalThis as { localStorage?: unknown }).localStorage
})

test('every sample the bank names is delivered, credited, and nothing else is shipped', () => {
  const dir = new URL('../public/assets/audio/kenney/', import.meta.url)
  const shipped = readdirSync(dir).filter((f) => f.endsWith('.mp3')).sort()
  assert.deepEqual(shipped, sampleFiles().sort())
  const register = readFileSync(new URL('../ASSETS.md', import.meta.url), 'utf8')
  for (const f of shipped) assert.ok(register.includes(`\`${f}\``), `${f} is in ASSETS.md`)
  for (const [cue, def] of Object.entries(BANK) as [string, CueDef][]) {
    assert.ok(!!def.synth !== !!def.files?.length, `${cue}: a sample or a voice, not both`)
  }
})

// ---------------------------------------------------------------------------
// The Web Audio backend against a stand-in AudioContext: what waits for its
// sample, and for how long.

/** Just enough AudioContext: records what starts, decodes instantly. */
class FakeContext {
  static last: FakeContext
  state: 'running' | 'suspended' = 'running'
  currentTime = 0
  destination = {}
  started: string[] = []
  onstatechange: (() => void) | null = null
  constructor() { FakeContext.last = this }
  private node() {
    return { gain: { value: 1, setTargetAtTime() {} }, connect: (n: unknown) => n }
  }
  createGain() { return this.node() }
  createBufferSource() {
    const ctx = this
    return { buffer: null as { name: string } | null, playbackRate: { value: 1 }, loop: false, connect: (n: unknown) => n, start() { ctx.started.push(this.buffer!.name) }, stop() {} }
  }
  decodeAudioData(data: ArrayBuffer & { name?: string }) { return Promise.resolve({ name: data.name ?? '?' }) }
  resume() { this.state = 'running'; this.onstatechange?.(); return Promise.resolve() }
  suspend() { this.state = 'suspended'; return Promise.resolve() }
}

/** A backend whose files arrive when the test says, on a hand-set clock. */
async function webRig() {
  const { WebAudioBackend, LATE_MS } = await import('../src/game/sound-web.ts')
  const w = globalThis as unknown as { window?: unknown }
  w.window = { AudioContext: FakeContext }
  const gates = new Map<string, { open: () => void; fail: () => void }>()
  let ms = 0
  const backend = new WebAudioBackend({
    clock: () => ms,
    fetchFile: (url) =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        const name = url.split('/').pop()!
        gates.set(name, { open: () => resolve(Object.assign(new ArrayBuffer(1), { name })), fail: () => reject(new Error('404')) })
      })
  })
  backend.setVolume(1)
  backend.start()
  const ctx = FakeContext.last
  /** Let the file through, then let its decode settle. */
  const arrive = async (name: string, ok = true) => {
    const g = gates.get(name)!
    if (ok) g.open()
    else g.fail()
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  const req = (file: string, world = false): PlayRequest => ({ cue: 'click', file, gain: 1, rate: 1, world })
  return { backend, ctx, arrive, req, LATE_MS, wait: (n: number) => { ms += n }, done: () => delete w.window }
}

test('a cue asked for while its sample loads plays when it arrives, if still in time', async () => {
  const { backend, ctx, arrive, req, wait, LATE_MS, done } = await webRig()
  try {
    // The first input's own sound: asked for at once, before anything is decoded.
    backend.play(req('ui-open.mp3'))
    assert.deepEqual(ctx.started, [])
    wait(120)
    await arrive('ui-open.mp3')
    assert.deepEqual(ctx.started, ['ui-open.mp3'], 'played on arrival, once')
    await arrive('ui-open.mp3')
    assert.deepEqual(ctx.started, ['ui-open.mp3'])

    // Too late: the moment has passed, so it never plays.
    backend.play(req('chop-1.mp3'))
    wait(LATE_MS + 1)
    await arrive('chop-1.mp3')
    assert.deepEqual(ctx.started, ['ui-open.mp3'])

    // Loaded already: at once.
    backend.play(req('ui-open.mp3'))
    assert.deepEqual(ctx.started, ['ui-open.mp3', 'ui-open.mp3'])
  } finally {
    done()
  }
})

test('a sample that fails to load stays a silent no-op', async () => {
  const { backend, ctx, arrive, req, done } = await webRig()
  try {
    backend.play(req('hurt.mp3'))
    await arrive('hurt.mp3', false)
    backend.play(req('hurt.mp3'))
    await Promise.resolve()
    assert.deepEqual(ctx.started, [])
  } finally {
    done()
  }
})

test('cues asked for while the context is still waking play when it runs, if still in time', async () => {
  const { backend, ctx, arrive, req, wait, done } = await webRig()
  try {
    await arrive('ui-click.mp3')
    await arrive('roll.mp3')
    ctx.state = 'suspended'
    backend.play(req('ui-click.mp3'))
    wait(400)
    backend.play(req('roll.mp3', true))
    assert.deepEqual(ctx.started, [])
    await ctx.resume()
    assert.deepEqual(ctx.started, ['roll.mp3'], 'the stale click was dropped')
  } finally {
    done()
  }
})
