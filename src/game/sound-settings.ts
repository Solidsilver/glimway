/**
 * The sound preference, per device (localStorage): on or off, and a volume.
 * Plain TypeScript (no Svelte), so the sound module and Node tests share it;
 * the Menu reads and writes it through `soundSettings`.
 */
import { readJson, writeJson } from '../lib/local-json.ts'

export interface SoundPrefs {
  on: boolean
  /** 0..1, the Menu's slider. */
  volume: number
}

export const SOUND_KEY = 'glimway:sound'
export const SOUND_DEFAULTS: SoundPrefs = { on: true, volume: 0.6 }

export function parseSoundPrefs(stored: unknown): SoundPrefs {
  const s = (stored ?? {}) as Partial<SoundPrefs>
  const volume = typeof s.volume === 'number' && Number.isFinite(s.volume) ? Math.min(1, Math.max(0, s.volume)) : SOUND_DEFAULTS.volume
  return { on: typeof s.on === 'boolean' ? s.on : SOUND_DEFAULTS.on, volume }
}

type Listener = (prefs: SoundPrefs) => void

class SoundSettings {
  private value: SoundPrefs = readJson(SOUND_KEY, parseSoundPrefs, { ...SOUND_DEFAULTS })
  private readonly listeners = new Set<Listener>()

  get prefs(): SoundPrefs {
    return this.value
  }

  set(change: Partial<SoundPrefs>): void {
    this.value = parseSoundPrefs({ ...this.value, ...change })
    // Refused by storage: kept for this visit only.
    writeJson(SOUND_KEY, this.value)
    for (const l of this.listeners) l(this.value)
  }

  /** Called now and on every change; returns the unsubscribe. */
  watch(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.value)
    return () => this.listeners.delete(fn)
  }

  /** Read storage again (tests). */
  reload(): void {
    this.value = readJson(SOUND_KEY, parseSoundPrefs, { ...SOUND_DEFAULTS })
  }
}

export const soundSettings = new SoundSettings()
