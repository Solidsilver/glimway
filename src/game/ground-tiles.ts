/**
 * The playtest-1 ground pack's tiles (no imports: the ground-painting
 * worker, src/game/area/ground-worker.ts, loads this). Re-exported by
 * ./atlas-plan.ts.
 */

/**
 * The pond: one seamless 256×256-texel bed (`pond-bed-seamless`) cut into
 * 4×4 tiles, `ground-pond-<x>-<y>`. A water tile shows the bed tile its
 * position picks (x mod 4, y mod 4), so the stones run on across tile
 * borders with no grid. The bed is delivered still; at boot each tile gets
 * five frames (`<tile>@<f>`): the tile plus that gentle-water frame's
 * departure from the frames' mean (the moving light, its own stones
 * cancelled), so all the water ripples in step.
 */
export const POND_SOURCE = 'pond-bed-seamless'
export const POND_SIZE = 4
export const pondTile = (x: number, y: number) => `ground-pond-${((x % POND_SIZE) + POND_SIZE) % POND_SIZE}-${((y % POND_SIZE) + POND_SIZE) % POND_SIZE}`
export const POND_TILES = Array.from({ length: POND_SIZE * POND_SIZE }, (_, i) => pondTile(i % POND_SIZE, Math.floor(i / POND_SIZE)))
export const pondFrame = (tile: string, f: number) => `${tile}@${f}`

/**
 * The playtest-1 ground tiles by family, each family's tiles healed against
 * its first: every tile of a family then shares its border texels
 * (./ground-heal.ts). Flowered grass and moss heal against the grass, so the
 * accents fade into it at their edges; water's frames are one tile each.
 * `flatten` evens out a family's broad shading first (dirt and sand are
 * painted with light and dark patches that line up into stripes).
 */
export const GROUND_FAMILIES: { name: string; tiles: string[]; flatten?: number; heal?: boolean }[] = [
  {
    name: 'grass',
    tiles: [
      'ground-grass-01', 'ground-grass-02', 'ground-grass-03', 'ground-grass-04',
      'ground-flowered-grass-01', 'ground-flowered-grass-02',
      'ground-forest-moss-01', 'ground-forest-moss-02',
    ],
  },
  { name: 'dirt', tiles: ['ground-packed-dirt-01', 'ground-packed-dirt-02', 'ground-packed-dirt-03'], flatten: 0.8 },
  { name: 'road', tiles: ['ground-old-cobbled-road-01', 'ground-old-cobbled-road-02', 'ground-old-cobbled-road-03'], flatten: 0.4 },
  { name: 'farmland', tiles: ['ground-farmland-rows-01', 'ground-farmland-rows-02'] },
  { name: 'flagstones', tiles: ['ground-village-flagstones-01', 'ground-village-flagstones-03', 'ground-village-flagstones-04'], flatten: 0.4 },
  { name: 'sand', tiles: ['ground-sand-by-water-01', 'ground-sand-by-water-03'], flatten: 0.8 },
  { name: 'water-0', tiles: ['ground-water-gentle-0'] },
  { name: 'water-1', tiles: ['ground-water-gentle-1'] },
  { name: 'water-2', tiles: ['ground-water-gentle-2'] },
  { name: 'water-3', tiles: ['ground-water-gentle-3'] },
  { name: 'water-4', tiles: ['ground-water-gentle-4'] },
  // The pond bed is seamless as delivered: its 16 tiles are cut, never healed.
  { name: 'pond', tiles: POND_TILES, heal: false },
]
/** The gentle water's animation frames (3 fps). */
export const GROUND_WATER_FRAMES = ['ground-water-gentle-0', 'ground-water-gentle-1', 'ground-water-gentle-2', 'ground-water-gentle-3', 'ground-water-gentle-4']
/** Every ground tile the pack holds, in pack order (the pond's frames are made at boot). */
export const GROUND_TILES = GROUND_FAMILIES.flatMap((f) => f.tiles)
/** Ground pack grid width (cells). */
export const GROUND_COLS = 6
