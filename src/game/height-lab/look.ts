/**
 * Height lab (dev only): the transitions to compare, switched from the dev
 * panel (./LabSection.svelte) while walking the lab. Kept for the tab
 * (sessionStorage), so a reload keeps the choice.
 */
import type { AreaName } from './area.ts'
import type { WayIn } from './light.ts'

export interface LabLook {
  /** Which area to walk (switching rebuilds the scene). */
  area: AreaName
  /** Levels above and below yours fade toward fog, toward sky blue, or not at all. */
  fog: 'fog' | 'sky' | 'none'
  /** How much a level of difference fades (./scene.ts FOG_PER_LEVEL). */
  fogStrength: 'light' | 'medium' | 'strong'
  /** Underground, how much darker levels above and below yours get at most (two levels off and more): 0–0.9, 0 off. */
  darkness: number
  /** The cave's floors: as each place is (cut stone in the way in, rough rock deeper), or all cut, or all rough (switching repaints). */
  caveStyle: 'mixed' | 'built' | 'rough'
  /** Climbing: the camera eases out a little with height. */
  zoom: boolean
  /** Climbing: a soft haze at the screen's edges, stronger the higher you are. */
  haze: boolean
  /** In a cave: the hero's own light, close or wide, or none (the cave's own light only). */
  cave: 'lantern' | 'wide' | 'dim'
  /** Walked tiles from a mouth to where daylight is gone (switching rebuilds the light). */
  skyTiles: number
  /** Walked tiles from the arch over which the surface's view crossfades to the cave's. */
  crossfade: number
  /** How the cave's view comes in (./light.ts WayIn). */
  way: WayIn
  /** Shade the tiles by level, show edges and layers (for reading the data). */
  grid: boolean
  /** The generated area: which access strategy's terrain to walk (switching rebuilds it where you stand). */
  strategy: 'region' | 'chunk'
  /** The generated area: stranded floor magenta, chunk lines (switching repaints). */
  walkOverlay: boolean
}

const KEY = 'glimway:height-lab-look'
const DEFAULT: LabLook = { area: 'shoulder', fog: 'fog', fogStrength: 'medium', darkness: 0.6, caveStyle: 'mixed', zoom: true, haze: true, cave: 'lantern', skyTiles: 6, crossfade: 3, way: 'blend', grid: false, strategy: 'region', walkOverlay: false }

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

/** Fog a level of difference adds (past the first third of a level), and the most it hides. */
export const FOG_PER_LEVEL: Record<LabLook['fogStrength'], { k: number; max: number }> = {
  light: { k: 0.25, max: 0.55 },
  medium: { k: 0.42, max: 0.72 },
  strong: { k: 0.6, max: 0.85 }
}

/** How faded something `dz` levels above or below you is (0 clear): the same either way. */
export function fogFor(dz: number, strength: LabLook['fogStrength']): number {
  const f = FOG_PER_LEVEL[strength]
  return Math.max(0, Math.min(f.max, (Math.abs(dz) - 0.3) * f.k))
}
