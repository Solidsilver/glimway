/** Dev-only low-resolution sun layer. Never imports or calls an albedo painter. */
import { TILE_PX as T, KIND } from './levels.ts'
import { fieldGradient, fieldZ, liftColumn, spanAt, spanGround, type Field, type SlopesInfo } from './slopes.ts'
import { surfaceLight, sunFacing, type DaySun, type RGB, type SunDirection } from './sun.ts'

export const SUN_RES = 8
/** A bounded 64-tile halo, sampled from the shared field across chunk edges. */
export const SUN_REACH = 64
export interface SunSample { rgb: RGB; visible: number }
export interface SunMap { x: number; y: number; w: number; h: number; px: Uint8ClampedArray; visibility: Float32Array }

/** Height field ray in physical units (levels × 3). Half-tile steps cannot
 * skip a tile-wide wall; start just off the surface to avoid self acne. */
export function terrainVisibility(f: Field, x: number, y: number, z: number, sun: SunDirection): number {
  const horizontal = Math.hypot(sun[0], sun[1])
  if (horizontal < 1e-6) return 1
  const ux = sun[0] / horizontal, uy = sun[1] / horizontal
  const rise = sun[2] / horizontal / 3
  for (let d = 0.25; d <= SUN_REACH; d += 0.5) {
    const tx = x / T + ux * d, ty = y / T + uy * d
    if (tx < 0 || ty < 0 || tx >= f.w || ty >= f.h) break
    const h = fieldZ(f, Math.floor(tx), Math.floor(ty), tx % 1, ty % 1)
    if (h > z + rise * d + 0.025) return 0
  }
  return 1
}

/** Map view points back to their receiving surface. South cliff faces use
 * their actual outward normal, not the ground underneath their footprint. */
export function receivingPoint(info: SlopesInfo, x: number, y: number): { x: number; y: number; z: number; face: boolean } {
  const f = info.field
  const tx = Math.max(0, Math.min(f.w - 1, Math.floor(x / T)))
  const fx = Math.max(0, Math.min(1, x / T - tx))
  if (info.lift) {
    const sp = spanAt(liftColumn(f, tx, fx, info.pad, info.k), y / T)
    if (sp) {
      if (sp.face) {
        const down = (y / T - sp.s0) / Math.max(1e-6, sp.s1 - sp.s0)
        return { x, y: (sp.ty + 1) * T + 0.01, z: sp.zS - down * (sp.zS - sp.zBot), face: true }
      }
      const at = spanGround(sp, y / T)
      return { x, y: (sp.ty + at.fy) * T, z: at.z, face: false }
    }
  } else {
    const ty = Math.max(0, Math.min(info.view.h - 1, Math.floor(y / T)))
    const i = ty * info.view.w + tx
    if (info.view.kind[i] === KIND.face) {
      const row = info.view.faceRow[i]!
      return { x, y: (ty - row) * T + 0.01, z: info.view.faceTop[i]! - (row + (y / T - ty)) / 3, face: true }
    }
  }
  const fy = Math.max(0, Math.min(f.h - 0.0001, y / T))
  return { x, y: fy * T, z: fieldZ(f, tx, Math.floor(fy), fx, fy % 1), face: false }
}
export function fieldLight(f: Field, x: number, y: number, z: number, sun: DaySun, strength: number, face = false): SunSample {
  const [gx, gy] = fieldGradient(f, x, y)
  const visible = sun.daylight > 0 ? terrainVisibility(f, x, y, z, sun.direction) : 0
  return { rgb: surfaceLight(face ? sun.direction[1] : sunFacing(gx, gy, sun.direction), visible, sun, strength), visible }
}
/** Texels sit at chunk boundaries with a one-texel halo. Adjacent chunks
 * compute identical samples at their seams; the ray reads the full halo. */
export function* buildSunMap(info: SlopesInfo, x: number, y: number, width: number, height: number, sun: DaySun, strength: number, enabled = true): Generator<void, SunMap> {
  const w = Math.ceil(width / SUN_RES) + 3, h = Math.ceil(height / SUN_RES) + 3
  const map: SunMap = { x: x - SUN_RES, y: y - SUN_RES, w, h, px: new Uint8ClampedArray(w * h * 4), visibility: new Float32Array(w * h) }
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const p = receivingPoint(info, map.x + ix * SUN_RES, map.y + iy * SUN_RES)
      const at = enabled ? fieldLight(info.field, p.x, p.y, p.z, sun, strength, p.face) : { rgb: [1, 1, 1] as RGB, visible: 0 }
      const i = iy * w + ix
      for (let c = 0; c < 3; c++) map.px[i * 4 + c] = at.rgb[c]! * 255
      map.px[i * 4 + 3] = 255
      map.visibility[i] = at.visible
    }
    if ((iy + 1) % 4 === 0) yield
  }
  return map
}
export function sampleSunMap(map: SunMap, x: number, y: number): SunSample {
  const fx = Math.max(0, Math.min(map.w - 1.00001, (x - map.x) / SUN_RES))
  const fy = Math.max(0, Math.min(map.h - 1.00001, (y - map.y) / SUN_RES))
  const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy
  const rgb = [0, 0, 0], v = [0]
  for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    const i = (iy + dy) * map.w + ix + dx, weight = (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay)
    for (let c = 0; c < 3; c++) rgb[c] += map.px[i * 4 + c]! / 255 * weight
    v[0] += map.visibility[i]! * weight
  }
  return { rgb: rgb as unknown as RGB, visible: v[0]! }
}
