/**
 * The Web Audio side of the sound module (src/game/sound.ts): one
 * AudioContext, the Kenney samples (fetched and decoded once, after the
 * first input), the little procedural voices kept for melodic stings and
 * dialogue, and an ambience loop slot. It plays what the director asks and
 * decides nothing.
 *
 * Two buses under the master: the interface's, and the world's (effects of
 * the world and the ambience), which ramps down while the game is paused,
 * sounds already playing included.
 */
import { SOUND_BASE, sampleFiles, type SynthCue } from './sound-bank.ts'
import type { PlayRequest, SoundBackend } from './sound.ts'

/** The procedural voices sit under the samples (they were tuned for a quieter master). */
const SYNTH_LEVEL = 0.6
/**
 * A cue asked for before its sample is decoded (the first input's own
 * sound, a quick action while the set loads) or before the context runs
 * plays once it can, if this is still soon after (ms). Later than that it
 * would sound out of context, so it is dropped.
 */
export const LATE_MS = 300

interface Pending {
  req: PlayRequest
  /** When it was asked for (ms, the clock). */
  at: number
}

export interface WebAudioOptions {
  /** Milliseconds, monotonic (tests). */
  clock?: () => number
  /** The bytes of a sound file (tests); default fetch. */
  fetchFile?: (url: string) => Promise<ArrayBuffer>
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.arrayBuffer()
}

export class WebAudioBackend implements SoundBackend {
  private readonly clock: () => number
  private readonly fetchFile: (url: string) => Promise<ArrayBuffer>
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private uiBus: GainNode | null = null
  private worldBus: GainNode | null = null
  private readonly buffers = new Map<string, AudioBuffer>()
  private readonly loads = new Map<string, Promise<AudioBuffer | null>>()
  private readonly failed = new Set<string>()
  private pending: Pending[] = []
  private volume = 0
  private duckLevel = 1
  private loop: { file: string; src: AudioBufferSourceNode; gain: GainNode } | null = null
  private wantedLoop: string | null = null

  constructor(opts: WebAudioOptions = {}) {
    this.clock = opts.clock ?? (() => performance.now())
    this.fetchFile = opts.fetchFile ?? fetchBytes
  }

  now(): number {
    return this.ctx?.currentTime ?? this.clock() / 1000
  }

  /** From a user gesture: make (or wake) the context and fetch the samples once. */
  start(): void {
    const c = this.context()
    if (!c) return
    if (c.state !== 'running') void c.resume().catch(() => undefined)
    for (const f of sampleFiles()) void this.fetchBuffer(c, f)
  }

  /** Tab hidden: stop the clock entirely; it resumes on return (or the next input). */
  suspend(): void {
    if (this.ctx?.state === 'running') void this.ctx.suspend().catch(() => undefined)
  }

  resume(): void {
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined)
  }

  setVolume(gain: number): void {
    this.volume = gain
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.05)
  }

  duck(level: number): void {
    this.duckLevel = level
    if (this.worldBus && this.ctx) this.worldBus.gain.setTargetAtTime(level, this.ctx.currentTime, 0.08)
  }

  play(req: PlayRequest): void {
    const c = this.ctx
    if (!c) return
    this.pending.push({ req, at: this.clock() })
    if (req.file) void this.fetchBuffer(c, req.file)
    this.flush()
  }

  ambience(file: string | null): void {
    this.wantedLoop = file
    const c = this.ctx
    if (!c || !this.worldBus || this.loop?.file === file) return
    const old = this.loop
    this.loop = null
    if (old) {
      old.gain.gain.setTargetAtTime(0, c.currentTime, 0.6)
      old.src.stop(c.currentTime + 3)
    }
    if (!file) return
    void this.fetchBuffer(c, file).then((buf) => {
      if (!buf || this.wantedLoop !== file || this.loop) return
      const src = c.createBufferSource()
      src.buffer = buf
      src.loop = true
      const gain = c.createGain()
      gain.gain.value = 0
      gain.gain.setTargetAtTime(1, c.currentTime, 0.8)
      src.connect(gain).connect(this.worldBus!)
      src.start()
      this.loop = { file, src, gain }
    })
  }

  /** Play what can play now; keep what waits on its sample or the context; drop what is too late. */
  private flush(): void {
    const c = this.ctx
    if (!c) return
    const now = this.clock()
    const waiting: Pending[] = []
    for (const p of this.pending) {
      const file = p.req.file
      if (now - p.at > LATE_MS || (file && this.failed.has(file))) continue
      const buf = file ? this.buffers.get(file) : undefined
      if (c.state !== 'running' || (file && !buf)) waiting.push(p)
      else this.sound(c, p.req, buf)
    }
    this.pending = waiting
  }

  private sound(c: AudioContext, req: PlayRequest, buf: AudioBuffer | undefined): void {
    const gain = c.createGain()
    gain.connect(req.world ? this.worldBus! : this.uiBus!)
    if (req.synth) {
      gain.gain.value = req.gain * SYNTH_LEVEL
      synth(c, gain, req.synth, req.rate, req.speaker)
      return
    }
    if (!buf) return
    gain.gain.value = req.gain
    const src = c.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = req.rate
    src.connect(gain)
    src.start()
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
    const Ctor = w.AudioContext ?? w.webkitAudioContext
    if (!Ctor) return null
    try {
      const c = new Ctor()
      this.master = c.createGain()
      this.master.gain.value = this.volume
      this.master.connect(c.destination)
      this.uiBus = c.createGain()
      this.uiBus.connect(this.master)
      this.worldBus = c.createGain()
      this.worldBus.gain.value = this.duckLevel
      this.worldBus.connect(this.master)
      // Cues waiting on a resume play when it lands (or are dropped as late).
      c.onstatechange = () => this.flush()
      this.ctx = c
      if (this.wantedLoop) this.ambience(this.wantedLoop)
    } catch {
      this.ctx = null
    }
    return this.ctx
  }

  /** One fetch and decode per file, shared by every caller; failures are remembered and stay silent. */
  private fetchBuffer(c: AudioContext, file: string): Promise<AudioBuffer | null> {
    let load = this.loads.get(file)
    if (!load) {
      load = (async () => {
        try {
          const data = await this.fetchFile(SOUND_BASE + file)
          // Older Safari only has the callback form.
          const buf = await new Promise<AudioBuffer>((resolve, reject) => {
            const p = c.decodeAudioData(data, resolve, reject)
            if (p) p.then(resolve, reject)
          })
          this.buffers.set(file, buf)
          return buf
        } catch {
          this.failed.add(file) // a missing sound is silence, never an error
          return null
        } finally {
          this.flush()
        }
      })()
      this.loads.set(file, load)
    }
    return load
  }
}

// ---------------------------------------------------------------------------
// Procedural voices: a few oscillator notes with short envelopes. Kept for
// the tuned stings (quest, lantern, the warden) and the dialogue patter,
// which no sample pack voices as well.

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

function notes(c: AudioContext, out: AudioNode, list: Note[], rate: number): void {
  const now = c.currentTime
  for (const n of list) {
    const t0 = now + (n.at ?? 0)
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = n.type ?? 'square'
    osc.frequency.setValueAtTime(n.freq * rate, t0)
    if (n.slide) osc.frequency.exponentialRampToValueAtTime(n.slide * rate, t0 + n.dur)
    const v = n.vol ?? 0.5
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(v, t0 + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur)
    osc.connect(gain).connect(out)
    osc.start(t0)
    osc.stop(t0 + n.dur + 0.02)
  }
}

function noise(c: AudioContext, out: AudioNode, dur: number, vol: number, filterFreq: number): void {
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
  src.connect(filter).connect(gain).connect(out)
  src.start()
}

/** Per-speaker voice pitch for dialogue blips. */
const VOICE: Record<string, number> = {
  Mara: 520,
  Pip: 740,
  Orrin: 300
}

function synth(c: AudioContext, out: AudioNode, cue: SynthCue, rate: number, speaker?: string): void {
  switch (cue) {
    case 'voice':
      return notes(c, out, [{ freq: VOICE[speaker ?? ''] ?? 420, dur: 0.045, type: 'triangle', vol: 0.18 }], rate)
    case 'falter':
      // The warden's heart-lamp flickers: a soft, wavering fall.
      return notes(c, out, [
        { freq: 587, dur: 0.12, type: 'triangle', vol: 0.2 },
        { freq: 523, at: 0.1, dur: 0.12, type: 'triangle', vol: 0.18 },
        { freq: 440, at: 0.2, dur: 0.22, type: 'sine', vol: 0.16 }
      ], rate)
    case 'settle':
      // Stone coming to rest: low, warm, unhurried.
      noise(c, out, 0.18, 0.2, 500)
      return notes(c, out, [
        { freq: 330, dur: 0.4, type: 'triangle', vol: 0.2 },
        { freq: 262, at: 0.3, dur: 0.5, type: 'triangle', vol: 0.2 },
        { freq: 196, at: 0.65, dur: 0.9, type: 'sine', vol: 0.2 }
      ], rate)
    case 'blip':
      return notes(c, out, [{ freq: 660, dur: 0.04, type: 'triangle', vol: 0.15 }], rate)
    case 'cast':
      return notes(c, out, [
        { freq: 660, dur: 0.07, type: 'triangle', vol: 0.25 },
        { freq: 990, at: 0.05, dur: 0.07, type: 'triangle', vol: 0.22 },
        { freq: 1320, at: 0.1, dur: 0.12, type: 'sine', vol: 0.2 }
      ], rate)
    case 'pop':
      return notes(c, out, [
        { freq: 520, dur: 0.05, type: 'square', vol: 0.2, slide: 1040 },
        { freq: 1560, at: 0.05, dur: 0.1, type: 'triangle', vol: 0.15 }
      ], rate)
    case 'quest':
      return notes(c, out, [
        { freq: 523, dur: 0.12, type: 'triangle', vol: 0.3 },
        { freq: 659, at: 0.1, dur: 0.12, type: 'triangle', vol: 0.3 },
        { freq: 784, at: 0.2, dur: 0.12, type: 'triangle', vol: 0.3 },
        { freq: 1047, at: 0.3, dur: 0.3, type: 'triangle', vol: 0.28 }
      ], rate)
    case 'windup':
      // A short rising warble: something is about to lunge.
      return notes(c, out, [
        { freq: 220, dur: 0.08, type: 'square', vol: 0.07 },
        { freq: 300, at: 0.08, dur: 0.08, type: 'square', vol: 0.07 },
        { freq: 400, at: 0.16, dur: 0.1, type: 'square', vol: 0.07 }
      ], rate)
    case 'lantern':
      return notes(c, out, [
        { freq: 392, dur: 0.5, type: 'triangle', vol: 0.22 },
        { freq: 523, at: 0.15, dur: 0.5, type: 'triangle', vol: 0.22 },
        { freq: 659, at: 0.3, dur: 0.6, type: 'triangle', vol: 0.22 },
        { freq: 784, at: 0.45, dur: 0.9, type: 'sine', vol: 0.24 },
        { freq: 1568, at: 0.6, dur: 0.9, type: 'sine', vol: 0.1 }
      ], rate)
    case 'defeat':
      return notes(c, out, [
        { freq: 392, dur: 0.22, type: 'triangle', vol: 0.25 },
        { freq: 330, at: 0.2, dur: 0.22, type: 'triangle', vol: 0.25 },
        { freq: 262, at: 0.4, dur: 0.5, type: 'triangle', vol: 0.25 }
      ], rate)
    case 'step-area':
      return notes(c, out, [
        { freq: 392, dur: 0.1, type: 'triangle', vol: 0.15 },
        { freq: 587, at: 0.08, dur: 0.18, type: 'triangle', vol: 0.15 }
      ], rate)
  }
}
