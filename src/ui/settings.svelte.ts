/**
 * Player preferences kept on this device (localStorage). Every read and
 * write is guarded: a private window or blocked storage just means the
 * defaults, never an error. Add a preference by giving it a default in
 * DEFAULTS; old stored records pick the new default up on load.
 */
import { readJson, writeJson } from '../lib/local-json'

/** How the hero walks on a touch screen. */
export type StickMode = 'fixed' | 'floating' | 'hold'

interface Settings {
  /** fixed: the joystick in the corner. floating: it appears under the thumb. hold: walk toward the finger. */
  stick: StickMode
  /** Page loads played with the floating stick (its resting hint shows for the first few). */
  floatingSessions: number
}

// `fingersnap:` is the game's old name, kept so saved settings load.
const KEY = 'fingersnap:settings'

const DEFAULTS: Settings = {
  stick: 'fixed',
  floatingSessions: 0
}

function parse(stored: unknown): Settings {
  const out = { ...DEFAULTS, ...(stored as Partial<Settings>) }
  if (!['fixed', 'floating', 'hold'].includes(out.stick)) out.stick = DEFAULTS.stick
  if (typeof out.floatingSessions !== 'number' || !Number.isFinite(out.floatingSessions)) out.floatingSessions = 0
  return out
}

const load = (): Settings => readJson(KEY, parse, { ...DEFAULTS })

class SettingsStore {
  value = $state<Settings>(load())

  get stick(): StickMode {
    return this.value.stick
  }

  set<K extends keyof Settings>(key: K, v: Settings[K]): void {
    this.value = { ...this.value, [key]: v }
    // Refused by storage: kept for this visit only.
    writeJson(KEY, this.value)
  }
}

export const settings = new SettingsStore()

let floatingCounted = false

/**
 * Count this page load as one played with the floating stick (its resting
 * hint shows for the first few). Once per load: the controls unmount and
 * mount again around placement, which isn't a new visit.
 */
export function noteFloatingVisit(): void {
  if (floatingCounted || settings.stick !== 'floating') return
  floatingCounted = true
  settings.set('floatingSessions', settings.value.floatingSessions + 1)
}
