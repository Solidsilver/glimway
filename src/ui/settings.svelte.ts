/**
 * Player preferences kept on this device (localStorage). Every read and
 * write is guarded: a private window or blocked storage just means the
 * defaults, never an error. Add a preference by giving it a default in
 * DEFAULTS; old stored records pick the new default up on load.
 */

/** How the hero walks on a touch screen. */
export type StickMode = 'fixed' | 'floating' | 'hold'

export interface Settings {
  /** fixed: the joystick in the corner. floating: it appears under the thumb. hold: walk toward the finger. */
  stick: StickMode
  /** Page loads played with the floating stick (its resting hint shows for the first few). */
  floatingSessions: number
}

const KEY = 'fingersnap:settings'

const DEFAULTS: Settings = {
  stick: 'fixed',
  floatingSessions: 0
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<Settings>
    const out = { ...DEFAULTS, ...parsed }
    if (!['fixed', 'floating', 'hold'].includes(out.stick)) out.stick = DEFAULTS.stick
    if (typeof out.floatingSessions !== 'number' || !Number.isFinite(out.floatingSessions)) out.floatingSessions = 0
    return out
  } catch {
    return { ...DEFAULTS }
  }
}

class SettingsStore {
  value = $state<Settings>(load())

  get stick(): StickMode {
    return this.value.stick
  }

  set<K extends keyof Settings>(key: K, v: Settings[K]): void {
    this.value = { ...this.value, [key]: v }
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value))
    } catch {
      /* kept for this visit only */
    }
  }
}

export const settings = new SettingsStore()
