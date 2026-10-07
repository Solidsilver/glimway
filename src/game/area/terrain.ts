/**
 * Area construction — ground. Lays a WorldData terrain grid out as a Phaser
 * tilemap over the delivered terrain cells and the Commons pass's path
 * edges, at the art's density (./density.ts): a tileset of 64-texel cells
 * (at 4×), the layers scaled to 16-px world tiles, drawn nearest-neighbour.
 * The tilemap draws only the tiles in view, so a big map costs no texture
 * memory past the tileset (a baked 4× ground would be ~60 MB for the
 * Commons).
 */
import type Phaser from 'phaser'
import { TERRAIN, TILE } from '../textures.ts'
import type { WorldData } from '../worlds.ts'
import { buildTangleGround } from '../wilds/tangle-art.ts'
import { TIE_BIAS, addArtCanvas, artDensity, artSource, resampleFor } from '../density.ts'
import { GROUND_TILES, PACKED_MANIFEST_KEY, type PackedManifest } from '../atlas-plan.ts'
import { prefersReducedMotion } from '../sfx.ts'
import { EDGE_TEXTURE, WATER_FPS, WATER_FRAMES, WATER_SETS, baseTile, classGrid, edgeHasWater, edgeKey, neighbourhood, parseEdgeKey } from './ground-field.ts'
import { edgeRefNames, extrude, paintEdgeJobs, putCell, type EdgeJob, type Texels } from './ground-paint.ts'

/**
 * Explicit mapping from procedural terrain ids to the delivered expansion's
 * named tiles (indexed by order in the expansion manifest). The runtime
 * tileset is a normalized 4x4 sheet of cells, one 16-px world tile each.
 */
const TERRAIN_TO_EXPANSION: Record<number, string> = {
  [TERRAIN.grass_a]: 'grass',
  [TERRAIN.grass_b]: 'forest-moss',
  [TERRAIN.grass_c]: 'grass',
  [TERRAIN.flowers]: 'flower-grass',
  [TERRAIN.path_a]: 'packed-dirt',
  [TERRAIN.path_b]: 'packed-dirt',
  [TERRAIN.dirt]: 'packed-dirt',
  [TERRAIN.sand]: 'packed-dirt',
  [TERRAIN.water_a]: 'pond-water',
  [TERRAIN.water_b]: 'pond-water',
  [TERRAIN.bridge]: 'wood-planks',
  [TERRAIN.stone_a]: 'cobblestone',
  [TERRAIN.stone_b]: 'cobblestone',
  [TERRAIN.stone_crack]: 'mossy-cobblestone',
  [TERRAIN.wall_stone]: 'shrine-stone',
  [TERRAIN.wall_moss]: 'mossy-cobblestone',
  [TERRAIN.roof]: 'dark-wood-planks',
  [TERRAIN.roof_edge]: 'dark-wood-planks',
  [TERRAIN.wall_house]: 'wood-planks',
  [TERRAIN.door]: 'dark-wood-planks',
  [TERRAIN.window]: 'dark-wood-planks',
  [TERRAIN.fence]: 'wood-planks',
  [TERRAIN.cobble]: 'cobblestone',
  [TERRAIN.cobble_moss]: 'mossy-cobblestone',
  [TERRAIN.planks]: 'wood-planks',
  [TERRAIN.planks_dark]: 'dark-wood-planks'
}

/**
 * The ground is drawn in chunks no larger than this many tiles a side, so a
 * big map (a Commons with many plots) never asks the GPU for a texture past
 * its size limit (often 4096 or 8192 px). 64 tiles = 1024 px. (The Wilds'
 * per-pixel woods floor; the village and Commons ground is a tilemap.)
 */
export const GROUND_CHUNK_TILES = 64

/** Tile rectangles covering a map in chunks of at most `max` tiles a side. */
export function groundChunks(width: number, height: number, max = GROUND_CHUNK_TILES): { tx: number; ty: number; tw: number; th: number }[] {
  const out: { tx: number; ty: number; tw: number; th: number }[] = []
  for (let ty = 0; ty < height; ty += max) for (let tx = 0; tx < width; tx += max) out.push({ tx, ty, tw: Math.min(max, width - tx), th: Math.min(max, height - ty) })
  return out
}

/** Texture key of the ground tileset built at boot (`groundTileset`). */
export const GROUND_TILESET_KEY = 'ground-tiles'
/** The path-edge overlays the tileset carries after the 16 terrain cells. */
const EDGE_FRAMES = (['cobble', 'dirt'] as const).flatMap((m) =>
  ['edge-n', 'edge-s', 'edge-e', 'edge-w', 'corner-ne', 'corner-nw', 'corner-se', 'corner-sw'].map((e) => `path-${m}-${e}`),
)
const TILESET_COLS = 8

/** The ground tileset: its texture key, cell size (texels), density and cell index by name. */
export interface GroundTileset {
  key: string
  cell: number
  density: number
  index: Map<string, number>
}

/**
 * Build (once) the ground tileset: the 16 terrain cells, then the path-edge
 * overlays that loaded, each `16 × density` texels, 1 texel apart with its
 * edge texels repeated into the gap (extruded), so nearest sampling at a
 * tile's edge never picks up its neighbour in the sheet.
 */
export function groundTileset(scene: Phaser.Scene): GroundTileset {
  const k = artDensity(scene)
  const cell = TILE * k
  const manifest = scene.cache.json.get('fingersnap-expansion-manifest') as { terrain: { tiles: Record<string, string> } } | null
  const names: string[] = []
  for (let i = 0; i < 16; i++) names.push(manifest?.terrain.tiles[i] ?? `cell-${i}`)
  const edges = EDGE_FRAMES.filter((f) => scene.textures.exists(`commons-art:${f}`))
  const index = new Map([...names, ...edges].map((n, i) => [n, i]))
  const key = GROUND_TILESET_KEY
  if (scene.textures.exists(key)) return { key, cell, density: k, index }
  const count = names.length + edges.length
  const rows = Math.ceil(count / TILESET_COLS)
  const step = cell + 2
  const canvas = document.createElement('canvas')
  canvas.width = TILESET_COLS * step
  canvas.height = rows * step
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  // The terrain sheet: 4×4 cells, at the density it was packed at.
  const sheet = scene.textures.exists('fingersnap-terrain-runtime') ? (scene.textures.get('fingersnap-terrain-runtime').getSourceImage() as HTMLImageElement | HTMLCanvasElement) : null
  const sheetCell = sheet ? sheet.width / 4 : 0
  const draw = (i: number, src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number) => {
    const x = (i % TILESET_COLS) * step + 1
    const y = Math.floor(i / TILESET_COLS) * step + 1
    resampleFor(ctx, sw, cell)
    ctx.drawImage(src, sx, sy, sw, sh, x, y, cell, cell)
    ctx.imageSmoothingEnabled = false
    // Extrude: the edge rows and columns, one texel out.
    ctx.drawImage(canvas, x, y, cell, 1, x, y - 1, cell, 1)
    ctx.drawImage(canvas, x, y + cell - 1, cell, 1, x, y + cell, cell, 1)
    ctx.drawImage(canvas, x, y - 1, 1, cell + 2, x - 1, y - 1, 1, cell + 2)
    ctx.drawImage(canvas, x + cell - 1, y - 1, 1, cell + 2, x + cell, y - 1, 1, cell + 2)
  }
  if (sheet) for (let i = 0; i < 16; i++) draw(i, sheet, (i % 4) * sheetCell, Math.floor(i / 4) * sheetCell, sheetCell, sheetCell)
  edges.forEach((f, j) => {
    const src = artSource(scene, `commons-art:${f}`)!
    draw(16 + j, src.image, 0, 0, src.image.width, src.image.height)
  })
  addArtCanvas(scene, key, canvas, 1)
  return { key, cell, density: k, index }
}

/**
 * The cells drawn on one tile, bottom first: its terrain (the water under
 * a bridge's planks), then the Commons' path edges.
 */
export function groundStack(world: WorldData, x: number, y: number, under: ReadonlyMap<string, number>, edges: boolean): string[] {
  const id = under.get(`${x},${y}`) ?? world.ground[y][x]
  const out = id === TERRAIN.bridge ? ['pond-water'] : []
  out.push(TERRAIN_TO_EXPANSION[id] ?? 'grass')
  if (edges) out.push(...pathEdgeOverlays(world, x, y))
  return out
}

/** Tiles a delivered building stands in for (only when its art loaded). */
function groundUnder(scene: Phaser.Scene, world: WorldData): Map<string, number> {
  const under = new Map<string, number>()
  for (const s of world.scenery ?? []) {
    const g = s.groundUnder
    if (!g || !scene.textures.exists(s.key)) continue
    for (let y = g.ty; y < g.ty + g.th; y++) for (let x = g.tx; x < g.tx + g.tw; x++) under.set(`${x},${y}`, g.tile)
  }
  return under
}

/**
 * Lay the area's ground. Returns a promise when its transitions are still
 * being painted (a first visit to an area: the scene holds its fade-in for
 * them), else null.
 */
export function buildGround(scene: Phaser.Scene, world: WorldData): Promise<void> | null {
  // The Wilds paint their woods floor per pixel (ragged path edges, shade).
  if (world.groundStyle) {
    buildTangleGround(scene, world)
    return null
  }
  if (scene.textures.exists(GROUND_PACKED_KEY) && (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest | undefined)?.ground) return buildTiledGround(scene, world)
  const ts = groundTileset(scene)
  const under = groundUnder(scene, world)
  const edges = world.areaId === 'commons'
  const stacks = world.ground.map((row, y) => row.map((_, x) => groundStack(world, x, y, under, edges).map((n) => ts.index.get(n) ?? -1).filter((i) => i >= 0)))
  const depth = Math.max(1, ...stacks.flat().map((s) => s.length))
  const map = scene.make.tilemap({ width: world.width, height: world.height, tileWidth: ts.cell, tileHeight: ts.cell })
  const tiles = map.addTilesetImage(ts.key, ts.key, ts.cell, ts.cell, 1, 2)
  if (!tiles) return null
  // Dense cells: decide sampling ties one way (TIE_BIAS), or the ground shimmers as the camera moves.
  if (ts.density > 1) for (const c of tiles.texCoordinates as { x: number; y: number }[]) {
    c.x += TIE_BIAS
    c.y += TIE_BIAS
  }
  for (let l = 0; l < depth; l++) {
    const layer = map.createBlankLayer(`ground-${l}`, tiles)
    if (!layer) continue
    layer.putTilesAt(stacks.map((row) => row.map((s) => s[l] ?? -1)), 0, 0, false)
    layer.setScale(1 / ts.density).setDepth(-10)
  }
  return null
}

const GRASSY = new Set<number>([TERRAIN.grass_a, TERRAIN.grass_b, TERRAIN.grass_c, TERRAIN.flowers])
const PATH_MATERIAL: Record<number, 'dirt' | 'cobble'> = {
  [TERRAIN.dirt]: 'dirt',
  [TERRAIN.path_a]: 'dirt',
  [TERRAIN.path_b]: 'dirt',
  [TERRAIN.cobble]: 'cobble',
  [TERRAIN.cobble_moss]: 'cobble'
}

/**
 * The Commons pass's 16-px path-to-grass transitions: each grass tile
 * beside a dirt or cobble tile takes the overlay with material on that side
 * (`edge-n`: material in its north half), and a corner overlay where the
 * path only touches it diagonally. The expansion's path tiles have grass
 * baked in, so without these the lanes stop on a hard tile edge. Skipped
 * when the pack didn't load.
 */
export function pathEdgeOverlays(world: Pick<WorldData, 'ground' | 'width' | 'height'>, x: number, y: number): string[] {
  const at = (tx: number, ty: number) => (tx < 0 || ty < 0 || tx >= world.width || ty >= world.height ? undefined : PATH_MATERIAL[world.ground[ty][tx]])
  if (!GRASSY.has(world.ground[y][x])) return []
  const out: string[] = []
  for (const m of ['cobble', 'dirt'] as const) {
    const n = at(x, y - 1) === m
    const s = at(x, y + 1) === m
    const e = at(x + 1, y) === m
    const w = at(x - 1, y) === m
    if (n) out.push(`path-${m}-edge-n`)
    if (s) out.push(`path-${m}-edge-s`)
    if (e) out.push(`path-${m}-edge-e`)
    if (w) out.push(`path-${m}-edge-w`)
    if (!n && !e && at(x + 1, y - 1) === m) out.push(`path-${m}-corner-ne`)
    if (!n && !w && at(x - 1, y - 1) === m) out.push(`path-${m}-corner-nw`)
    if (!s && !e && at(x + 1, y + 1) === m) out.push(`path-${m}-corner-se`)
    if (!s && !w && at(x - 1, y + 1) === m) out.push(`path-${m}-corner-sw`)
  }
  return out
}

// ---------------------------------------------------------------- the playtest-1 ground

/** Texture key of the packed playtest-1 ground tiles (../packed.ts loads it). */
export const GROUND_PACKED_KEY = 'packed-ground'

/** What a built ground holds, for playtests (`__fsGround`). */
export interface GroundView {
  cells: number
  edges: number
  animated: number
  tileset: [number, number]
  density: number
  /** The area painted, and whether its transitions are all in (they're painted off the main thread). */
  area: string
  complete: boolean
}
let lastView: GroundView | null = null
export function groundView(): GroundView | null {
  return lastView
}

/**
 * The village, the Commons and the other tiled areas on the playtest-1
 * ground (./ground-field.ts): a tileset built for this area at the art's
 * density — the 23 base tiles, the 16 old expansion cells (walls, roofs,
 * fences, planks), and the transition overlays this map's neighbourhoods
 * need, painted here — laid out as a tilemap: base, overlay, then the
 * planks of a bridge. Water and the overlays that show it animate by
 * swapping their cells' texture coordinates (no texture upload).
 *
 * A painted ground tileset is kept across scene builds: the paint is a pure
 * function of the map's ground (and the art packs), so an unchanged map
 * reuses the canvas instead of repainting it. Repainting was seconds of
 * main-thread work on the Commons (hundreds of painted edge overlays), and
 * every scene build and rebuild paid it — a placed shelf froze the lane
 * for seconds.
 */
interface PaintedTileset {
  canvas: HTMLCanvasElement
  names: string[]
  index: Map<string, number>
  animated: { index: number; frames: number }[]
  edgeCount: number
  /** The transitions are in (painted off the main thread after the base tiles). */
  complete: boolean
  done: Promise<void>
}
/** Recent tilesets, keyed by the paint's inputs (a player visits a few areas). */
const paintedTilesets = new Map<string, PaintedTileset>()
const PAINTED_TILESETS = 4
/** The signature of the canvas the `GROUND_TILESET_KEY` texture holds now. */
let textureSig: string | null = null

/**
 * Everything the painted tileset depends on, as one string: the density,
 * the art (the ground pack's tiles and image, the old terrain sheet and
 * its cell names, the tile lists this build draws), and the map's ground
 * with any building's ground under it. The paint itself is a pure function
 * of these (ground-field.ts); a stale cache would show old ground.
 */
function tilesetSignature(world: WorldData, under: Map<string, number>, k: number, oldNames: string[], sheet: HTMLImageElement | HTMLCanvasElement | null, packed: PackedManifest['ground']): string {
  const parts: string[] = [
    String(k),
    sheet ? `${sheet.width}x${sheet.height}` : 'no-sheet',
    oldNames.join(','),
    JSON.stringify(packed),
    GROUND_TILES.join(','),
    WATER_SETS.map((s) => s.join(',')).join(';'),
    Object.values(EDGE_TEXTURE).join(','),
  ]
  for (const row of world.ground) parts.push(row.join('.'))
  for (const [p, v] of [...under.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) parts.push(`${p}=${v}`)
  return parts.join('|')
}

function buildTiledGround(scene: Phaser.Scene, world: WorldData): Promise<void> | null {
  const k = artDensity(scene)
  const cell = TILE * k
  const packed = (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest).ground
  const under = groundUnder(scene, world)
  const idAt = (x: number, y: number) => under.get(`${x},${y}`) ?? world.ground[y][x]
  const ground = world.ground.map((row, y) => row.map((_, x) => idAt(x, y)))
  const grid = classGrid(ground)

  // Every tile's stack, by cell name; and the overlays this map needs.
  const edges = new Map<string, boolean>()
  const stacks: string[][][] = ground.map((row, y) =>
    row.map((id, x) => {
      const base = baseTile(id, grid[y][x], x, y)
      const old = TERRAIN_TO_EXPANSION[id] ?? 'grass'
      const out = [base ?? `old:${old}`]
      const key = edgeKey(neighbourhood(grid, x, y), x, y)
      if (key) {
        edges.set(key, edgeHasWater(parseEdgeKey(key).n))
        out.push(`edge:${key}`)
      }
      if (id === TERRAIN.bridge) out.push(`old:${old}`)
      return out
    }),
  )

  // The tileset's cells: the base tiles, the old cells, then each overlay (×4 when it shows water).
  const manifest = scene.cache.json.get('fingersnap-expansion-manifest') as { terrain: { tiles: Record<string, string> } } | null
  const oldNames = Array.from({ length: 16 }, (_, i) => manifest?.terrain.tiles[i] ?? `cell-${i}`)
  const sheet = scene.textures.exists('fingersnap-terrain-runtime') ? (scene.textures.get('fingersnap-terrain-runtime').getSourceImage() as HTMLImageElement | HTMLCanvasElement) : null
  const sig = tilesetSignature(world, under, k, oldNames, sheet, packed)
  let painted = paintedTilesets.get(sig)
  if (painted) {
    // Refresh the recency order.
    paintedTilesets.delete(sig)
    paintedTilesets.set(sig, painted)
  } else {
    const eldest = paintedTilesets.keys().next()
    if (paintedTilesets.size >= PAINTED_TILESETS && !eldest.done) paintedTilesets.delete(eldest.value)
    painted = paintTileset(scene, packed, sheet, oldNames, edges, cell, k)
    paintedTilesets.set(sig, painted)
    // The transitions arrive from the painters: show them if this tileset is still the one in use.
    const mine = painted
    void mine.done.then(() => {
      if (textureSig !== sig || !scene.sys?.game || !scene.textures.exists(GROUND_TILESET_KEY)) return
      ;(scene.textures.get(GROUND_TILESET_KEY) as Phaser.Textures.CanvasTexture).refresh?.()
      if (lastView && lastView.area === world.areaId) lastView = { ...lastView, complete: true }
    })
  }
  const { canvas, names, index, animated, edgeCount } = painted

  // A texture is the game's own (scenes come and go): (re)add the painted
  // canvas unless the texture under the key already shows it.
  if (!scene.textures.exists(GROUND_TILESET_KEY) || textureSig !== sig) {
    addArtCanvas(scene, GROUND_TILESET_KEY, canvas, 1)
    textureSig = sig
  }

  const depth = Math.max(...stacks.flat().map((s) => s.length))
  const map = scene.make.tilemap({ width: world.width, height: world.height, tileWidth: cell, tileHeight: cell })
  const tiles = map.addTilesetImage(GROUND_TILESET_KEY, GROUND_TILESET_KEY, cell, cell, 1, 2)
  if (!tiles) return null
  const coords = tiles.texCoordinates as { x: number; y: number }[]
  if (k > 1) for (const c of coords) {
    c.x += TIE_BIAS
    c.y += TIE_BIAS
  }
  for (let l = 0; l < depth; l++) {
    const layer = map.createBlankLayer(`ground-${l}`, tiles)
    if (!layer) continue
    layer.putTilesAt(stacks.map((row) => row.map((s) => (s[l] ? index.get(s[l]) ?? -1 : -1))), 0, 0, false)
    layer.setScale(1 / k).setDepth(-10)
  }
  lastView = { cells: names.length, edges: edgeCount, animated: animated.length, tileset: [canvas.width, canvas.height], density: k, area: world.areaId, complete: painted.complete }
  // Read-only, for playtests.
  ;(window as unknown as { __fsGround?: () => GroundView | null }).__fsGround = groundView
  const pending = painted.complete ? null : painted.done
  // Water: each animated cell shows its frame f's texture coordinates.
  if (prefersReducedMotion()) return pending
  const frames = animated.map((a) => Array.from({ length: a.frames }, (_, f) => coords[a.index + f]))
  let f = 0
  scene.time.addEvent({
    delay: 1000 / WATER_FPS,
    loop: true,
    callback: () => {
      f++
      animated.forEach((a, i) => (coords[a.index] = frames[i][f % a.frames]))
    },
  })
  return pending
}

/**
 * The base and old cells at density `k`, each extruded into a `cell + 2`
 * block: drawn once per page and density (the same for every area), then
 * copied into each area's tileset.
 */
let baseCache: { sig: string; blocks: Uint8ClampedArray[] } | null = null
function baseBlocks(pack: HTMLImageElement | HTMLCanvasElement, packed: PackedManifest['ground'], sheet: HTMLImageElement | HTMLCanvasElement | null, cell: number): Uint8ClampedArray[] {
  const sig = `${cell}|${JSON.stringify(packed)}|${sheet ? `${sheet.width}x${sheet.height}` : '-'}`
  if (baseCache?.sig === sig) return baseCache.blocks
  const count = GROUND_TILES.length + 16
  const step = cell + 2
  const canvas = document.createElement('canvas')
  canvas.width = count * step
  canvas.height = step
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = false
  const draw = (i: number, src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number) => {
    resampleFor(ctx, sw, cell)
    ctx.drawImage(src, sx, sy, sw, sh, i * step + 1, 1, cell, cell)
    ctx.imageSmoothingEnabled = false
  }
  GROUND_TILES.forEach((name, i) => {
    const at = packed.tiles[name]
    draw(i, pack, (at % packed.cols) * packed.cell, Math.floor(at / packed.cols) * packed.cell, packed.cell, packed.cell)
  })
  if (sheet) {
    const sc = sheet.width / 4
    for (let i = 0; i < 16; i++) draw(GROUND_TILES.length + i, sheet, (i % 4) * sc, Math.floor(i / 4) * sc, sc, sc)
  }
  const strip: Texels = { w: canvas.width, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data }
  const blocks: Uint8ClampedArray[] = []
  for (let i = 0; i < count; i++) {
    extrude(strip, i * step + 1, 1, cell)
    const block = new Uint8ClampedArray(step * step * 4)
    for (let r = 0; r < step; r++) block.set(strip.data.subarray((r * strip.w + i * step) * 4, (r * strip.w + (i + 1) * step) * 4), r * step * 4)
    blocks.push(block)
  }
  baseCache = { sig, blocks }
  return blocks
}

/** Ground-painting workers (made on first use; none where workers don't run). */
let workers: Worker[] | null = null
let nextJob = 0
function painters(): Worker[] {
  if (workers) return workers
  workers = []
  try {
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))
    for (let i = 0; i < n; i++) workers.push(new Worker(new URL('./ground-worker.ts', import.meta.url), { type: 'module' }))
  } catch {
    workers = []
  }
  return workers
}

/** Paint overlay jobs in the workers, or (no workers) in slices on the main thread. */
function paintJobs(jobs: EdgeJob[], refs: Record<string, Uint8ClampedArray>, k: number, onCells: (cells: { i: number; rgba: Uint8ClampedArray }[]) => void): Promise<void> {
  const pool = forceMainThread ? [] : painters()
  if (pool.length === 0) {
    // Slices of about a frame's worth, so the page keeps drawing.
    return new Promise((resolve) => {
      let at = 0
      const slice = () => {
        const t0 = performance.now()
        while (at < jobs.length && performance.now() - t0 < 12) onCells(paintEdgeJobs([jobs[at++]], refs, k))
        if (at < jobs.length) setTimeout(slice, 0)
        else resolve()
      }
      slice()
    })
  }
  // Round-robin batches, so each worker gets a share of every kind of edge.
  const batches: EdgeJob[][] = pool.map(() => [])
  jobs.forEach((j, n) => batches[n % pool.length].push(j))
  return Promise.all(
    pool.map(
      (w, n) =>
        new Promise<void>((resolve, reject) => {
          const id = ++nextJob
          const onMessage = (e: MessageEvent<{ id: number; cells: { i: number; rgba: Uint8ClampedArray }[] }>) => {
            if (e.data.id !== id) return
            w.removeEventListener('message', onMessage)
            w.removeEventListener('error', onError)
            onCells(e.data.cells)
            resolve()
          }
          const onError = (e: ErrorEvent) => {
            w.removeEventListener('message', onMessage)
            w.removeEventListener('error', onError)
            reject(e.error ?? new Error(e.message))
          }
          w.addEventListener('message', onMessage)
          w.addEventListener('error', onError)
          w.postMessage({ id, jobs: batches[n], refs, k })
        }),
    ),
  ).then(
    () => undefined,
    () => {
      // A worker failed: paint everything here instead.
      workers = []
      return paintJobs(jobs, refs, k, onCells)
    },
  )
}

/** Dev only: paint on the main thread (the playtests compare it with the workers' paint). */
let forceMainThread = false

/**
 * Paint the tileset canvas for one map: the base tiles and old cells now
 * (copied from `baseBlocks`, one `putImageData`), then each edge overlay in
 * the painters; `done` resolves once they're all in the canvas (one more
 * `putImageData` of the overlays' rows).
 */
function paintTileset(
  scene: Phaser.Scene,
  packed: PackedManifest['ground'],
  sheet: HTMLImageElement | HTMLCanvasElement | null,
  oldNames: string[],
  edges: Map<string, boolean>,
  cell: number,
  k: number,
): PaintedTileset {
  const names: string[] = [...GROUND_TILES, ...oldNames.map((n) => `old:${n}`)]
  const animated: { index: number; frames: number }[] = []
  const edgeStart = new Map<string, number>()
  for (const [key, water] of edges) {
    edgeStart.set(key, names.length)
    if (water) animated.push({ index: names.length, frames: WATER_FRAMES.length })
    for (let f = 0; f < (water ? WATER_FRAMES.length : 1); f++) names.push(`edge:${key}${water ? `@${f}` : ''}`)
  }
  const index = new Map(names.map((n, i) => [n, i]))
  for (const [key, start] of edgeStart) index.set(`edge:${key}`, start)
  for (const set of WATER_SETS) animated.push({ index: index.get(set[0])!, frames: set.length })

  const cols = Math.ceil(Math.sqrt(names.length))
  const rows = Math.ceil(names.length / cols)
  const step = cell + 2
  const canvas = document.createElement('canvas')
  canvas.width = cols * step
  canvas.height = rows * step
  const ctx = canvas.getContext('2d')!
  const origin = (i: number): [number, number] => [(i % cols) * step + 1, Math.floor(i / cols) * step + 1]
  const tileset: Texels = { w: canvas.width, data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }

  const pack = scene.textures.get(GROUND_PACKED_KEY).getSourceImage() as HTMLImageElement | HTMLCanvasElement
  const blocks = baseBlocks(pack, packed, sheet, cell)
  const baseCount = sheet ? blocks.length : GROUND_TILES.length
  for (let i = 0; i < baseCount; i++) {
    const [x, y] = origin(i)
    for (let r = 0; r < step; r++) tileset.data.set(blocks[i].subarray(r * step * 4, (r + 1) * step * 4), ((y - 1 + r) * tileset.w + x - 1) * 4)
  }
  const image = new ImageData(tileset.data, canvas.width, canvas.height)
  ctx.putImageData(image, 0, 0)

  const painted: PaintedTileset = { canvas, names, index, animated, edgeCount: edges.size, complete: false, done: Promise.resolve() }
  const jobs: EdgeJob[] = []
  for (const [key, water] of edges) for (let f = 0; f < (water ? WATER_FRAMES.length : 1); f++) jobs.push({ key, f, i: edgeStart.get(key)! + f })
  if (jobs.length === 0) {
    painted.complete = true
    return painted
  }
  // The overlays' reference textures: the base cells' insides.
  const refs: Record<string, Uint8ClampedArray> = {}
  for (const name of edgeRefNames()) {
    const block = blocks[GROUND_TILES.indexOf(name)]
    const t = new Uint8ClampedArray(cell * cell * 4)
    for (let r = 0; r < cell; r++) t.set(block.subarray(((r + 1) * step + 1) * 4, ((r + 1) * step + 1 + cell) * 4), r * cell * 4)
    refs[name] = t
  }
  painted.done = paintJobs(jobs, refs, k, (cells) => {
    for (const c of cells) {
      const [x, y] = origin(c.i)
      putCell(tileset, x, y, cell, c.rgba)
    }
  }).then(() => {
    // Only the overlays' rows changed.
    const top = origin(jobs[0].i)[1] - 1
    ctx.putImageData(image, 0, 0, 0, top, canvas.width, canvas.height - top)
    painted.complete = true
  })
  return painted
}

/** Dev only: paint this map's tileset again on the main thread and return its texels' hash. */
export async function devMainThreadTilesetHash(scene: Phaser.Scene, world: WorldData): Promise<string | null> {
  if (!scene.textures.exists(GROUND_PACKED_KEY)) return null
  const k = artDensity(scene)
  const packed = (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest).ground
  const under = groundUnder(scene, world)
  const ground = world.ground.map((row, y) => row.map((_, x) => under.get(`${x},${y}`) ?? world.ground[y][x]))
  const grid = classGrid(ground)
  const edges = new Map<string, boolean>()
  ground.forEach((row, y) =>
    row.forEach((_, x) => {
      const key = edgeKey(neighbourhood(grid, x, y), x, y)
      if (key) edges.set(key, edgeHasWater(parseEdgeKey(key).n))
    }),
  )
  const manifest = scene.cache.json.get('fingersnap-expansion-manifest') as { terrain: { tiles: Record<string, string> } } | null
  const oldNames = Array.from({ length: 16 }, (_, i) => manifest?.terrain.tiles[i] ?? `cell-${i}`)
  const sheet = scene.textures.exists('fingersnap-terrain-runtime') ? (scene.textures.get('fingersnap-terrain-runtime').getSourceImage() as HTMLImageElement | HTMLCanvasElement) : null
  forceMainThread = true
  try {
    const p = paintTileset(scene, packed, sheet, oldNames, edges, TILE * k, k)
    await p.done
    const c = p.canvas
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    let h = 2166136261
    for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619)
    return `${c.width}x${c.height}:${(h >>> 0).toString(16)}`
  } finally {
    forceMainThread = false
  }
}
