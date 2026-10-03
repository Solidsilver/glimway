/**
 * Tiny procedural sound kit (Web Audio, no asset files, no network).
 *
 * Every cue is a few oscillator notes with short envelopes — cozy chiptune
 * blips rather than samples. The context is created lazily on the first
 * user gesture (browsers block audio before that) and the mute preference is
 * a per-device convenience kept in localStorage.
 */

export type SfxCue =
  | 'click'
  | 'open'
  | 'close'
  | 'blip'
  | 'swing'
  | 'hit'
  | 'crit'
  | 'hurt'
  | 'cast'
  | 'fizzle'
  | 'pop'
  | 'quest'
  | 'discover'
  | 'lantern'
  | 'defeat'
  | 'step-area'
  | 'ember'

const MUTE_KEY = 'fingersnap:muted'

let ctx: AudioContext | null = null
let master: GainNode | null = null
let muted = readMuted()
const listeners = new Set<(muted: boolean) => void>()

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

function ensureContext(): AudioContext | null {
  if (ctx) return ctx
  const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
  if (!Ctor) return null
  try {
    ctx = new Ctor()
    master = ctx.createGain()
    master.gain.value = muted ? 0 : 0.22
    master.connect(ctx.destination)
  } catch {
    ctx = null
  }
  return ctx
}

/** Call from a user gesture (title button) so later cues can play. */
export function unlockAudio(): void {
  const c = ensureContext()
  if (c && c.state === 'suspended') void c.resume()
}

export function isMuted(): boolean {
  return muted
}

export function setMuted(value: boolean): void {
  muted = value
  try {
    localStorage.setItem(MUTE_KEY, value ? '1' : '0')
  } catch {
    /* storage unavailable: preference lasts for this tab only */
  }
  if (master && ctx) master.gain.setTargetAtTime(value ? 0 : 0.22, ctx.currentTime, 0.02)
  for (const l of listeners) l(value)
}

export function onMuteChange(fn: (muted: boolean) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

interface Note {
  freq: number
  /** Start offset (s). */
  at?: number
  dur: number
  type?: OscillatorType
  vol?: number
  /** Pitch glide target (Hz). */
  slide?: number
}

function playNotes(notes: Note[]): void {
  if (muted) return
  const c = ensureContext()
  if (!c || !master || c.state !== 'running') return
  const now = c.currentTime
  for (const n of notes) {
    const t0 = now + (n.at ?? 0)
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = n.type ?? 'square'
    osc.frequency.setValueAtTime(n.freq, t0)
    if (n.slide) osc.frequency.exponentialRampToValueAtTime(n.slide, t0 + n.dur)
    const v = n.vol ?? 0.5
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(v, t0 + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur)
    osc.connect(gain)
    gain.connect(master)
    osc.start(t0)
    osc.stop(t0 + n.dur + 0.02)
  }
}

function noiseBurst(dur: number, vol: number, filterFreq: number): void {
  if (muted) return
  const c = ensureContext()
  if (!c || !master || c.state !== 'running') return
  const len = Math.floor(c.sampleRate * dur)
  const buf = c.createBuffer(1, len, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len)
  const src = c.createBufferSource()
  src.buffer = buf
  const filter = c.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = filterFreq
  const gain = c.createGain()
  gain.gain.value = vol
  src.connect(filter)
  filter.connect(gain)
  gain.connect(master)
  src.start()
}

/** Per-speaker voice pitch for dialogue blips. */
const VOICE: Record<string, number> = {
  Mara: 520,
  Pip: 740,
  Orrin: 300
}

let lastBlip = 0

/** Dialogue typing blip — throttled so fast text stays a soft patter. */
export function voiceBlip(speaker: string): void {
  const now = performance.now()
  if (now - lastBlip < 55) return
  lastBlip = now
  const base = VOICE[speaker] ?? 420
  playNotes([{ freq: base * (0.94 + Math.random() * 0.12), dur: 0.045, type: 'triangle', vol: 0.18 }])
}

export function sfx(cue: SfxCue): void {
  switch (cue) {
    case 'click':
      return playNotes([{ freq: 880, dur: 0.04, type: 'square', vol: 0.12 }])
    case 'open':
      return playNotes([
        { freq: 523, dur: 0.06, type: 'triangle', vol: 0.25 },
        { freq: 784, at: 0.05, dur: 0.08, type: 'triangle', vol: 0.22 }
      ])
    case 'close':
      return playNotes([
        { freq: 784, dur: 0.05, type: 'triangle', vol: 0.2 },
        { freq: 523, at: 0.04, dur: 0.07, type: 'triangle', vol: 0.18 }
      ])
    case 'blip':
      return playNotes([{ freq: 660, dur: 0.04, type: 'triangle', vol: 0.15 }])
    case 'swing':
      return noiseBurst(0.08, 0.35, 2400)
    case 'hit':
      noiseBurst(0.06, 0.5, 900)
      return playNotes([{ freq: 220, dur: 0.08, type: 'square', vol: 0.25, slide: 110 }])
    case 'crit':
      noiseBurst(0.09, 0.6, 1200)
      return playNotes([
        { freq: 330, dur: 0.07, type: 'square', vol: 0.3, slide: 160 },
        { freq: 990, at: 0.03, dur: 0.12, type: 'triangle', vol: 0.25 }
      ])
    case 'hurt':
      return playNotes([{ freq: 300, dur: 0.16, type: 'sawtooth', vol: 0.25, slide: 120 }])
    case 'cast':
      return playNotes([
        { freq: 660, dur: 0.07, type: 'triangle', vol: 0.25 },
        { freq: 990, at: 0.05, dur: 0.07, type: 'triangle', vol: 0.22 },
        { freq: 1320, at: 0.1, dur: 0.12, type: 'sine', vol: 0.2 }
      ])
    case 'fizzle':
      return playNotes([{ freq: 260, dur: 0.12, type: 'square', vol: 0.12, slide: 180 }])
    case 'pop':
      return playNotes([
        { freq: 520, dur: 0.05, type: 'square', vol: 0.2, slide: 1040 },
        { freq: 1560, at: 0.05, dur: 0.1, type: 'triangle', vol: 0.15 }
      ])
    case 'quest':
      return playNotes([
        { freq: 523, dur: 0.12, type: 'triangle', vol: 0.3 },
        { freq: 659, at: 0.1, dur: 0.12, type: 'triangle', vol: 0.3 },
        { freq: 784, at: 0.2, dur: 0.12, type: 'triangle', vol: 0.3 },
        { freq: 1047, at: 0.3, dur: 0.3, type: 'triangle', vol: 0.28 }
      ])
    case 'ember':
      // A small warm crackle-chime: embers landing in your pocket.
      return playNotes([
        { freq: 660, dur: 0.06, type: 'triangle', vol: 0.16 },
        { freq: 990, at: 0.05, dur: 0.07, type: 'triangle', vol: 0.15 },
        { freq: 1320, at: 0.1, dur: 0.14, type: 'sine', vol: 0.13 }
      ])
    case 'discover':
      return playNotes([
        { freq: 784, dur: 0.08, type: 'triangle', vol: 0.22 },
        { freq: 1175, at: 0.07, dur: 0.16, type: 'sine', vol: 0.2 }
      ])
    case 'lantern':
      return playNotes([
        { freq: 392, dur: 0.5, type: 'triangle', vol: 0.22 },
        { freq: 523, at: 0.15, dur: 0.5, type: 'triangle', vol: 0.22 },
        { freq: 659, at: 0.3, dur: 0.6, type: 'triangle', vol: 0.22 },
        { freq: 784, at: 0.45, dur: 0.9, type: 'sine', vol: 0.24 },
        { freq: 1568, at: 0.6, dur: 0.9, type: 'sine', vol: 0.1 }
      ])
    case 'defeat':
      return playNotes([
        { freq: 392, dur: 0.22, type: 'triangle', vol: 0.25 },
        { freq: 330, at: 0.2, dur: 0.22, type: 'triangle', vol: 0.25 },
        { freq: 262, at: 0.4, dur: 0.5, type: 'triangle', vol: 0.25 }
      ])
    case 'step-area':
      return playNotes([
        { freq: 392, dur: 0.1, type: 'triangle', vol: 0.15 },
        { freq: 587, at: 0.08, dur: 0.18, type: 'triangle', vol: 0.15 }
      ])
  }
}

/** Shared reduced-motion check for shakes, hit-stop and big tweens. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
