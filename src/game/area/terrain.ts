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

export function buildGround(scene: Phaser.Scene, world: WorldData): void {
  // The Wilds paint their woods floor per pixel (ragged path edges, shade).
  if (world.groundStyle) return buildTangleGround(scene, world)
  const ts = groundTileset(scene)
  // Tiles a delivered building stands in for (only when its art loaded).
  const under = new Map<string, number>()
  for (const s of world.scenery ?? []) {
    const g = s.groundUnder
    if (!g || !scene.textures.exists(s.key)) continue
    for (let y = g.ty; y < g.ty + g.th; y++) for (let x = g.tx; x < g.tx + g.tw; x++) under.set(`${x},${y}`, g.tile)
  }
  const edges = world.areaId === 'commons'
  const stacks = world.ground.map((row, y) => row.map((_, x) => groundStack(world, x, y, under, edges).map((n) => ts.index.get(n) ?? -1).filter((i) => i >= 0)))
  const depth = Math.max(1, ...stacks.flat().map((s) => s.length))
  const map = scene.make.tilemap({ width: world.width, height: world.height, tileWidth: ts.cell, tileHeight: ts.cell })
  const tiles = map.addTilesetImage(ts.key, ts.key, ts.cell, ts.cell, 1, 2)
  if (!tiles) return
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
