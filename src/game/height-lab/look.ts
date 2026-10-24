/**
 * Height lab (dev only): the transitions to compare, switched from the dev
 * panel (./LabSection.svelte) while walking the lab. Kept for the tab
 * (sessionStorage), so a reload keeps the choice; what's read back is
 * checked field by field (migrateLook), so settings saved by an older lab
 * still load.
 */
import type { AreaName } from './area.ts'
import type { ContourDetail, FacingShade, LiftPx, SlopeStyle, SlopesLook } from './slopes.ts'
import type { WayIn } from './light.ts'
import type { EdgeSettings } from './edges.ts'

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
  /** The slopes area: shading by facing, none, restrained (palette shifts) or the round-1 strength (./slopes-paint.ts; switching repaints). */
  slopeFacing: FacingShade
  /** The slopes area: contour lines, none, sparse (broken, every level) or the round-1 half-level lines. */
  slopeContours: ContourDetail
  /** The slopes area: the slope drawn as small terraces. */
  slopeTerraces: boolean
  /** The slopes area: how far the ground is drawn north as it rises, px a level (0: not at all; 48: the round-1 true ¾ lift). */
  slopeLift: LiftPx
  /** Speed cut at the walking limit, percent, 0–80; linear in the uphill component. */
  slopeUphill: number
  /** Speed gain at the downhill walking limit, percent, 0–20. */
  slopeDownhill: number
  /** Actual-speed cadence, a small directional lean and occasional steep-foot scuffs. */
  slopeGait: boolean
  /** Enable the separate sun layer and silhouette shadows. */
  sunlight: boolean
  /** Direct sun intensity, 0–2; zero keeps the ambient fill. */
  sunStrength: number
  /** Dawn=0, noon=.5, dusk=1. */
  sunTime: number
  /** Follow the game/server clock, including the dev offset. */
  sunClock: boolean
  /** Sprite cast shadows: 2d proxies cast onto the ground, or 2c sheared silhouettes. */
  spriteShadows: 'proxy' | 'silhouette'
  /** 2e edge shading (./edges.ts): strength 0–1 (0 off), band width px, scaled by the drop, the smallest step that counts (levels), a light rim on the lip. */
  edgeShade: number
  edgeWidth: number
  edgeScale: boolean
  edgeThreshold: number
  edgeRim: boolean
}

/** 2e edge shading's defaults (./edges.ts EDGE_DEFAULT): reset keeps them. */
export const EDGE_LOOK: Pick<LabLook, 'edgeShade' | 'edgeWidth' | 'edgeScale' | 'edgeThreshold' | 'edgeRim'> = { edgeShade: 0.6, edgeWidth: 4, edgeScale: true, edgeThreshold: 0.5, edgeRim: true }

/** The look's edge settings as ./edges.ts takes them. */
export function edgeSettings(l: Pick<LabLook, 'edgeShade' | 'edgeWidth' | 'edgeScale' | 'edgeThreshold' | 'edgeRim'>): EdgeSettings {
  return { strength: l.edgeShade, width: l.edgeWidth, scale: l.edgeScale, threshold: l.edgeThreshold, rim: l.edgeRim }
}

/** Preset drawing controls. Sunlight, strength and time update only the light layer. */
export const SLOPE_KEYS = ['slopeFacing', 'slopeContours', 'slopeTerraces', 'slopeLift'] as const
export type SlopeLook = Pick<LabLook, (typeof SLOPE_KEYS)[number]>

/** The comparison presets (slopes-lab-recommendations.md §3): drawing only; fog, zoom, haze and the uphill slowdown stay as they are. */
export type SlopePreset = 'baseline' | 'sparse' | 'terraces' | 'moderate' | 'full'
export const SLOPE_PRESETS: Record<SlopePreset, { name: string; look: SlopeLook }> = {
  baseline: { name: 'Shading baseline', look: { slopeFacing: 'restrained', slopeContours: 'off', slopeTerraces: false, slopeLift: 0 } },
  sparse: { name: 'Sparse contours', look: { slopeFacing: 'restrained', slopeContours: 'sparse', slopeTerraces: false, slopeLift: 0 } },
  terraces: { name: 'Small terraces', look: { slopeFacing: 'restrained', slopeContours: 'off', slopeTerraces: true, slopeLift: 0 } },
  moderate: { name: 'Moderate lift', look: { slopeFacing: 'restrained', slopeContours: 'off', slopeTerraces: false, slopeLift: 24 } },
  full: { name: 'Full lift reference', look: { slopeFacing: 'current', slopeContours: 'off', slopeTerraces: false, slopeLift: 48 } }
}

/** The preset the slopes settings are exactly, if any. */
export function slopePresetOf(l: SlopeLook): SlopePreset | null {
  for (const [name, p] of Object.entries(SLOPE_PRESETS) as [SlopePreset, (typeof SLOPE_PRESETS)[SlopePreset]][]) if (SLOPE_KEYS.every((k) => p.look[k] === l[k])) return name
  return null
}

/** "Reset": the Shading baseline, 60% uphill, 6% downhill, noon, gait and sunlight on. */
export const SLOPE_RESET: Partial<LabLook> = { ...SLOPE_PRESETS.baseline.look, slopeUphill: 60, slopeDownhill: 6, slopeGait: true, sunlight: true, sunStrength: 1, sunTime: 0.5, sunClock: false, spriteShadows: 'proxy', ...EDGE_LOOK }

/** Just the slopes area's drawing settings. */
export function slopeSettings(l: SlopeLook & Partial<Pick<LabLook, 'sunlight' | 'sunStrength'>>): SlopeLook & Partial<Pick<LabLook, 'sunlight' | 'sunStrength'>> {
  return { sunlight: l.sunlight, sunStrength: l.sunStrength, slopeFacing: l.slopeFacing, slopeContours: l.slopeContours, slopeTerraces: l.slopeTerraces, slopeLift: l.slopeLift }
}

/** The slopes settings as the drawing code takes them (./slopes.ts buildSlopes). */
export function slopesLook(l: SlopeLook & Partial<Pick<LabLook, 'sunlight' | 'sunStrength'>>): SlopesLook {
  return { sunlight: l.sunlight, sunStrength: l.sunStrength, facing: l.slopeFacing, contours: l.slopeContours, terraces: l.slopeTerraces, lift: l.slopeLift }
}

/**
 * Round 1's four styles, as settings (the "Slopes, drawn as" row picks one):
 * each the one treatment, facing shade kept (shading by facing turns it on).
 */
export function styleSettings(style: SlopeStyle, l: SlopeLook): SlopeLook {
  const facing = l.slopeFacing
  if (style === 'shade') return { slopeFacing: facing === 'off' ? 'current' : facing, slopeContours: 'off', slopeTerraces: false, slopeLift: 0 }
  if (style === 'contours') return { slopeFacing: facing, slopeContours: 'current', slopeTerraces: false, slopeLift: 0 }
  if (style === 'terraces') return { slopeFacing: facing, slopeContours: 'off', slopeTerraces: true, slopeLift: 0 }
  return { slopeFacing: facing, slopeContours: 'off', slopeTerraces: false, slopeLift: 48 }
}

/** Which of round 1's styles the settings are, if one (the row's pressed button). */
export function styleOf(l: SlopeLook): SlopeStyle | null {
  for (const s of ['shade', 'contours', 'terraces', 'lift'] as const) {
    const t = styleSettings(s, l)
    if (SLOPE_KEYS.every((k) => t[k] === l[k])) return s
  }
  return null
}

const KEY = 'glimway:height-lab-look'
const DEFAULT: LabLook = {
  area: 'shoulder',
  fog: 'fog',
  fogStrength: 'medium',
  darkness: 0.6,
  caveStyle: 'mixed',
  zoom: true,
  haze: true,
  cave: 'lantern',
  skyTiles: 6,
  crossfade: 3,
  way: 'blend',
  grid: false,
  strategy: 'region',
  walkOverlay: false,
  ...SLOPE_PRESETS.baseline.look,
  slopeUphill: 60, slopeDownhill: 6, slopeGait: true, sunlight: true, sunStrength: 1, sunTime: 0.5, sunClock: false, spriteShadows: 'proxy',
  ...EDGE_LOOK
}

/** Each setting's allowed values (a range for the sliders). */
const ALLOWED: { [K in keyof LabLook]: readonly LabLook[K][] | { min: number; max: number } } = {
  area: ['shoulder', 'mountain', 'walk', 'slopes'],
  fog: ['fog', 'sky', 'none'],
  fogStrength: ['light', 'medium', 'strong'],
  darkness: { min: 0, max: 0.9 },
  caveStyle: ['mixed', 'built', 'rough'],
  zoom: [true, false],
  haze: [true, false],
  cave: ['lantern', 'wide', 'dim'],
  skyTiles: [3, 6, 10],
  crossfade: { min: 1, max: 4 },
  way: ['blend', 'eased', 'stages', 'iris'],
  grid: [true, false],
  strategy: ['region', 'chunk'],
  walkOverlay: [true, false],
  slopeFacing: ['off', 'restrained', 'current'],
  slopeContours: ['off', 'sparse', 'current'],
  slopeTerraces: [true, false],
  slopeLift: [0, 24, 48],
  slopeUphill: { min: 0, max: 80 },
  slopeDownhill: { min: 0, max: 20 },
  slopeGait: [false, true],
  sunlight: [false, true],
  sunStrength: { min: 0, max: 2 },
  sunTime: { min: 0, max: 1 },
  sunClock: [true, false],
  spriteShadows: ['proxy', 'silhouette'],
  edgeShade: { min: 0, max: 1 },
  edgeWidth: { min: 1, max: 8 },
  edgeScale: [true, false],
  edgeThreshold: { min: 0.1, max: 2 },
  edgeRim: [true, false]
}

/**
 * Settings read back from storage, whatever wrote them: every known value
 * checked (anything else is the default). Round 1 saved the slopes area as
 * `slopeStyle` + `slopeShade`; those become the settings that draw the same.
 */
export function migrateLook(raw: unknown): LabLook {
  const out: LabLook = { ...DEFAULT }
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  const o = out as unknown as Record<string, unknown>
  for (const k of Object.keys(ALLOWED) as (keyof LabLook)[]) {
    const v = r[k]
    const a = ALLOWED[k]
    if (Array.isArray(a) ? a.includes(v as never) : typeof v === 'number' && Number.isFinite(v) && v >= (a as { min: number }).min && v <= (a as { max: number }).max) o[k] = v
  }
  if (r.slopeUphill === 'off') out.slopeUphill = 0
  if (r.slopeUphill === 'gentle') out.slopeUphill = 12
  const old = r.slopeStyle
  if ((old === 'shade' || old === 'contours' || old === 'terraces' || old === 'lift') && !SLOPE_KEYS.some((k) => k in r)) {
    const facing = old === 'shade' || r.slopeShade !== false ? 'current' : 'off'
    Object.assign(out, styleSettings(old, { ...out, slopeFacing: facing }))
  }
  return out
}

function read(): LabLook {
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(KEY) : null
    return raw ? migrateLook(JSON.parse(raw)) : { ...DEFAULT }
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
