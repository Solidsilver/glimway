/**
 * The world map's picture (docs/design/world-map.md 4, open-map.md 2.8): a
 * plain drawn grid from chunk data, one pixel a tile. Each walked chunk is
 * drawn in its ground's colours (the road and the Wend are ground too),
 * trees and stone darker, laid paths pale on top; the rest of the frontier
 * is blank parchment, the land past the drift a pale wash of what the
 * glimpse says lies there, and the frontier's edge a dashed line. Named
 * ways, places (with their finders), landmarks you've seen, the footprints'
 * names, the Commons gate and you are marks and labels over it.
 *
 * Pure: the scene's data in, the pieces out (a chunk's raster, its summary,
 * the marks and labels) and, for small maps and tests, the whole picture.
 * No DOM, no Phaser, no network: src/ui/map-renderer.ts draws what's in
 * view from these pieces, and src/ui/WorldMap.svelte holds the view.
 */
import { homeDoorstep, lotName } from '../lots.ts';
import { TERRAIN } from '../tile.ts';
import { loadWilds } from './data.ts';
import { frontierRect, insideFrontier } from './coords.ts';
import { PLACES, fixedChunks } from '../places.ts';
import { anchor } from '../location.ts';

export interface MapChunk {
  cx: number;
  cy: number;
  /** TERRAIN ids, [ly][lx], with the player-made changes applied. */
  ground: readonly (readonly number[])[];
  solid: readonly (readonly boolean[])[];
  /**
   * Changes when the chunk's picture can: its epoch and its ground changes
   * (src/game/wilds/map-data.ts). The renderer caches rasters by it.
   */
  rev?: string;
}

export interface MapPlace {
  id: string;
  kind: string;
  /** World tile of its landmark. */
  tx: number;
  ty: number;
  /** You had its landmark on screen this wick. */
  seen: boolean;
  /** Who found it first this wick, or null. */
  foundBy: string | null;
}

export interface MapWay {
  id: string;
  name: string;
  /** The two places it joins (place mark ids or footprint ids). */
  a: string;
  b: string;
  path: readonly { x: number; y: number }[];
}

export interface MapInput {
  /** Explicit server status, independent of source and terrain epoch. */
  land?: readonly import('../gen/glimway/v1/wilds_pb.js').ChunkLandStatus[];
  lamps?: readonly import('../gen/glimway/v1/wilds_pb.js').MapLamp[];
  frontier: { minCx: number; minCy: number; maxCx: number; maxCy: number };
  chunks: readonly MapChunk[];
  /** The fixed footprints' chunks (the Commons): always drawn, whatever the wick. */
  fixed?: readonly MapChunk[];
  glimpse: readonly { cx: number; cy: number; land: string; river: boolean }[];
  ways: readonly MapWay[];
  places: readonly MapPlace[];
  /** The hero's world tile, when they're out on the open map. */
  hero: { tx: number; ty: number } | null;
  /** The labels' own words (src/content/open-map.ts MAP_LABELS). */
  words: { you: string; gate: string };
}

export type MapLabelKind = 'footprint' | 'place' | 'way' | 'you' | 'gate';

export interface MapLabel {
  kind: MapLabelKind;
  text: string;
  /** World tiles (mapMarks), or picture pixels (mapPicture, one a tile). */
  x: number;
  y: number;
  /** A second line (a place's finder). */
  sub?: string;
}

export interface MapPicture {
  width: number;
  height: number;
  /** The world tile at the picture's top-left pixel. */
  originTx: number;
  originTy: number;
  rgba: Uint8ClampedArray;
  labels: MapLabel[];
}

type RGB = readonly [number, number, number];

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Map colours by ground id (content `grounds`), plain and a little muted, like inked paper. */
const GROUND_COLOURS: Record<string, string> = {
  woods: '#6f8c4e',
  moss: '#86a35e',
  verge: '#b5ad74',
  path: '#c4a874',
  trodden: '#b8955e',
  road: '#a59c88',
  paving: '#a59c88',
  water: '#3d6b7a',
  ford: '#7aa3ab',
  meadow: '#b8c07a',
  bank: '#cdbb8a',
  'laid-stone': '#f3ecd8',
  'laid-plank': '#c08250',
};
const LAND_WASH: Record<string, string> = { woods: '#c4cdb4', meadow: '#dfe0c2' };
export const MAP_COLOURS = {
  parchment: hex('#e3d4a8'),
  grid: hex('#d3c293'),
  drift: hex('#8a7b9c'),
  river: hex('#8fb0b6'),
  way: hex('#e3a53a'),
  you: hex('#c4523a'),
  youRim: hex('#fff7e0'),
  landmark: hex('#3a2e22'),
  found: hex('#7a4bb0'),
} as const;

/** Map colours of the curated grounds a fixed footprint (the Commons) is laid in, by TERRAIN name. */
const CURATED_COLOURS: Record<string, string> = {
  grass_a: '#a9b86e',
  grass_b: '#9cae66',
  grass_c: '#a9b86e',
  flowers: '#b8c07a',
  dirt: '#c4a874',
  path_a: '#c4a874',
  path_b: '#c4a874',
  cobble: '#a59c88',
  cobble_moss: '#9a9a80',
  tilled: '#a4805a',
};
/** Colour for each TERRAIN id the open map uses (the curated grounds fixed ground uses, then the Wilds' own). */
const TERRAIN_COLOUR = new Map<number, RGB>([
  ...Object.entries(CURATED_COLOURS).map(([name, c]) => [(TERRAIN as Record<string, number>)[name]!, hex(c)] as [number, RGB]),
  ...loadWilds().grounds.map((g) => [(TERRAIN as Record<string, number>)[g.terrain]!, hex(GROUND_COLOURS[g.id] ?? '#888888')] as [number, RGB]),
]);
const LAID = new Set(['laid-stone', 'laid-plank'].map((id) => (TERRAIN as Record<string, number>)[loadWilds().grounds.find((g) => g.id === id)!.terrain]!));

const UNKNOWN = hex('#888888');
const darker = (c: RGB, k: number): RGB => [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)];

type Rect = { minCx: number; minCy: number; maxCx: number; maxCy: number };

/** The fixed footprints' chunks (always on the map: Hearthwick and the lots). */
export function fixedRects(): Rect[] {
  return PLACES.fixed.map((p) => {
    const c = fixedChunks(p);
    return { minCx: c.x0, minCy: c.y0, maxCx: c.x1, maxCy: c.y1 };
  });
}

/** On the map's grid: inside the frontier or on a fixed footprint. */
export function onMapGrid(frontier: Rect, cx: number, cy: number): boolean {
  const inRect = (r: Rect) => cx >= r.minCx && cx <= r.maxCx && cy >= r.minCy && cy <= r.maxCy;
  return (inRect(frontier) && insideFrontier(cx, cy)) || fixedRects().some(inRect);
}

/** Tile segments along the actual reach union, including its stepped corners. */
export function mapEdges(frontier: Rect): { x0: number; y0: number; x1: number; y1: number }[] {
  const S = loadWilds().chunkSize;
  const edges = [];
  const bounds = frontierRect();
  frontier = {
    minCx: Math.max(frontier.minCx, bounds.minCx), minCy: Math.max(frontier.minCy, bounds.minCy),
    maxCx: Math.min(frontier.maxCx, bounds.maxCx), maxCy: Math.min(frontier.maxCy, bounds.maxCy),
  };
  for (let cy = frontier.minCy; cy <= frontier.maxCy; cy++) for (let cx = frontier.minCx; cx <= frontier.maxCx; cx++) {
    if (!onMapGrid(frontier, cx, cy)) continue;
    const x = cx * S, y = cy * S;
    if (!onMapGrid(frontier, cx - 1, cy)) edges.push({ x0: x, y0: y, x1: x, y1: y + S });
    if (!onMapGrid(frontier, cx + 1, cy)) edges.push({ x0: x + S, y0: y, x1: x + S, y1: y + S });
    if (!onMapGrid(frontier, cx, cy - 1)) edges.push({ x0: x, y0: y, x1: x + S, y1: y });
    if (!onMapGrid(frontier, cx, cy + 1)) edges.push({ x0: x, y0: y + S, x1: x + S, y1: y + S });
  }
  return edges;
}

/** Everything the map could show: the frontier, the fixed footprints and the glimpse past them. */
export function mapBounds(input: Pick<MapInput, 'frontier' | 'glimpse'>): Rect {
  const b = { ...input.frontier };
  for (const r of fixedRects()) {
    b.minCx = Math.min(b.minCx, r.minCx);
    b.maxCx = Math.max(b.maxCx, r.maxCx);
    b.minCy = Math.min(b.minCy, r.minCy);
    b.maxCy = Math.max(b.maxCy, r.maxCy);
  }
  for (const g of input.glimpse) {
    b.minCx = Math.min(b.minCx, g.cx);
    b.maxCx = Math.max(b.maxCx, g.cx);
    b.minCy = Math.min(b.minCy, g.cy);
    b.maxCy = Math.max(b.maxCy, g.cy);
  }
  return b;
}

/** The smallest map side, in chunks (a fresh map still shows the land around the footprints). */
export const MAP_MIN_CHUNKS = 5;

/**
 * What the picture covers: what you know (the chunks walked, the
 * footprints, where you stand, the ways and the places on it) and a chunk
 * round it, at least MAP_MIN_CHUNKS a side, within mapBounds. The map grows
 * as you walk, until it holds the whole frontier and the glimpse past it.
 */
export function mapFrame(input: MapInput): Rect {
  const S = loadWilds().chunkSize;
  const all = mapBounds(input);
  const f: Rect = { minCx: Infinity, minCy: Infinity, maxCx: -Infinity, maxCy: -Infinity };
  const add = (cx: number, cy: number) => {
    f.minCx = Math.min(f.minCx, cx);
    f.maxCx = Math.max(f.maxCx, cx);
    f.minCy = Math.min(f.minCy, cy);
    f.maxCy = Math.max(f.maxCy, cy);
  };
  const tile = (tx: number, ty: number) => add(Math.floor(tx / S), Math.floor(ty / S));
  for (const p of loadWilds().places) {
    add(p.cx, p.cy);
    add(p.cx + p.width - 1, p.cy + p.height - 1);
  }
  for (const r of fixedRects()) {
    add(r.minCx, r.minCy);
    add(r.maxCx, r.maxCy);
  }
  for (const c of input.chunks) add(c.cx, c.cy);
  if (input.hero) tile(input.hero.tx, input.hero.ty);
  for (const w of input.ways) for (const t of w.path) tile(t.x, t.y);
  for (const p of input.places) if (p.seen || p.foundBy) tile(p.tx, p.ty);
  // A chunk round it, then widened to the least size, then kept inside what there is.
  const grow = (lo: number, hi: number, min: number, max: number): [number, number] => {
    lo -= 1;
    hi += 1;
    while (hi - lo + 1 < MAP_MIN_CHUNKS) {
      if (lo > min) lo--;
      if (hi - lo + 1 < MAP_MIN_CHUNKS && hi < max) hi++;
      if (lo <= min && hi >= max) break;
    }
    return [Math.max(lo, min), Math.min(hi, max)];
  };
  const [minCx, maxCx] = grow(f.minCx, f.maxCx, all.minCx, all.maxCx);
  const [minCy, maxCy] = grow(f.minCy, f.maxCy, all.minCy, all.maxCy);
  return { minCx, minCy, maxCx, maxCy };
}


/** The frame in world tiles (inclusive), for the view (src/lib/wilds/map-view.ts). */
export function frameTiles(r: Rect): { minTx: number; minTy: number; maxTx: number; maxTy: number } {
  const S = loadWilds().chunkSize;
  return { minTx: r.minCx * S, minTy: r.minCy * S, maxTx: (r.maxCx + 1) * S - 1, maxTy: (r.maxCy + 1) * S - 1 };
}

// ------------------------------------------------------------ painting

/**
 * One walked chunk at a tile a pixel (chunkSize² RGBA): its ground's
 * colours, trees and stone darker, laid paths pale. The world map caches
 * these by chunk and revision (src/ui/map-renderer.ts).
 */
export function chunkRaster(c: MapChunk): Uint8ClampedArray {
  const S = loadWilds().chunkSize;
  const rgba = new Uint8ClampedArray(S * S * 4);
  for (let ly = 0; ly < S; ly++)
    for (let lx = 0; lx < S; lx++) {
      const t = c.ground[ly]?.[lx];
      if (t === undefined) continue;
      const base = TERRAIN_COLOUR.get(t) ?? UNKNOWN;
      const col = c.solid[ly]?.[lx] && !LAID.has(t) ? darker(base, 0.66) : base;
      const i = (ly * S + lx) * 4;
      rgba[i] = col[0];
      rgba[i + 1] = col[1];
      rgba[i + 2] = col[2];
      rgba[i + 3] = 255;
    }
  return rgba;
}

/**
 * A square raster shrunk by averaging `block`-sided blocks of opaque pixels
 * (a summary for zoomed-out views). Blank pixels stay blank: a summary never
 * shows more than the walked land it came from.
 */
export function shrinkRaster(rgba: Uint8ClampedArray, size: number, block: number): Uint8ClampedArray {
  const n = Math.ceil(size / block);
  const out = new Uint8ClampedArray(n * n * 4);
  for (let by = 0; by < n; by++)
    for (let bx = 0; bx < n; bx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let k = 0;
      for (let y = by * block; y < Math.min(size, (by + 1) * block); y++)
        for (let x = bx * block; x < Math.min(size, (bx + 1) * block); x++) {
          const i = (y * size + x) * 4;
          if (!rgba[i + 3]) continue;
          r += rgba[i]!;
          g += rgba[i + 1]!;
          b += rgba[i + 2]!;
          k++;
        }
      if (!k) continue;
      const o = (by * n + bx) * 4;
      out[o] = Math.round(r / k);
      out[o + 1] = Math.round(g / k);
      out[o + 2] = Math.round(b / k);
      out[o + 3] = 255;
    }
  return out;
}

/** The pale wash past the drift, for one glimpsed chunk: hatched where the Wend runs on. */
export function glimpseRaster(land: string, river: boolean, cx: number, cy: number): Uint8ClampedArray {
  const S = loadWilds().chunkSize;
  const wash = hex(LAND_WASH[land] ?? LAND_WASH.woods!);
  const rgba = new Uint8ClampedArray(S * S * 4);
  for (let ly = 0; ly < S; ly++)
    for (let lx = 0; lx < S; lx++) {
      // Hatching runs on across chunks: it follows the world tile, not the chunk.
      const c = river && (cx * S + lx + cy * S + ly) % 5 === 0 ? MAP_COLOURS.river : wash;
      const i = (ly * S + lx) * 4;
      rgba[i] = c[0];
      rgba[i + 1] = c[1];
      rgba[i + 2] = c[2];
      rgba[i + 3] = GLIMPSE_ALPHA;
    }
  return rgba;
}

/** How see-through the glimpse's wash is (of 255). */
export const GLIMPSE_ALPHA = 150;

/** The wash colour for a glimpsed land (the overview's flat fill). */
export function glimpseColour(land: string): RGB {
  return hex(LAND_WASH[land] ?? LAND_WASH.woods!);
}

// ------------------------------------------------------------ marks and labels

export interface MapMarks {
  /** The named ways' tiles. */
  wayTiles: { x: number; y: number }[];
  /** A place's mark: found (the finder's colour) or only seen. */
  places: { tx: number; ty: number; found: boolean }[];
  /** Ways, places, the footprints and the gate (not you), at world tiles. */
  labels: MapLabel[];
}

/** What sits on the land, apart from you: drawn over the terrain, never baked into it. */
export function mapMarks(input: MapInput): MapMarks {
  const w = loadWilds();
  const S = w.chunkSize;
  const labels: MapLabel[] = [];
  const wayTiles: { x: number; y: number }[] = [];
  // Named ways along their own tiles.
  for (const way of input.ways) {
    for (const t of way.path) wayTiles.push({ x: t.x, y: t.y });
    const mid = way.path[Math.floor(way.path.length / 2)];
    if (mid) labels.push({ kind: 'way', text: way.name, x: mid.x, y: mid.y });
  }
  // Places: a mark for what you've seen or someone found, and the finder's name.
  const places: MapMarks['places'] = [];
  for (const p of input.places) {
    if (!p.seen && !p.foundBy) continue;
    places.push({ tx: p.tx, ty: p.ty, found: !!p.foundBy });
    const kind = w.placeKinds.find((k) => k.id === p.kind);
    const name = kind ? kind.name.charAt(0).toUpperCase() + kind.name.slice(1) : 'A place';
    labels.push({ kind: 'place', text: name, x: p.tx, y: p.ty, ...(p.foundBy ? { sub: p.foundBy } : {}) });
  }
  // The footprints by name, and the Commons gate.
  for (const fp of [...w.places, ...PLACES.fixed]) labels.push({ kind: 'footprint', text: fp.name.charAt(0).toUpperCase() + fp.name.slice(1), x: (fp.cx + fp.width / 2) * S, y: (fp.cy + fp.height / 2) * S });
  for (let g = 0; g < 8; g++) { const p = homeDoorstep(g); labels.push({ kind: 'footprint', text: lotName(g), x: p.tx, y: p.ty }); }
  const gate = gateTile();
  if (gate) labels.push({ kind: 'gate', text: input.words.gate, x: gate.tx, y: gate.ty });
  return { wayTiles, places, labels };
}

/** The Commons gate's tile on the open map, its arch (`hearthwick:arch`: where the map opens when you're not out there). */
export function gateTile(): { tx: number; ty: number } | null {
  const a = anchor('hearthwick:arch');
  return a ? { tx: Math.floor(a.x / 16), ty: Math.floor(a.y / 16) } : null;
}

/**
 * The labels' type, as src/ui/WorldMap.svelte sets it (CSS px): a name line
 * and a smaller finder line, each at its line height, with a little padding.
 * Collisions are judged on these boxes.
 */
export const LABEL_TYPE = { size: 11, sub: 10, lineHeight: 1.15, charEm: 0.56, padX: 4, padY: 1 } as const;

/** A label's box in CSS px. */
export function labelBox(l: Pick<MapLabel, 'text' | 'sub'>): { w: number; h: number } {
  const T = LABEL_TYPE;
  const main = l.text.length * T.size * T.charEm;
  // The finder's line reads "Found by <name>".
  const sub = l.sub ? (l.sub.length + 9) * T.sub * T.charEm : 0;
  const h = Math.ceil(T.size * T.lineHeight) + (l.sub ? Math.ceil(T.sub * T.lineHeight) : 0) + 2 * T.padY;
  return { w: Math.max(main, sub) + 2 * T.padX, h };
}

const LABEL_RANK: Record<MapLabelKind, number> = { you: 0, way: 1, place: 2, footprint: 3, gate: 4 };

/**
 * The labels that fit at `scale` CSS px a unit of their x and y: most
 * important first (you, ways, places, the footprints, the gate), and a label
 * that would overlap one already placed is left off (its mark stays on the
 * map). With `bounds` (the viewport, in the same CSS px), a label whose box
 * is wholly outside it is dropped before fitting, so one nobody can see never
 * pushes out one they can.
 */
export function fitLabels(labels: readonly MapLabel[], scale: number, bounds?: { w: number; h: number }): MapLabel[] {
  const placed: { l: MapLabel; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const l of [...labels].sort((a, b) => LABEL_RANK[a.kind] - LABEL_RANK[b.kind])) {
    const box = labelRect(l, scale);
    if (bounds && (box.x1 <= 0 || box.y1 <= 0 || box.x0 >= bounds.w || box.y0 >= bounds.h)) continue;
    if (placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) continue;
    placed.push({ l, ...box });
  }
  return labels.filter((l) => placed.some((p) => p.l === l));
}

/** Where a label's box sits (CSS px): most just above their mark, a footprint's centred on it, yours below your dot. */
function labelRect(l: MapLabel, scale: number): { x0: number; y0: number; x1: number; y1: number } {
  const { w, h } = labelBox(l);
  const cx = l.x * scale;
  const cy = l.y * scale;
  if (l.kind === 'footprint') return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
  if (l.kind === 'you') return { x0: cx - w / 2, y0: cy + 8, x1: cx + w / 2, y1: cy + 8 + h };
  return { x0: cx - w / 2, y0: cy - h - 2, x1: cx + w / 2, y1: cy - 2 };
}

// ------------------------------------------------------------ the whole picture

/**
 * The whole frame as one picture, one pixel a tile (see the file comment).
 * The world map doesn't draw this (src/ui/map-renderer.ts draws only what's
 * in view); it's the reference the renderer's pieces are tested against, and
 * fine for a small map.
 */
export function mapPicture(input: MapInput): MapPicture {
  const S = loadWilds().chunkSize;
  const b = mapFrame(input);
  const originTx = b.minCx * S;
  const originTy = b.minCy * S;
  const width = (b.maxCx - b.minCx + 1) * S;
  const height = (b.maxCy - b.minCy + 1) * S;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const put = (x: number, y: number, c: RGB, a = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = c[0];
    rgba[i + 1] = c[1];
    rgba[i + 2] = c[2];
    rgba[i + 3] = a;
  };
  const blit = (src: Uint8ClampedArray, cx: number, cy: number) => {
    for (let ly = 0; ly < S; ly++)
      for (let lx = 0; lx < S; lx++) {
        const i = (ly * S + lx) * 4;
        if (src[i + 3]) put((cx - b.minCx) * S + lx, (cy - b.minCy) * S + ly, [src[i]!, src[i + 1]!, src[i + 2]!], src[i + 3]);
      }
  };
  const f = input.frontier;
  const inside = (cx: number, cy: number) => onMapGrid(f, cx, cy);
  // Parchment for the frontier's unwalked land, a faint grid at chunk edges.
  for (let cy = f.minCy; cy <= f.maxCy; cy++)
    for (let cx = f.minCx; cx <= f.maxCx; cx++)
      if (inside(cx, cy)) for (let ly = 0; ly < S; ly++)
        for (let lx = 0; lx < S; lx++) put((cx - b.minCx) * S + lx, (cy - b.minCy) * S + ly, lx === 0 || ly === 0 ? MAP_COLOURS.grid : MAP_COLOURS.parchment);
  // Past the drift: a pale wash of the land the glimpse names, hatched where the Wend runs on.
  for (const g of input.glimpse) if (!inside(g.cx, g.cy)) blit(glimpseRaster(g.land, g.river, g.cx, g.cy), g.cx, g.cy);
  // Walked land, in its own colours.
  for (const c of [...input.chunks, ...(input.fixed ?? [])]) if (inside(c.cx, c.cy)) blit(chunkRaster(c), c.cx, c.cy);
  // The frontier's edge: a dashed line in the drift's colour.
  for (const e of mapEdges(f)) {
    const vertical = e.x0 === e.x1;
    for (let n = 0; n < S; n++) if (n % 4 < 2) {
      const tx = e.x0 + (vertical ? 0 : n), ty = e.y0 + (vertical ? n : 0);
      // Paint on the interior side of the boundary.
      const x = vertical && !inside(Math.floor(tx / S), Math.floor(ty / S)) ? tx - 1 : tx;
      const y = !vertical && !inside(Math.floor(tx / S), Math.floor(ty / S)) ? ty - 1 : ty;
      put(x - originTx, y - originTy, MAP_COLOURS.drift);
    }
  }

  const marks = mapMarks(input);
  for (const t of marks.wayTiles) put(t.x - originTx, t.y - originTy, MAP_COLOURS.way);
  for (const p of marks.places) {
    const c = p.found ? MAP_COLOURS.found : MAP_COLOURS.landmark;
    for (const [dx, dy] of PLACE_MARK) put(p.tx - originTx + dx, p.ty - originTy + dy, c);
  }
  const labels = marks.labels.map((l) => ({ ...l, x: l.x - originTx, y: l.y - originTy }));
  // You (the world map draws you on your own layer instead).
  if (input.hero) {
    const at = { x: input.hero.tx - originTx, y: input.hero.ty - originTy };
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) put(at.x + dx, at.y + dy, Math.abs(dx) === 2 || Math.abs(dy) === 2 ? MAP_COLOURS.youRim : MAP_COLOURS.you);
    labels.push({ kind: 'you', text: input.words.you, ...at });
  }
  return { width, height, originTx, originTy, rgba, labels: labels.filter((l) => l.x >= 0 && l.y >= 0 && l.x < width && l.y < height) };
}

/** A place's mark: a small cross of tiles. */
export const PLACE_MARK = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const;
