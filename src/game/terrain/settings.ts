/**
 * Height terrain's dev switch and look (dev builds only): on or off, top-down
 * or the true ¾ lift, edge shading, the sun and slope speed. Set from the dev
 * panel's Terrain section (src/ui/dev/TerrainSection.svelte), kept on this
 * device. Only a dev server serves the terrain (GET /api/dev/terrain), so on
 * the live server the switch finds nothing and play stays flat.
 */
import { EDGE_DEFAULT, type EdgeSettings } from './edges.ts'
import { TILE_PX, type LiftCurve } from './field.ts'

export type TerrainMode = 'top' | 'lift'
export type TallGround = 'full' | 'compressed'

export interface TerrainSettings {
  /** Generated height terrain in the Wilds. */
  on: boolean
  /** Top-down (shading by facing) or the true ¾ lift (48 px a level). */
  mode: TerrainMode
  /** Tall ground in the lift: 48 px a level all the way up, or compressed past a knee. */
  tall: TallGround
  /** Compressed: the knee (a level) and the lift a level above it (px, 0–48). */
  tallKnee: number
  tallStep: number
  /** Edge shading (./edges.ts): strength 0–1 (0 off), band width px, scaled by the drop, threshold levels, a rim on the lip. */
  edgeShade: number
  edgeWidth: number
  edgeScale: boolean
  edgeThreshold: number
  edgeRim: boolean
  /** Direct sun, 0–2 (0 keeps the ambient fill). */
  sunStrength: number
  /** Dawn 0, noon 0.5, dusk 1, when not following the clock. */
  sunTime: number
  /** The sun follows the game clock. */
  sunClock: boolean
  /** Speed cut straight up the steepest walkable ground, percent 0–80; quickening straight down, 0–20. */
  uphill: number
  downhill: number
  /** The slope gait: cadence from real speed, a small lean, scuffs on steep ground. */
  gait: boolean
}

export const TERRAIN_DEFAULT: TerrainSettings = {
  on: false,
  mode: 'top',
  tall: 'compressed',
  tallKnee: 4,
  tallStep: 16,
  edgeShade: EDGE_DEFAULT.strength,
  edgeWidth: EDGE_DEFAULT.width,
  edgeScale: EDGE_DEFAULT.scale,
  edgeThreshold: EDGE_DEFAULT.threshold,
  edgeRim: EDGE_DEFAULT.rim,
  sunStrength: 1,
  sunTime: 0.5,
  sunClock: true,
  uphill: 60,
  downhill: 6,
  gait: true
}

const ALLOWED: { [K in keyof TerrainSettings]: readonly TerrainSettings[K][] | { min: number; max: number } } = {
  on: [true, false],
  mode: ['top', 'lift'],
  tall: ['full', 'compressed'],
  tallKnee: { min: 1, max: 15 },
  tallStep: { min: 0, max: 48 },
  edgeShade: { min: 0, max: 1 },
  edgeWidth: { min: 1, max: 8 },
  edgeScale: [true, false],
  edgeThreshold: { min: 0.1, max: 2 },
  edgeRim: [true, false],
  sunStrength: { min: 0, max: 2 },
  sunTime: { min: 0, max: 1 },
  sunClock: [true, false],
  uphill: { min: 0, max: 80 },
  downhill: { min: 0, max: 20 },
  gait: [true, false]
}

/** Settings read back, whatever wrote them: each value checked, anything else the default. */
export function readTerrainSettings(raw: unknown): TerrainSettings {
  const out: TerrainSettings = { ...TERRAIN_DEFAULT }
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  const o = out as unknown as Record<string, unknown>
  for (const k of Object.keys(ALLOWED) as (keyof TerrainSettings)[]) {
    const v = r[k]
    const a = ALLOWED[k]
    if (Array.isArray(a) ? a.includes(v as never) : typeof v === 'number' && Number.isFinite(v) && v >= (a as { min: number }).min && v <= (a as { max: number }).max) o[k] = v
  }
  return out
}

/** The look's edge settings as ./edges.ts takes them. */
export function terrainEdges(s: TerrainSettings): EdgeSettings {
  return { strength: s.edgeShade, width: s.edgeWidth, scale: s.edgeScale, threshold: s.edgeThreshold, rim: s.edgeRim }
}

/** The lift's curve for tall ground (./field.ts liftRows): none at full height. */
export function terrainCurve(s: TerrainSettings): LiftCurve | undefined {
  return s.tall === 'compressed' ? { knee: Math.round(s.tallKnee), above: Math.round(s.tallStep) / TILE_PX } : undefined
}

const KEY = 'glimway:terrain'
let current: TerrainSettings = load()
const listeners = new Set<(s: TerrainSettings, was: TerrainSettings) => void>()

function load(): TerrainSettings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
    return raw ? readTerrainSettings(JSON.parse(raw)) : { ...TERRAIN_DEFAULT }
  } catch {
    return { ...TERRAIN_DEFAULT }
  }
}

export function terrainSettings(): TerrainSettings {
  return current
}

export function setTerrainSettings(change: Partial<TerrainSettings>): void {
  const was = current
  current = readTerrainSettings({ ...current, ...change })
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* private mode: the choice lasts the page */
  }
  for (const l of listeners) l(current, was)
}

/** Follow changes; returns the unsubscribe. */
export function onTerrainSettings(fn: (s: TerrainSettings, was: TerrainSettings) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
