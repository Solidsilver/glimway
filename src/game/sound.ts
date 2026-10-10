/**
 * The sound module: the one place that turns game and interface events into
 * sound. Scenes and panels never call audio; they emit on the typed bus
 * (src/game/events.ts) and this listens. A plain cue goes out as `EV.sfx`
 * (src/game/sfx.ts) where no richer event fits.
 *
 * The director decides what plays: the cue's sample (sound-bank.ts) at a
 * slightly varied pitch, never the same cue stacked in a frame, nothing
 * before the first input, while the tab is hidden or with sound off, and
 * the world's sounds ducked while the game is paused (a panel or a
 * conversation holds the world). The backend (sound-web.ts) only makes the
 * noise, so Node tests run the director against a recording fake.
 */
import { TERRAIN } from '../lib/tile.ts'
import type { Bus } from './events.ts'
import { EV, type EventMap } from './event-names.ts'
import { AMBIENCE, BANK, type CueDef, type Ground, type SoundCue, type SynthCue } from './sound-bank.ts'
import { soundSettings, type SoundPrefs } from './sound-settings.ts'
import { WebAudioBackend } from './sound-web.ts'

export interface PlayRequest {
  cue: SoundCue
  file?: string
  synth?: SynthCue
  gain: number
  /** Playback rate (1 = as recorded): the pitch variation. */
  rate: number
  speaker?: string
  /** A sound of the world: on the bus that ducks while paused. */
  world: boolean
}

export interface SoundBackend {
  /** Seconds, monotonic. */
  now(): number
  play(req: PlayRequest): void
  /** The master level (0 = silent). */
  setVolume(gain: number): void
  /** The looping ambience (null: none), on the world's bus. */
  ambience(file: string | null): void
  /** The world's bus level (1, or PAUSED_DUCK while paused), ramped so sounds already playing follow. */
  duck(level: number): void
  /** After the first input: make the audio context and load the samples. */
  start(): void
  suspend(): void
  resume(): void
}

/** How far the world's sounds (and the ambience) drop while the game is paused. */
export const PAUSED_DUCK = 0.4
/** A `yields` cue stays quiet when another cue started this recently (s). */
export const YIELD_WINDOW = 0.15

/** The slider is linear; ears aren't. */
export const volumeGain = (prefs: SoundPrefs): number => (prefs.on ? prefs.volume * prefs.volume : 0)

export class SoundDirector {
  private readonly backend: SoundBackend
  private readonly random: () => number
  private prefs: SoundPrefs
  private started = false
  private hidden = false
  private paused = false
  private area: string | null = null
  private lastAny = -Infinity
  private readonly recent = new Map<SoundCue, number[]>()
  private readonly lastVariant = new Map<SoundCue, number>()

  constructor(backend: SoundBackend, prefs: SoundPrefs, random: () => number = Math.random) {
    this.backend = backend
    this.random = random
    this.prefs = prefs
    this.backend.setVolume(volumeGain(prefs))
  }

  /** An input arrived: audio may start (browser autoplay rules), or wake again. */
  start(): void {
    if (this.started) {
      if (!this.hidden) this.backend.resume()
      return
    }
    this.started = true
    if (this.prefs.on) this.backend.start()
    this.syncAmbience()
  }

  setPrefs(prefs: SoundPrefs): void {
    const wasOn = this.prefs.on
    this.prefs = prefs
    if (this.started && prefs.on && !wasOn) this.backend.start()
    this.backend.setVolume(volumeGain(prefs))
    this.syncAmbience()
  }

  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return
    this.hidden = hidden
    if (hidden) this.backend.suspend()
    else if (this.started) this.backend.resume()
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    this.backend.duck(paused ? PAUSED_DUCK : 1)
  }

  /** The area changed: the ambience follows (none delivered yet). */
  setArea(areaId: string): void {
    this.area = areaId
    this.syncAmbience()
  }

  /** Play a cue now, if allowed and under its rate cap. True when it played. */
  play(cue: SoundCue, opts: { speaker?: string } = {}): boolean {
    if (!this.started || this.hidden || volumeGain(this.prefs) <= 0) return false
    const def: CueDef | undefined = BANK[cue]
    if (!def) return false
    const now = this.backend.now()
    if (def.yields && now - this.lastAny < YIELD_WINDOW) return false
    const window = def.window ?? 0.05
    const recent = (this.recent.get(cue) ?? []).filter((t) => now - t < window)
    if (recent.length >= (def.cap ?? 1)) return false
    const files = def.files ?? []
    if (!def.synth && !files.length) return false
    recent.push(now)
    this.recent.set(cue, recent)
    this.lastAny = now
    const rate = 1 + (this.random() * 2 - 1) * (def.jitter ?? 0)
    const base = { cue, gain: def.gain, rate, world: !!def.world }
    if (def.synth) this.backend.play({ ...base, synth: def.synth, speaker: opts.speaker })
    else this.backend.play({ ...base, file: files[this.variant(cue, files.length)] })
    return true
  }

  /** A random variant, never the one played last. */
  private variant(cue: SoundCue, n: number): number {
    if (n === 1) return 0
    const last = this.lastVariant.get(cue)
    let i = Math.floor(this.random() * (last === undefined ? n : n - 1))
    if (last !== undefined && i >= last) i += 1
    this.lastVariant.set(cue, i)
    return i
  }

  private syncAmbience(): void {
    if (!this.started) return
    this.backend.ambience(this.prefs.on && this.area ? (AMBIENCE[this.area] ?? null) : null)
  }
}

// ---------------------------------------------------------------------------
// Events to sounds

const GROUND: Record<number, Ground> = {
  [TERRAIN.path_a]: 'path',
  [TERRAIN.path_b]: 'path',
  [TERRAIN.dirt]: 'path',
  [TERRAIN.sand]: 'path',
  [TERRAIN.bridge]: 'wood',
  [TERRAIN.planks]: 'wood',
  [TERRAIN.planks_dark]: 'wood',
  [TERRAIN.door]: 'wood',
  [TERRAIN.stone_a]: 'stone',
  [TERRAIN.stone_b]: 'stone',
  [TERRAIN.stone_crack]: 'stone',
  [TERRAIN.cobble]: 'stone',
  [TERRAIN.cobble_moss]: 'stone'
}

/** The step for a terrain id: grass (and anything soft) unless it's path, stone or wood. */
export function groundOf(terrain: number): Ground {
  return GROUND[terrain] ?? 'grass'
}

/** Gathering work by action (content/gathering.json). */
export const WORK_CUE: Record<string, SoundCue> = { chop: 'chop', break: 'quarry', dig: 'dig' }

/** Areas you walk into through a door: the rooms (a cottage, a village room). */
const indoors = (area: string) => area.startsWith('in:') || area === 'cottage'

type Handlers = { [K in keyof EventMap]?: (p: EventMap[K]) => void }

/**
 * Listen on `bus` and play through `director`; returns the unsubscribe.
 * Events that already say what happened are mapped here; the rest arrive
 * as `EV.sfx` cues.
 */
export function routeSounds(bus: Bus<EventMap>, director: SoundDirector): () => void {
  let area: string | null = null
  const handlers: Handlers = {
    [EV.sfx]: (p) => director.play(p.cue, { speaker: p.speaker }),
    [EV.footstep]: (p) => director.play(`step-${groundOf(p.terrain)}` as const),
    [EV.work]: (p) => director.play(WORK_CUE[p.action] ?? 'swing'),
    [EV.rolled]: () => director.play('roll'),
    [EV.ability]: (p) => {
      if (p.status === 'cast') director.play('cast')
      else if (p.status === 'no-mana') director.play('fizzle')
    },
    [EV.defeat]: (p) => {
      if (p.phase === 'falling') director.play('defeat')
    },
    [EV.discovery]: () => director.play('discover'),
    [EV.planted]: () => director.play('plant'),
    [EV.toast]: (p) => {
      const kind = p.kind ?? 'info'
      if (kind === 'gain') {
        if (p.gain?.to === 'bag') director.play('pickup')
      } else if (kind === 'error') director.play('fizzle')
      // Glims (earned, spent, or Silas's work): the coins, never a chime as well.
      else if (kind === 'info') director.play(p.icon === 'glim' ? 'glim' : 'notice')
    },
    [EV.homeChanged]: (p) => {
      if (p.reason === 'buy' || p.reason === 'upgrade') director.play('confirm')
    },
    [EV.area]: (p) => {
      if (area !== null && area !== p.areaId) {
        // Up or down a stair is indoors to indoors: no door.
        if (indoors(p.areaId) && !indoors(area)) director.play('door-open')
        else if (indoors(area) && !indoors(p.areaId)) director.play('door-close')
      }
      area = p.areaId
      director.setArea(p.areaId)
    }
  }
  const pairs = Object.entries(handlers) as [keyof EventMap, never][]
  for (const [name, fn] of pairs) bus.on(name, fn)
  return () => {
    for (const [name, fn] of pairs) bus.off(name, fn)
  }
}

// ---------------------------------------------------------------------------
// The live install

let installed = false

/**
 * Start the sound module for this page, once. Under an automated browser
 * (Playwright: `navigator.webdriver`) it stays silent and fetches nothing,
 * so the e2e suite runs as before; the setting still saves.
 */
export function installSound(opts: { bus: Bus<EventMap>; blocked: () => boolean }): void {
  if (installed || typeof window === 'undefined' || navigator.webdriver) return
  installed = true
  const director = new SoundDirector(new WebAudioBackend(), soundSettings.prefs)
  routeSounds(opts.bus, director)
  soundSettings.watch((p) => director.setPrefs(p))
  // Browsers allow audio only after an input; a later input also wakes a
  // context the system interrupted (iOS does, after a call or a lock).
  const onInput = () => director.start()
  for (const t of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(t, onInput, { capture: true, passive: true })
  const onVisible = () => director.setHidden(document.visibilityState === 'hidden')
  document.addEventListener('visibilitychange', onVisible)
  onVisible()
  // The world holds still while a panel or a conversation owns the screen.
  window.setInterval(() => director.setPaused(opts.blocked()), 250)
}
