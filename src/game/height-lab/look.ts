/**
 * Height lab (dev only): the transitions to compare, switched from the dev
 * panel (./LabSection.svelte) while walking the lab. Kept for the tab
 * (sessionStorage), so a reload keeps the choice.
 */

export interface LabLook {
  /** Climbing: lower land fades toward fog, toward sky blue, or not at all. */
  fog: 'fog' | 'sky' | 'none'
  /** Climbing: the camera eases out a little with height. */
  zoom: boolean
  /** Climbing: a soft haze at the screen's edges, stronger the higher you are. */
  haze: boolean
  /** In a cave: a light round the hero (close or wide), or everything dimmed alike. */
  cave: 'lantern' | 'wide' | 'dim'
  /** Shade the tiles by level, show edges and layers (for reading the data). */
  grid: boolean
}

const KEY = 'glimway:height-lab-look'
const DEFAULT: LabLook = { fog: 'fog', zoom: true, haze: true, cave: 'lantern', grid: false }

function read(): LabLook {
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(KEY) : null
    return raw ? { ...DEFAULT, ...(JSON.parse(raw) as Partial<LabLook>) } : { ...DEFAULT }
  } catch {
    return { ...DEFAULT }
  }
}

let look = read()
const listeners = new Set<(l: LabLook) => void>()

export function labLook(): LabLook {
  return look
}

export function setLabLook(change: Partial<LabLook>): void {
  look = { ...look, ...change }
  try {
    sessionStorage.setItem(KEY, JSON.stringify(look))
  } catch {
    /* private mode: the choice lasts the page */
  }
  for (const l of listeners) l(look)
}

/** Follow changes; returns the unsubscribe. */
export function onLabLook(fn: (l: LabLook) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The lab's URL parameter: `?lab=height` starts the lab instead of the world (dev builds only; ../scenes/BootScene.ts). */
export const LAB_PARAM = 'height'

export function inLab(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('lab') === LAB_PARAM
}

/** The page again with the lab on or off (other parameters, such as perf=1, kept). */
export function labUrl(on: boolean): string {
  const u = new URL(location.href)
  if (on) u.searchParams.set('lab', LAB_PARAM)
  else u.searchParams.delete('lab')
  return u.toString()
}
