/**
 * The playtest-1 ground pack's tiles (no imports: the ground-painting
 * worker, src/game/area/ground-worker.ts, loads this). Re-exported by
 * ./atlas-plan.ts.
 */

/**
 * The playtest-1 ground tiles by family, each family's tiles healed against
 * its first: every tile of a family then shares its border texels
 * (./ground-heal.ts). Flowered grass and moss heal against the grass, so the
 * accents fade into it at their edges; water's frames are one tile each.
 * `flatten` evens out a family's broad shading first (dirt and sand are
 * painted with light and dark patches that line up into stripes).
 */
export const GROUND_FAMILIES: { name: string; tiles: string[]; flatten?: number }[] = [
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
  { name: 'water-beds', tiles: ['ground-water-bed-variant-01', 'ground-water-bed-variant-02', 'ground-water-bed-variant-03'], flatten: 0.9 },
]
/** The gentle water's animation frames (3 fps). */
export const GROUND_WATER_FRAMES = ['ground-water-gentle-0', 'ground-water-gentle-1', 'ground-water-gentle-2', 'ground-water-gentle-3', 'ground-water-gentle-4']
/**
 * The water beds are delivered still. The build animates them: each frame
 * is the bed plus that gentle-water frame's departure from the frames' mean
 * (the moving light, its stones cancelled), named `<bed>@<frame>`. So every
 * water tile ripples in step and the stones vary from tile to tile.
 */
export const GROUND_WATER_BEDS = ['ground-water-bed-variant-01', 'ground-water-bed-variant-02', 'ground-water-bed-variant-03']
export const bedFrame = (bed: string, f: number) => `${bed}@${f}`
/** Every ground tile, in pack order (the animated beds after the delivered tiles). */
export const GROUND_TILES = [
  ...GROUND_FAMILIES.flatMap((f) => f.tiles),
  ...GROUND_WATER_BEDS.flatMap((b) => GROUND_WATER_FRAMES.map((_, f) => bedFrame(b, f))),
]
/** The delivered tiles the build samples (the rest are made from them). */
export const GROUND_DELIVERED = GROUND_FAMILIES.flatMap((f) => f.tiles)
/** Ground pack grid width (cells). */
export const GROUND_COLS = 6

