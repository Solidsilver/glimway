/** Dense textures and optional URLs for interface-only packed art passes. */
import type Phaser from 'phaser'
import { PACKED_MANIFEST_KEY, type PackedManifest } from './atlas-plan.ts'
import { explodeFrames } from './art-pass.ts'
import { TILE } from '../lib/tile.ts'
import { artDataUrl, artSource } from './density.ts'

export function createInterfaceArt(scene: Phaser.Scene, pass: 'glims' | 'purse', atlas: string, key: (frame: string) => string): boolean {
  const packed = (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest | undefined)?.[pass]
  if (!packed) return false
  const perPx = packed.density / TILE
  const frames = Object.entries(packed.frames).map(([key, r]) => ({ key, width: r[2] / perPx, height: r[3] / perPx }))
  return !!explodeFrames(scene, atlas, { ...packed, density: perPx }, frames, key)
}

export function interfaceIconUrls(scene: Phaser.Scene, icons: Readonly<Record<string, string>>, keyOf: (frame: string) => string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, frame] of Object.entries(icons)) {
    const src = artSource(scene, keyOf(frame))
    if (!src) continue
    try { out[key] = artDataUrl(src, src.density) } catch { /* optional: UI draws its fallback */ }
  }
  return out
}
