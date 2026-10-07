/**
 * The playtest-1 buildings: the village's three houses and the Brackenwood
 * footbridge (worn and mended), packed whole by scripts/build-atlases.ts
 * (src/game/atlas-plan.ts BUILDINGS). At boot each becomes a dense
 * single-frame texture `p1:<name>` at the art's density (./density.ts), so
 * scenery draws it at its world size like any other delivered building.
 */
import type Phaser from 'phaser'
import { PACKED_MANIFEST_KEY, BUILDINGS, type BuildingFrame, type PackedManifest } from './atlas-plan.ts'
import { artDensity, resampleFor, setDensity } from './density.ts'

/** The packed buildings as loaded (staging: released once the textures are made). */
export const BUILDINGS_PACKED_KEY = 'packed-buildings'

/** A building's texture key. */
export const buildingKey = (name: BuildingFrame) => `p1:${name}`

/** Make the building textures, once. False when the pack didn't load (the tile houses and plank bridge stay). */
export function createBuildings(scene: Phaser.Scene): boolean {
  const packed = (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest | undefined)?.buildings
  if (!packed || !scene.textures.exists(BUILDINGS_PACKED_KEY)) return BUILDINGS.every((b) => scene.textures.exists(buildingKey(b)))
  const atlas = scene.textures.get(BUILDINGS_PACKED_KEY).getSourceImage() as CanvasImageSource
  const k = Math.min(artDensity(scene), packed.density)
  for (const name of BUILDINGS) {
    const r = packed.frames[name]
    const key = buildingKey(name)
    if (!r || scene.textures.exists(key)) continue
    const w = (r[2] / packed.density) * k
    const h = (r[3] / packed.density) * k
    const out = scene.textures.createCanvas(key, w, h)
    if (!out) continue
    resampleFor(out.context, packed.density, k)
    out.context.drawImage(atlas, r[0], r[1], r[2], r[3], 0, 0, w, h)
    out.refresh()
    setDensity(out, k)
  }
  // The pack was staging: release its GPU copy.
  scene.textures.remove(BUILDINGS_PACKED_KEY)
  return true
}

/** Whether a building's art loaded. */
export function hasBuilding(scene: Phaser.Scene, name: BuildingFrame): boolean {
  return scene.textures.exists(buildingKey(name))
}
