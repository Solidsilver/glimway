/**
 * Height terrain's surface, the client's twin of the server's
 * (server/internal/wilds/slopes_surface.go, slopes_codec.go): a chunk's
 * canonical corner field in 1/256 level, a row-major (w+1)×(h+1) Uint16
 * grid, with sparse per-tile four-corner overrides (NW, NE, SE, SW) that
 * never change the grid; per tile its kind (slope, steep, crag, cliff),
 * closed N/E/S/W edges, whether it's a deliberate unreachable spire, and a
 * cliff's exact face (top, bottom, row, rows).
 *
 * The contract (slopes-gen-notes.md): levels 0–15, a walkable tile is
 * `slope` with every corner's gx² + gy² ≤ 64² (one level in four tiles),
 * integers only. Crossing an edge needs both tiles walkable, neither flag
 * set and both corner pairs equal. A world corner (x, y) is owned by chunk
 * (floor(x/24), floor(y/24)); neighbours replicate it exactly.
 * content/vectors/slopes-surface.json is the shared test.
 */

export const SLOPE_UNIT = 256
/** The steepest walkable gradient, quantized (a rise of 64/256 level a tile). */
export const SLOPE_WALK_LIMIT = SLOPE_UNIT / 4
export const SLOPE_WIRE_VERSION = 2

/** Ground kinds, the wire's 2-bit codes. Steep and crag keep their kinds so climbing gear can open them later. */
export const SLOPE = 0
export const STEEP = 1
export const CRAG = 2
export const CLIFF = 3
export type SlopeKind = typeof SLOPE | typeof STEEP | typeof CRAG | typeof CLIFF

/** Edge directions, as flag bits: N, E, S, W. */
export const DX = [0, 1, 0, -1] as const
export const DY = [-1, 0, 1, 0] as const

export interface SlopeSurface {
  w: number
  h: number
  /** (w+1)×(h+1), row-major, 1/256 level. */
  corners: Uint16Array
  kind: Uint8Array
  /** Closed N/E/S/W edges, bits 0–3. */
  flags: Uint8Array
  unreachable: Uint8Array
  faceTop: Uint16Array
  faceBottom: Uint16Array
  faceRow: Uint8Array
  faceRows: Uint8Array
  /** Overridden tiles, ascending, and their NW, NE, SE, SW corners (four each). */
  overrideTiles: Int32Array
  overrideCorners: Uint16Array
}

export function emptySurface(w: number, h: number): SlopeSurface {
  const n = w * h
  return {
    w,
    h,
    corners: new Uint16Array((w + 1) * (h + 1)),
    kind: new Uint8Array(n),
    flags: new Uint8Array(n),
    unreachable: new Uint8Array(n),
    faceTop: new Uint16Array(n),
    faceBottom: new Uint16Array(n),
    faceRow: new Uint8Array(n),
    faceRows: new Uint8Array(n),
    overrideTiles: new Int32Array(0),
    overrideCorners: new Uint16Array(0)
  }
}

/** The grid's corners of tile i: NW, NE, SE, SW. */
export function gridCorners(s: SlopeSurface, i: number, out: number[] = [0, 0, 0, 0]): number[] {
  const j = Math.floor(i / s.w) * (s.w + 1) + (i % s.w)
  out[0] = s.corners[j]!
  out[1] = s.corners[j + 1]!
  out[2] = s.corners[j + s.w + 2]!
  out[3] = s.corners[j + s.w + 1]!
  return out
}

/** Index of tile i's override, or -1. */
export function overrideOf(s: SlopeSurface, i: number): number {
  let lo = 0
  let hi = s.overrideTiles.length - 1
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    const t = s.overrideTiles[m]!
    if (t === i) return m
    if (t < i) lo = m + 1
    else hi = m - 1
  }
  return -1
}

/** Tile i's resolved corners (NW, NE, SE, SW): its override's, else the grid's. */
export function tileCorners(s: SlopeSurface, i: number, out: number[] = [0, 0, 0, 0]): number[] {
  const o = s.overrideTiles.length ? overrideOf(s, i) : -1
  if (o < 0) return gridCorners(s, i, out)
  for (let c = 0; c < 4; c++) out[c] = s.overrideCorners[o * 4 + c]!
  return out
}

/** The bilinear tile's squared gradient at its steepest corner (1/256 level a tile, squared). */
export function gradientSquared(nw: number, ne: number, se: number, sw: number): number {
  const a = (ne - nw) * (ne - nw) + (sw - nw) * (sw - nw)
  const b = (ne - nw) * (ne - nw) + (se - ne) * (se - ne)
  const c = (se - sw) * (se - sw) + (se - ne) * (se - ne)
  const d = (se - sw) * (se - sw) + (sw - nw) * (sw - nw)
  return Math.max(a, b, c, d)
}

const scratch = [0, 0, 0, 0]

/** Walkable by the four-corner rule: `slope` ground no steeper than the limit anywhere. */
export function surfaceWalkable(s: SlopeSurface, i: number): boolean {
  if (i < 0 || i >= s.kind.length || s.kind[i] !== SLOPE) return false
  const c = tileCorners(s, i, scratch)
  return gradientSquared(c[0]!, c[1]!, c[2]!, c[3]!) <= SLOPE_WALK_LIMIT * SLOPE_WALK_LIMIT
}

/** Do tile a's corners on its side d equal tile b's on the opposite side? */
export function cornersMeet(a: readonly number[], b: readonly number[], d: number): boolean {
  switch (d) {
    case 0:
      return a[0] === b[3] && a[1] === b[2]
    case 1:
      return a[1] === b[0] && a[2] === b[3]
    case 2:
      return a[3] === b[0] && a[2] === b[1]
    default:
      return a[0] === b[1] && a[3] === b[2]
  }
}

const sa = [0, 0, 0, 0]
const sb = [0, 0, 0, 0]

/** A step inside one surface from tile i across its side d: the tile reached, or -1 (SlopePlan.Step). */
export function surfaceStep(s: SlopeSurface, i: number, d: number): number {
  if (d < 0 || d > 3 || !surfaceWalkable(s, i)) return -1
  const x = (i % s.w) + DX[d]!
  const y = Math.floor(i / s.w) + DY[d]!
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) return -1
  const j = y * s.w + x
  if (!surfaceWalkable(s, j) || s.flags[i]! & (1 << d) || s.flags[j]! & (1 << ((d + 2) & 3))) return -1
  return cornersMeet(tileCorners(s, i, sa), tileCorners(s, j, sb), d) ? j : -1
}

// ------------------------------------------------------------ the codec

export class SlopeCodecError extends Error {}
const bad = (why: string) => new SlopeCodecError(`slope surface: ${why}`)

/** The checks EncodeSlopeChunk makes before it writes. */
export function validateSurface(s: SlopeSurface): void {
  if (s.w < 1 || s.h < 1 || s.w > 64 || s.h > 64 || s.corners.length !== (s.w + 1) * (s.h + 1) || s.kind.length !== s.w * s.h) throw bad('invalid dimensions')
  let last = -1
  for (let o = 0; o < s.overrideTiles.length; o++) {
    const t = s.overrideTiles[o]!
    if (t <= last || t >= s.kind.length) throw bad('overrides must have unique ascending tile indices')
    last = t
    const g = gridCorners(s, t)
    let same = true
    for (let c = 0; c < 4; c++) same = same && s.overrideCorners[o * 4 + c] === g[c]
    if (same || s.flags[t] === 0) throw bad('override needs changed corners and an explicit discontinuity')
  }
  const t = [0, 0, 0, 0]
  const n = [0, 0, 0, 0]
  for (let i = 0; i < s.kind.length; i++) {
    const k = s.kind[i]!
    if (k > CLIFF || s.flags[i]! > 15) throw bad('invalid terrain kind or edge flags')
    tileCorners(s, i, t)
    if (k === SLOPE && gradientSquared(t[0]!, t[1]!, t[2]!, t[3]!) > SLOPE_WALK_LIMIT * SLOPE_WALK_LIMIT) throw bad('walkable gradient exceeds limit')
    if (k === CLIFF) {
      const top = s.faceTop[i]!
      const bottom = s.faceBottom[i]!
      const rows = s.faceRows[i]!
      if (top <= bottom || rows === 0 || s.faceRow[i]! >= rows || rows !== Math.floor(((top - bottom) * 3 + 255) / 256)) throw bad('invalid face span')
    } else if (s.faceTop[i] || s.faceBottom[i] || s.faceRow[i] || s.faceRows[i]) throw bad('face metadata on non-cliff ground')
    for (const d of [1, 2]) {
      const x = (i % s.w) + DX[d]!
      const y = Math.floor(i / s.w) + DY[d]!
      if (x >= s.w || y >= s.h) continue
      const j = y * s.w + x
      const a = (s.flags[i]! & (1 << d)) !== 0
      const b = (s.flags[j]! & (1 << ((d + 2) & 3))) !== 0
      if (a !== b) throw bad('unpaired internal discontinuity')
      tileCorners(s, j, n)
      if (!cornersMeet(t, n, d) && !a) throw bad('unflagged corner crack')
    }
  }
}

/** The SL2 envelope (EncodeSlopeChunk), byte for byte. */
export function encodeSurface(s: SlopeSurface): Uint8Array {
  validateSurface(s)
  const n = s.kind.length
  const out: number[] = [0x53, 0x4c, SLOPE_WIRE_VERSION, s.w, s.h, 0]
  const u16 = (v: number) => out.push(v & 255, (v >> 8) & 255)
  const uniform = s.corners.every((q) => q === s.corners[0])
  if (uniform) {
    out[5] = 1
    u16(s.corners[0]!)
  } else for (const q of s.corners) u16(q)
  const kinds = new Array<number>((n + 3) >> 2).fill(0)
  const planes = Array.from({ length: 6 }, () => new Array<number>((n + 7) >> 3).fill(0))
  let mask = 0
  for (let i = 0; i < n; i++) {
    kinds[i >> 2] |= s.kind[i]! << ((i & 3) * 2)
    let bits = s.flags[i]! << 2
    if (s.unreachable[i]) bits |= 1
    if (s.kind[i] === CLIFF) bits |= 2
    for (let b = 0; b < 6; b++)
      if (bits & (1 << b)) {
        planes[b]![i >> 3] |= 1 << (i & 7)
        mask |= 1 << b
      }
  }
  out.push(...kinds, mask)
  for (let b = 0; b < 6; b++) if (mask & (1 << b)) out.push(...planes[b]!)
  u16(s.overrideTiles.length)
  for (let o = 0; o < s.overrideTiles.length; o++) {
    u16(s.overrideTiles[o]!)
    for (let c = 0; c < 4; c++) u16(s.overrideCorners[o * 4 + c]!)
  }
  for (let i = 0; i < n; i++)
    if (s.kind[i] === CLIFF) {
      u16(s.faceTop[i]!)
      u16(s.faceBottom[i]!)
      out.push(s.faceRow[i]!, s.faceRows[i]!)
    }
  return Uint8Array.from(out)
}

/** Decode an SL2 envelope, refusing anything DecodeSlopeChunk refuses (truncated, trailing, noncanonical, invalid). */
export function decodeSurface(raw: Uint8Array): SlopeSurface {
  if (raw.length < 6 || raw[0] !== 0x53 || raw[1] !== 0x4c || raw[2] !== SLOPE_WIRE_VERSION || raw[3] === 0 || raw[3]! > 64 || raw[4] === 0 || raw[4]! > 64 || raw[5]! > 1) throw bad('invalid envelope')
  const s = emptySurface(raw[3]!, raw[4]!)
  const n = s.w * s.h
  const u16 = (p: number) => raw[p]! | (raw[p + 1]! << 8)
  let pos = 6
  const count = raw[5] === 1 ? 1 : s.corners.length
  if (raw.length < pos + count * 2) throw bad('short corner grid')
  for (let i = 0; i < s.corners.length; i++) s.corners[i] = u16(pos + (raw[5] === 1 ? 0 : i) * 2)
  pos += count * 2
  const kindBytes = (n + 3) >> 2
  if (raw.length < pos + kindBytes + 1) throw bad('short kinds')
  const kinds = pos
  pos += kindBytes
  const mask = raw[pos++]!
  if (mask & 0xc0) throw bad('unknown flag plane')
  const bits = new Uint8Array(n)
  for (let b = 0; b < 6; b++) {
    if (!(mask & (1 << b))) continue
    const nb = (n + 7) >> 3
    if (raw.length < pos + nb) throw bad('short edge flags')
    for (let i = 0; i < n; i++) if (raw[pos + (i >> 3)]! & (1 << (i & 7))) bits[i]! |= 1 << b
    pos += nb
  }
  for (let i = 0; i < n; i++) {
    s.kind[i] = (raw[kinds + (i >> 2)]! >> ((i & 3) * 2)) & 3
    s.unreachable[i] = bits[i]! & 1
    s.flags[i] = bits[i]! >> 2
    if (((bits[i]! & 2) !== 0) !== (s.kind[i] === CLIFF)) throw bad('cliff flag disagrees with ground kind')
  }
  if (raw.length < pos + 2) throw bad('missing override count')
  const overrides = u16(pos)
  pos += 2
  if (overrides > n || raw.length < pos + overrides * 10) throw bad('invalid override records')
  s.overrideTiles = new Int32Array(overrides)
  s.overrideCorners = new Uint16Array(overrides * 4)
  for (let o = 0; o < overrides; o++) {
    s.overrideTiles[o] = u16(pos)
    pos += 2
    for (let c = 0; c < 4; c++) {
      s.overrideCorners[o * 4 + c] = u16(pos)
      pos += 2
    }
  }
  for (let i = 0; i < n; i++) {
    if (s.kind[i] !== CLIFF) continue
    if (raw.length < pos + 6) throw bad('short faces')
    s.faceTop[i] = u16(pos)
    s.faceBottom[i] = u16(pos + 2)
    s.faceRow[i] = raw[pos + 4]!
    s.faceRows[i] = raw[pos + 5]!
    pos += 6
  }
  const canonical = encodeSurface(s)
  if (pos !== raw.length || canonical.length !== raw.length || canonical.some((b, i) => b !== raw[i])) throw bad('noncanonical envelope')
  return s
}

/** The dev terrain route's batch reply (server/internal/api/dev_terrain.go): per chunk int32 cx, int32 cy, uint16 length, SL2 bytes. */
export function decodeTerrainBatch(raw: Uint8Array): { cx: number; cy: number; surface: SlopeSurface }[] {
  const out: { cx: number; cy: number; surface: SlopeSurface }[] = []
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  let pos = 0
  while (pos < raw.length) {
    if (raw.length < pos + 10) throw bad('short batch')
    const cx = view.getInt32(pos, true)
    const cy = view.getInt32(pos + 4, true)
    const len = view.getUint16(pos + 8, true)
    if (raw.length < pos + 10 + len) throw bad('short batch chunk')
    out.push({ cx, cy, surface: decodeSurface(raw.subarray(pos + 10, pos + 10 + len)) })
    pos += 10 + len
  }
  return out
}
