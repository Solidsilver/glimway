/**
 * Height terrain's own materials, shared by the height lab's painter
 * (../height-lab/slopes-paint.ts) and the game's chunk bake (./bake.ts):
 * the tint of height (drier, stonier, snow on the tops), scree down the
 * fall line on too-steep ground, broken crag blocks, fallen blocks at a
 * cliff's foot, the rim of loose stones where walkable ground ends, and a
 * cliff face's unlit strata. All world-fixed (a pixel paints the same
 * whichever bake it's in). Values are RGB 0–255.
 */

export type RGB = [number, number, number]

export function hash(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 1442695041) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const mix = (a: number, b: number, t: number) => a + (b - a) * t
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const hexRGB = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]

const DRY = hexRGB('#d8c890')
const STONE = hexRGB('#a8a296')
const SNOW = hexRGB('#eef2f8')
const SCREE = hexRGB('#aa9f8e')
const BARE = hexRGB('#96928b')
const TILE = 16

function tint(c: RGB, to: readonly number[], k: number): void {
  c[0] = mix(c[0], to[0]!, k)
  c[1] = mix(c[1], to[1]!, k)
  c[2] = mix(c[2], to[2]!, k)
}

/** Height's tint over a ground colour at world px (wx, wy), z levels: drier above 2.5, stonier above 6, snow above 11. */
export function heightTint(c: RGB, z: number, wx: number, wy: number): void {
  tint(c, DRY, 0.18 * smoothstep(2.5, 6.5, z))
  tint(c, STONE, 0.42 * smoothstep(6, 10, z))
  if (z > 11) tint(c, SNOW, (0.35 + hash(wx >> 2, wy >> 2, 21) * 0.25) * smoothstep(11, 12.5, z))
}

/** Rock ledges a level (bands along the contours: closer together where the ground is steeper). */
const LEDGES = 2
/** The narrowest a ledge is drawn (px): on steeper ground a band spans more levels. */
const LEDGE_PX = 7

/**
 * Too-steep ground at world px, height z: rock, in ledges along the
 * contours (a dark joint under each lip, a light lip, broken into blocks
 * along the contour), with scree down the fall line (broken streaks of
 * uneven length); bare rock where it's steeper still; at a cliff's foot
 * (talus) fallen blocks. A little of the ground under it shows through, so
 * the rock sits in the season's colours. (gx, gy): the slope there, levels
 * a tile. `rimOff`: px to the nearest walkable side within the tile (-1:
 * none), where a rim of loose stones marks where walking ends.
 */
export function steepMaterial(c: RGB, wx: number, wy: number, gx: number, gy: number, z: number, talus: boolean, rimOff: number): void {
  const under0 = c[0]
  const under1 = c[1]
  const under2 = c[2]
  const slope = Math.hypot(gx, gy)
  const rock = slope > 0.55
  const base = rock ? BARE : SCREE
  const k = (0.95 + hash(wx >> 3, wy >> 3, 31) * 0.1 + (hash(wx, wy, 32) - 0.5) * 0.1) * ledges(wx, wy, gx, gy, z, rock ? 1 : 0.7)
  c[0] = base[0] * k
  c[1] = base[1] * k
  c[2] = base[2] * k
  tint(c, [under0, under1, under2], 0.14)
  const dx = gx / (slope || 1)
  const dy = gy / (slope || 1)
  const along = wx * dx + wy * dy
  const across = -wx * dy + wy * dx
  // Short dashes down the fall line, on a world grid so they don't swirl with it.
  const dash = hash(Math.floor(across / 2), Math.floor(along / 5), 22)
  if (dash < 0.1) tint(c, [58, 54, 50], rock ? 0.35 : 0.25)
  else if (dash > 0.93) tint(c, [214, 208, 196], 0.18)
  // Loose pale stones in the material.
  if (hash(wx >> 1, wy >> 1, 23) < 0.05 && (wx & 1) === 0 && (wy & 1) === 0) tint(c, [228, 222, 208], 0.55)
  if (talus) {
    // Fallen blocks at a cliff foot, varied by material.
    const bx = Math.floor((wx + (Math.floor(wy / 3) % 2) * 2) / 4)
    const blk = hash(bx, Math.floor(wy / 3), 33)
    const k2 = 0.78 - blk * 0.16
    c[0] *= k2
    c[1] *= k2 * 0.98
    c[2] *= k2 * 0.97
  }
  if (rimOff >= 0 && rimOff < 2) tint(c, [214, 204, 182], rimOff === 0 ? 0.55 : 0.3)
}

/**
 * Rock ledges along the contours at world px, height z (levels), slope
 * (gx, gy): a band every 1/LEDGES level (closer together where the ground is
 * steeper), each broken into blocks along the contour (it runs east–west
 * on a north or south face, north–south on an east or west one), a dark
 * joint under each lip and a light lip. A brightness factor; `contrast`
 * scales it.
 */
function ledges(wx: number, wy: number, gx: number, gy: number, z: number, contrast: number): number {
  const slope = Math.max(0.2, Math.hypot(gx, gy))
  // Levels a band: 1/LEDGES, doubled until the band is at least LEDGE_PX wide; its edges waver a little.
  let step = 1 / LEDGES
  while ((step * TILE) / slope < LEDGE_PX) step *= 2
  const zb = z / step + (hash(wx >> 4, wy >> 4, 34) - 0.5) * 0.12 + (hash(wx >> 1, wy >> 1, 39) - 0.5) * 0.05
  const band = Math.floor(zb)
  const bandPx = (step * TILE) / slope
  const below = (zb - band) * bandPx
  const above = (1 - (zb - band)) * bandPx
  const run = Math.abs(gy) >= Math.abs(gx) ? wx : wy
  const bw = 8 + Math.floor(hash(band, 0, 35) * 9)
  const shift = run + Math.floor(hash(band, 1, 36) * bw)
  const block = Math.floor(shift / bw)
  let k = 1 + (hash(band, block, 37) - 0.5) * 0.24 * contrast
  if (above < 1) k *= 1 - 0.4 * contrast
  else if (above < 2 && bandPx > 7) k *= 1 - 0.18 * contrast
  else if (below < 1) k *= 1 + 0.12 * contrast
  else if (shift - block * bw < 1 && hash(band, block, 38) < 0.45) k *= 1 - 0.22 * contrast
  return Math.max(0.3, k)
}

/**
 * Crags at world px, height z, slope (gx, gy): broken rock, darker and
 * rougher than steep ground, in ledges along the contours, mottled in
 * small patches; a little of the ground under it shows through.
 */
export function cragMaterial(c: RGB, wx: number, wy: number, gx: number, gy: number, z: number): void {
  const under: RGB = [c[0], c[1], c[2]]
  const v = (106 + hash(wx >> 2, wy >> 2, 24) * 14 + hash(wx >> 3, (wy + 4) >> 3, 26) * 12 + (hash(wx, wy, 27) - 0.5) * 8) * ledges(wx, wy, gx, gy, z, 1.25)
  c[0] = v
  c[1] = v * 0.97
  c[2] = v * 0.95
  tint(c, under, 0.12)
}

/** A face's colour by the height it rises to (warm low down, greyer and cooler high up). */
function faceTint(z: number): RGB {
  return z < 2.5 ? [1.06, 0.98, 0.88] : z < 5 ? [1, 0.96, 0.92] : z < 9 ? [0.94, 0.95, 1] : [1.02, 1.03, 1.07]
}

/** Unlit rock strata and mineral seams of a cliff face at world column x, height z (levels), the face's top `top`. */
export function cliffMaterial(x: number, z: number, top: number): RGB {
  const height = z * 48
  const seamY = height + 1.8 * Math.sin(x / 23) + 0.6 * Math.sin(x / 7)
  const band = Math.floor(seamY / 8)
  const phase = seamY - band * 8
  const patch = hash(Math.floor(x / 17), Math.floor(height / 13), 71)
  let value = 152 + (hash(Math.floor(x / 3), Math.floor(height / 3), 72) - 0.5) * 15 + (patch - 0.5) * 22
  // A dark mineral joint, with no directional highlight beside it.
  if (phase < 0.8 && hash(Math.floor(x / 19), band, 73) < 0.8) value *= 0.77
  const joint = (x + Math.floor(height / 19) * 3 + 100000) % 23
  if (joint < 1 && hash(Math.floor(x / 23), Math.floor(height / 29), 74) < 0.6) value *= 0.73
  value += (hash(x, Math.floor(height), 75) - 0.5) * 9
  return faceTint(top).map((c) => c * value) as RGB
}
