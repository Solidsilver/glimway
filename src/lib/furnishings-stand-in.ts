/**
 * STAND-IN for lane A's furnishings catalogue (docs/design/indoors.md 2.8):
 * `content/furnishings.json`, `validateFurnishings` and `canPlace`, and the
 * rooms' placements by id in `content/rooms.json`. The shapes follow 2.8 so
 * the game's side (drawing by facing, state and parent; base-box collision)
 * switches over by changing imports. Delete this file then.
 *
 * Two things here 2.8 doesn't spell out, asked of lane A in the report: a
 * surface's `height` (px above the piece's foot, where pieces on it stand)
 * and a piece's `variants` (the same piece painted twice, picked per spot).
 */

export type Facing = 'front' | 'left' | 'right' | 'diag'
export type Mount = 'floor' | 'wall' | 'surface'
export type Size = 'small' | 'medium' | 'large'

export interface FurnishingState {
  /** Frames (indoors-pass frame names); one is a still state. */
  frames: string[]
  /** A slow loop (frames a second); only working machines and what a quest points at play it. */
  loop?: number
}

export interface Furnishing {
  id: string
  name: string
  /** Art per facing it has (a frame name; missing art draws the kit's placeholder). */
  art: Partial<Record<Facing, string>>
  /** Footprint in tiles. */
  footprint: [number, number]
  /** What touches what it stands on: [w, h] px, centred on the footprint's bottom edge. Collision uses only this. */
  base: [number, number]
  mount: Mount
  /** Lies under everything and never blocks (a rug). */
  layer?: 'under'
  /** Surfaces it offers: slots for small items, and how high (px above its foot) things stand on it. */
  offers?: { top?: { slots: number; height: number }; shelves?: { slots: number; height: number } }
  size: Size
  states?: Record<string, FurnishingState>
  /** The default state. */
  state?: string
  variants?: string[]
  tags?: string[]
}

export interface Placement {
  piece: string
  /** The footprint's top-left tile (a piece on a parent: ignored, it stands on the parent). */
  tx: number
  ty: number
  facing?: Facing
  /** Index of the placement it stands on (a candle on a table), in the same room's list. */
  parent?: number
  /** Which of the parent's slots, left to right. */
  slot?: number
  /** Signature pieces are the room's props (rooms.json `props`, by art name); dressing is everything else and never blocks. */
  dressing?: boolean
}

const f = (id: string, name: string, art: Partial<Record<Facing, string>>, footprint: [number, number], base: [number, number], more: Partial<Furnishing> = {}): Furnishing => ({
  id,
  name,
  art,
  footprint,
  base,
  mount: 'floor',
  size: 'large',
  ...more
})

export const FURNISHINGS: readonly Furnishing[] = [
  // ---- the rooms' signature pieces (rooms.json props name these by art)
  f('kitchen-hearth', 'Bread oven and hearth', { front: 'oven-hearth-fire-0' }, [3, 2], [46, 12], {
    states: { lit: { frames: ['oven-hearth-fire-0', 'oven-hearth-fire-1', 'oven-hearth-fire-2', 'oven-hearth-fire-3'], loop: 2 }, banked: { frames: ['oven-hearth-fire-0'] } },
    state: 'lit',
    tags: ['light', 'hearth']
  }),
  f('kitchen-crocks', 'Shelves of crocks', { front: 'crock-shelves' }, [2, 1], [28, 6], { offers: { shelves: { slots: 4, height: 18 } } }),
  f('kitchen-tallow-pot', 'Tallow pot on its stand', { front: 'tallow-pot-steam-0' }, [2, 1], [18, 6], {
    states: { still: { frames: ['tallow-pot-steam-0'] }, steaming: { frames: ['tallow-pot-steam-0', 'tallow-pot-steam-1', 'tallow-pot-steam-2'], loop: 2 } },
    state: 'still'
  }),
  f('kitchen-worktable', 'Worktable', { front: 'worktable' }, [4, 2], [44, 18], { offers: { top: { slots: 4, height: 18 } } }),
  f('kitchen-sponge-bowl', 'Sponge bowl on a stool', { front: 'sponge-bowl-flat' }, [1, 1], [10, 5], {
    states: { flat: { frames: ['sponge-bowl-flat'] }, risen: { frames: ['sponge-bowl-risen'] } },
    state: 'flat',
    size: 'medium'
  }),
  f('kitchen-bread-rack', 'Bread rack', { front: 'bread-rack' }, [1, 1], [12, 5], { offers: { shelves: { slots: 2, height: 10 } } }),
  f('mill-gears', 'Gear train', { front: 'gear-train-0' }, [3, 2], [44, 12], {
    states: { turning: { frames: ['gear-train-0', 'gear-train-1', 'gear-train-2', 'gear-train-3'], loop: 2 }, still: { frames: ['gear-train-0'] } },
    state: 'turning'
  }),
  f('millstones', 'Millstones under the hopper', { front: 'millstones-0' }, [2, 2], [26, 16], {
    states: { turning: { frames: ['millstones-0', 'millstones-1', 'millstones-2', 'millstones-3'], loop: 2 }, still: { frames: ['millstones-0'] } },
    state: 'turning'
  }),
  f('mill-chute', 'Chute and meal bin', { front: 'chute-meal-bin-0' }, [2, 2], [26, 14]),
  f('flour-sacks', 'Flour sacks', { front: 'flour-sacks-0' }, [2, 2], [24, 12], { variants: ['flour-sacks-0', 'flour-sacks-1'] }),
  f('counting-stool', 'Counting stool', { front: 'counting-stool-window' }, [1, 1], [10, 5], { tags: ['seat'] }),
  f('mill-hoist', 'Sack hoist and hatch', { front: 'sack-hoist-seized' }, [2, 2], [26, 10], {
    states: { seized: { frames: ['sack-hoist-seized'] }, working: { frames: ['sack-hoist-working'] }, swinging: { frames: ['sack-hoist-swing-0', 'sack-hoist-swing-1', 'sack-hoist-swing-2'], loop: 2 } },
    state: 'seized'
  }),
  f('library-shelves', 'Tall bookshelf', { front: 'library-shelf-1' }, [2, 1], [28, 6], {
    states: { sparse: { frames: ['library-shelf-0'] }, half: { frames: ['library-shelf-1'] }, full: { frames: ['library-shelf-2'] } },
    state: 'half',
    offers: { shelves: { slots: 6, height: 24 } },
    tags: ['books']
  }),
  f('reading-table', 'Reading table', { front: 'reading-table-unlit' }, [4, 2], [52, 18], {
    states: { unlit: { frames: ['reading-table-unlit'] }, lit: { frames: ['reading-table-lit'] } },
    state: 'unlit',
    offers: { top: { slots: 4, height: 18 } },
    tags: ['seat', 'light']
  }),
  f('window-seat', 'Window seat', { front: 'window-seat' }, [2, 1], [28, 8], { tags: ['seat'] }),
  // The library as revised (3.3): shelves along the side walls, side-on (Luna's art to come), the nook, Elara's desk.
  f('library-side-shelves', 'Side bookshelves', {}, [1, 4], [12, 60], { offers: { shelves: { slots: 8, height: 24 } }, tags: ['books'] }),
  f('reading-nook', 'Reading nook', { front: 'window-seat' }, [3, 2], [44, 10], { tags: ['seat', 'light'] }),
  f('elara-desk', 'Elara’s desk', {}, [2, 1], [28, 8], { offers: { top: { slots: 2, height: 14 } }, tags: ['books'] }),

  // ---- the shared interior kit (placeholders until Luna's kit lands on exp/in-art)
  // The pass's rug frames are cut across their neighbours (.agent/ART-FIXES.md): the kit's placeholder until the kit lands.
  f('rug-rag', 'Rag rug', {}, [3, 2], [0, 0], { layer: 'under' }),
  f('rug-round', 'Braided round rug', {}, [3, 2], [0, 0], { layer: 'under' }),
  f('crate', 'Crate', {}, [1, 1], [12, 8], { size: 'medium', offers: { top: { slots: 1, height: 10 } } }),
  f('barrel', 'Barrel', {}, [1, 1], [12, 8], { size: 'medium' }),
  f('sack', 'Sack', {}, [1, 1], [10, 6], { size: 'medium' }),
  f('basket', 'Basket', {}, [1, 1], [10, 5], { size: 'medium' }),
  f('plant-pot', 'Potted plant', {}, [1, 1], [6, 3], { size: 'small' }),
  f('lamp', 'Lamp', {}, [1, 1], [6, 3], { size: 'medium', tags: ['light'] }),
  f('candle', 'Candle', {}, [1, 1], [3, 2], { size: 'small', tags: ['light'] }),
  f('book-stack', 'Stack of books', {}, [1, 1], [6, 3], { size: 'small', tags: ['books'] }),
  f('cup', 'Cup', {}, [1, 1], [3, 2], { size: 'small' }),
  f('wall-pegs', 'Wall pegs with tools', {}, [2, 1], [0, 0], { mount: 'wall' }),
  f('wall-shelf', 'Wall shelf', {}, [2, 1], [0, 0], { mount: 'wall', offers: { shelves: { slots: 3, height: 0 } } }),
  f('picture', 'Picture', {}, [1, 1], [0, 0], { mount: 'wall' }),
  f('calendar', 'Calendar', {}, [1, 1], [0, 0], { mount: 'wall' }),
  f('cap-on-peg', 'Cap on a peg', {}, [1, 1], [0, 0], { mount: 'wall' }),
  f('small-table', 'Small table', {}, [1, 1], [12, 8], { offers: { top: { slots: 2, height: 10 } } }),
  f('chair', 'Chair', {}, [1, 1], [10, 6], { tags: ['seat'] }),
  f('stool', 'Stool', {}, [1, 1], [8, 5], { tags: ['seat'] }),
  f('chest', 'Chest', {}, [2, 1], [26, 8], { offers: { top: { slots: 2, height: 10 } } })
]

const BY_ID = new Map(FURNISHINGS.map((p) => [p.id, p]))

export function furnishing(id: string): Furnishing | null {
  return BY_ID.get(id) ?? null
}

/** 2.8's one placement rule (the stand-in of lane A's `canPlace`): what may go onto the floor, a wall, or a piece's surface. */
export function canPlace(piece: Furnishing, onto: 'floor' | 'wall' | Furnishing): boolean {
  if (onto === 'wall') return piece.mount === 'wall'
  if (piece.mount === 'wall') return false
  if (onto === 'floor') return true
  if (piece.layer === 'under') return false
  const top = onto.offers?.top
  const shelves = onto.offers?.shelves
  if (piece.size === 'small') return !!top || !!shelves
  if (piece.size === 'medium') return !!top && top.slots >= 2
  return false
}

/**
 * Each room's dressing (7.0 rule 3): the kit placed by id, by tile (its
 * footprint's top-left), facing and parent. Never blocks. Signature props
 * stay in rooms.json's map until the catalogue's placements replace them.
 */
export const ROOM_DRESSING: Readonly<Record<string, readonly Placement[]>> = {
  'in:village:bakery': [
    { piece: 'rug-rag', tx: 5, ty: 6 },
    { piece: 'wall-pegs', tx: 4, ty: 1 },
    { piece: 'calendar', tx: 10, ty: 1 },
    { piece: 'barrel', tx: 1, ty: 8 },
    { piece: 'sack', tx: 12, ty: 8 },
    { piece: 'basket', tx: 1, ty: 7 },
    { piece: 'small-table', tx: 12, ty: 4 },
    { piece: 'plant-pot', tx: 0, ty: 0, parent: 6, slot: 0 },
    { piece: 'candle', tx: 0, ty: 0, parent: 6, slot: 1 }
  ],
  'in:village:mill': [
    { piece: 'rug-round', tx: 5, ty: 6 },
    { piece: 'cap-on-peg', tx: 4, ty: 1 },
    { piece: 'wall-pegs', tx: 5, ty: 1 },
    { piece: 'calendar', tx: 8, ty: 1 },
    { piece: 'crate', tx: 1, ty: 8 },
    { piece: 'candle', tx: 0, ty: 0, parent: 4, slot: 0 },
    { piece: 'sack', tx: 9, ty: 8 },
    { piece: 'barrel', tx: 12, ty: 3 },
    { piece: 'basket', tx: 3, ty: 8 }
  ],
  'in:village:mill:2': [
    { piece: 'crate', tx: 6, ty: 6 },
    { piece: 'sack', tx: 9, ty: 6 },
    { piece: 'sack', tx: 12, ty: 4 },
    { piece: 'wall-pegs', tx: 4, ty: 1 },
    { piece: 'candle', tx: 0, ty: 0, parent: 0, slot: 0 }
  ],
  'in:village:library': [
    { piece: 'rug-round', tx: 6, ty: 5 },
    { piece: 'plant-pot', tx: 2, ty: 7 },
    { piece: 'small-table', tx: 9, ty: 7 },
    { piece: 'book-stack', tx: 0, ty: 0, parent: 2, slot: 0 },
    { piece: 'candle', tx: 0, ty: 0, parent: 2, slot: 1 },
    { piece: 'chair', tx: 8, ty: 4 },
    { piece: 'calendar', tx: 3, ty: 1 },
    { piece: 'basket', tx: 1, ty: 7 }
  ]
}
