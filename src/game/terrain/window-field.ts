/**
 * A window of the streamed terrain as a field (./bake.ts BakeWindow): world
 * tiles (w × h) from (ox, oy), each tile's resolved corners in levels, its
 * kind as the shared drawing code reads it, and a cliff's face. Ground not
 * loaded is flat at 0 with no kind.
 */
import { CLIFF, CRAG, SLOPE, STEEP, SLOPE_UNIT } from './surface.ts'
import { FIELD_CRAG, FIELD_NONE, FIELD_SLOPE, FIELD_STEEP, type BakeWindow } from './bake.ts'
import type { TerrainStore } from './store.ts'

const KINDS: Record<number, number> = { [SLOPE]: FIELD_SLOPE, [STEEP]: FIELD_STEEP, [CRAG]: FIELD_CRAG, [CLIFF]: FIELD_STEEP }

export function buildWindow(store: TerrainStore, ox: number, oy: number, w: number, h: number): BakeWindow {
  const n = w * h
  const win: BakeWindow = { ox, oy, w, h, corner: new Float32Array(n * 4), kind: new Uint8Array(n), faceTop: new Float32Array(n), faceRow: new Int8Array(n), faceRows: new Int8Array(n) }
  const c = [0, 0, 0, 0]
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const tx = ox + x
      const ty = oy + y
      if (!store.corners(tx, ty, c)) {
        win.kind[i] = FIELD_NONE
        continue
      }
      win.corner.set(c, i * 4)
      const cx = Math.floor(tx / 24)
      const cy = Math.floor(ty / 24)
      const s = store.surface(cx, cy)!
      const j = (ty - cy * 24) * s.w + (tx - cx * 24)
      const k = s.kind[j]!
      // A walkable kind steeper than the limit can't come off the wire (decode refuses it).
      win.kind[i] = KINDS[k] ?? FIELD_NONE
      if (k === CLIFF) {
        win.faceTop[i] = s.faceTop[j]! / SLOPE_UNIT
        win.faceRow[i] = s.faceRow[j]!
        win.faceRows[i] = s.faceRows[j]!
      }
    }
  return win
}
