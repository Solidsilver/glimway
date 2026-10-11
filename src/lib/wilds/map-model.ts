/**
 * The Map tab's picture (docs/design/open-map.md 2.8): a plain drawn grid
 * from chunk data, one pixel a tile. Each walked chunk is drawn in its
 * ground's colours (the road and the Wend are ground too), trees and stone
 * darker, laid paths pale on top; the rest of the frontier is blank
 * parchment, the land past the drift a pale wash of what the glimpse says
 * lies there, and the frontier's edge a dashed line. Named ways, places
 * (with their finders), landmarks you've seen, the footprints' names, the
 * Commons gate and you are marks and labels over it.
 *
 * Pure: the scene's data in, an RGBA picture and a label list out. No DOM,
 * no Phaser, no network (src/ui/MapTab.svelte draws it).
 */
import { TERRAIN } from '../tile.ts';
import { loadWilds } from './data.ts';

export interface MapChunk {
  cx: number;
  cy: number;
  /** TERRAIN ids, [ly][lx], with the player-made changes applied. */
  ground: readonly (readonly number[])[];
  solid: readonly (readonly boolean[])[];
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
  frontier: { minCx: number; minCy: number; maxCx: number; maxCy: number };
  chunks: readonly MapChunk[];
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
  /** Picture pixels (one a tile). */
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

/** Colour for each TERRAIN id the open map uses. */
const TERRAIN_COLOUR = new Map<number, RGB>(
  loadWilds().grounds.map((g) => [(TERRAIN as Record<string, number>)[g.terrain]!, hex(GROUND_COLOURS[g.id] ?? '#888888')]),
);
const LAID = new Set(['laid-stone', 'laid-plank'].map((id) => (TERRAIN as Record<string, number>)[loadWilds().grounds.find((g) => g.id === id)!.terrain]!));

const darker = (c: RGB, k: number): RGB => [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)];

type Rect = { minCx: number; minCy: number; maxCx: number; maxCy: number };

/** Everything the map could show: the frontier and the glimpse past it. */
export function mapBounds(input: Pick<MapInput, 'frontier' | 'glimpse'>): Rect {
  const b = { ...input.frontier };
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

/** Rough label size in CSS px at the map's 10 px type, for keeping labels apart. */
function labelBox(l: MapLabel): { w: number; h: number } {
  const chars = Math.max(l.text.length, l.sub ? l.sub.length + 9 : 0);
  return { w: chars * 5.6 + 8, h: l.sub ? 26 : 14 };
}

const LABEL_RANK: Record<MapLabelKind, number> = { you: 0, way: 1, place: 2, footprint: 3, gate: 4 };

/**
 * The labels that fit at `scale` CSS px a map pixel: most important first
 * (you, ways, places, the footprints, the gate), and a label that would
 * overlap one already placed is left off (its mark stays on the map).
 */
export function fitLabels(labels: readonly MapLabel[], scale: number): MapLabel[] {
  const placed: { l: MapLabel; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const l of [...labels].sort((a, b) => LABEL_RANK[a.kind] - LABEL_RANK[b.kind])) {
    const { w, h } = labelBox(l);
    const cx = l.x * scale;
    const cy = l.y * scale;
    // Most labels sit just above their mark; a footprint's is centred on it, and yours sits below your dot.
    const box =
      l.kind === 'footprint'
        ? { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 }
        : l.kind === 'you'
          ? { x0: cx - w / 2, y0: cy + 4, x1: cx + w / 2, y1: cy + 4 + h }
          : { x0: cx - w / 2, y0: cy - h - 2, x1: cx + w / 2, y1: cy - 2 };
    if (placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) continue;
    placed.push({ l, ...box });
  }
  return labels.filter((l) => placed.some((p) => p.l === l));
}

/** Draw the map (see the file comment). */
export function mapPicture(input: MapInput): MapPicture {
  const w = loadWilds();
  const S = w.chunkSize;
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
  const f = input.frontier;
  const inside = (cx: number, cy: number) => cx >= f.minCx && cx <= f.maxCx && cy >= f.minCy && cy <= f.maxCy;
  // Parchment for the frontier's unwalked land, a faint grid at chunk edges.
  for (let cy = f.minCy; cy <= f.maxCy; cy++)
    for (let cx = f.minCx; cx <= f.maxCx; cx++)
      for (let ly = 0; ly < S; ly++)
        for (let lx = 0; lx < S; lx++) put((cx - b.minCx) * S + lx, (cy - b.minCy) * S + ly, lx === 0 || ly === 0 ? MAP_COLOURS.grid : MAP_COLOURS.parchment);
  // Past the drift: a pale wash of the land the glimpse names, hatched where the Wend runs on.
  for (const g of input.glimpse) {
    if (inside(g.cx, g.cy)) continue;
    const wash = hex(LAND_WASH[g.land] ?? LAND_WASH.woods!);
    for (let ly = 0; ly < S; ly++)
      for (let lx = 0; lx < S; lx++) {
        const x = (g.cx - b.minCx) * S + lx;
        const y = (g.cy - b.minCy) * S + ly;
        put(x, y, g.river && (x + y) % 5 === 0 ? MAP_COLOURS.river : wash, 150);
      }
  }
  // Walked land, in its own colours.
  for (const c of input.chunks) {
    if (!inside(c.cx, c.cy)) continue;
    for (let ly = 0; ly < S; ly++)
      for (let lx = 0; lx < S; lx++) {
        const t = c.ground[ly]?.[lx];
        if (t === undefined) continue;
        const base = TERRAIN_COLOUR.get(t) ?? hex('#888888');
        put((c.cx - b.minCx) * S + lx, (c.cy - b.minCy) * S + ly, c.solid[ly]?.[lx] && !LAID.has(t) ? darker(base, 0.66) : base);
      }
  }
  // The frontier's edge: a dashed line in the drift's colour.
  const x0 = (f.minCx - b.minCx) * S;
  const y0 = (f.minCy - b.minCy) * S;
  const x1 = (f.maxCx - b.minCx + 1) * S - 1;
  const y1 = (f.maxCy - b.minCy + 1) * S - 1;
  for (let x = x0; x <= x1; x++)
    if (x % 4 < 2) {
      put(x, y0, MAP_COLOURS.drift);
      put(x, y1, MAP_COLOURS.drift);
    }
  for (let y = y0; y <= y1; y++)
    if (y % 4 < 2) {
      put(x0, y, MAP_COLOURS.drift);
      put(x1, y, MAP_COLOURS.drift);
    }

  const labels: MapLabel[] = [];
  const px = (tx: number, ty: number) => ({ x: tx - originTx, y: ty - originTy });
  // Named ways along their own tiles.
  for (const way of input.ways) {
    for (const t of way.path) {
      const p = px(t.x, t.y);
      put(p.x, p.y, MAP_COLOURS.way);
    }
    const mid = way.path[Math.floor(way.path.length / 2)];
    if (mid) labels.push({ kind: 'way', text: way.name, ...px(mid.x, mid.y) });
  }
  // Places: a mark for what you've seen or someone found, and the finder's name.
  for (const p of input.places) {
    if (!p.seen && !p.foundBy) continue;
    const at = px(p.tx, p.ty);
    const c = p.foundBy ? MAP_COLOURS.found : MAP_COLOURS.landmark;
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) put(at.x + dx, at.y + dy, c);
    const kind = w.placeKinds.find((k) => k.id === p.kind);
    const name = kind ? kind.name.charAt(0).toUpperCase() + kind.name.slice(1) : 'A place';
    labels.push({ kind: 'place', text: name, ...at, ...(p.foundBy ? { sub: p.foundBy } : {}) });
  }
  // The footprints by name, and the Commons gate.
  for (const fp of w.places) labels.push({ kind: 'footprint', text: fp.name.charAt(0).toUpperCase() + fp.name.slice(1), ...px((fp.cx + fp.width / 2) * S, (fp.cy + fp.height / 2) * S) });
  const gate = w.places.find((p) => p.id === 'tangle')?.openings.find((o) => o.id === 'commons-gate');
  if (gate) labels.push({ kind: 'gate', text: input.words.gate, ...px(gate.cx * S + gate.offset + 1, gate.cy * S + S - 1) });
  // You.
  if (input.hero) {
    const at = px(input.hero.tx, input.hero.ty);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) put(at.x + dx, at.y + dy, Math.abs(dx) === 2 || Math.abs(dy) === 2 ? MAP_COLOURS.youRim : MAP_COLOURS.you);
    labels.push({ kind: 'you', text: input.words.you, ...at });
  }
  return { width, height, originTx, originTy, rgba, labels: labels.filter((l) => l.x >= 0 && l.y >= 0 && l.x < width && l.y < height) };
}
