import type { TerrainFeature } from './find.ts'
import type { TerrainMode } from './settings.ts'

// A transient dev view, never saved with the world or device settings.
let current: TerrainFeature | null = null
let arrived = false
export function setTerrainFeatureView(feature: TerrainFeature | null): void {
  current = feature?.kind === 'spire' ? feature : null
  arrived = false
}

export interface FeatureCamera { zoom: number; x: number; y: number }
/** Fit the physical spire and its lifted crown, while keeping the hero visible. */
export function spireCamera(feature: TerrainFeature, hero: { x: number; y: number }, mode: TerrainMode, width: number, height: number): FeatureCamera {
  const x = feature.target[0] * 16, y = feature.target[1] * 16
  const minX = Math.min(x - 32 * 16, hero.x) - 4 * 16
  const maxX = Math.max(x + 32 * 16, hero.x) + 4 * 16
  const minY = Math.min(y - (mode === 'lift' ? 48 : 32) * 16, hero.y) - 4 * 16
  const maxY = Math.max(y + 32 * 16, hero.y) + 4 * 16
  return {
    zoom: Math.max(0.25, Math.min(2, Math.floor(Math.min(width / (maxX - minX), height / (maxY - minY)) * 4) / 4)),
    x: hero.x - (minX + maxX) / 2,
    y: hero.y - (minY + maxY) / 2
  }
}

export function terrainFeatureCamera(hero: { x: number; y: number }, mode: TerrainMode, width: number, height: number): FeatureCamera | null {
  if (!current) return null
  const d = Math.hypot(hero.x / 16 - current.stand[0] - 0.5, hero.y / 16 - current.stand[1] - 0.5)
  if (d > 32) {
    if (arrived) setTerrainFeatureView(null)
    return null
  }
  arrived = true
  return spireCamera(current, hero, mode, width, height)
}
