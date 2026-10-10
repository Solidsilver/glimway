/**
 * The fishery rules (content/fishing.json; docs/design/crafts.md 5.4).
 * Shared with the Go server (content/fishing.go): the fullness bands and
 * their waits, the hold and cast spacing, and each water's banks and
 * species. The stock itself is server state; the band from a stock is only
 * ever a preview here.
 */
import raw from '../../content/fishing.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { FishingSchema, type FishingValid, type FishBandValid, type FishWaterValid, type FishBankValid } from './gen/glimway/content/v1/fishing_pb.js';
import { CALENDAR } from './calendar.ts';
import { itemDef, isStackable } from './items.ts';

export type FishBand = FishBandValid;
export type FishWater = FishWaterValid;
export type FishBank = FishBankValid;
/** The fishery rules (proto/glimway/content/v1/fishing.proto), with the schema's required fields non-optional. */
export type FishingData = FishingValid;

/** Throws on anything content/fishing.go would refuse. */
export function validateFishing(value: unknown): FishingData {
  const data = decodeContent(FishingSchema, value, 'fishing', ['waters']) as FishingData;
  const bad = (why: string): never => { throw new Error(`invalid fishing: ${why}`); };
  const bands = new Set<string>();
  data.bands.forEach((b, i) => {
    if (bands.has(b.id)) return bad(`duplicate band ${b.id}`);
    bands.add(b.id);
    if (i > 0 && b.atLeastPercent >= data.bands[i - 1]!.atLeastPercent) return bad(`band order ${b.id}`);
  });
  // The last band floors at 0: a water with fish in it always has a band
  // (5.3, "very low: under 20 % but at least one fish").
  const floor = data.bands[data.bands.length - 1]!;
  if (floor.atLeastPercent !== 0) return bad(`band floor ${floor.id}`);
  const marks: readonly string[] = CALENDAR.marks;
  const waters = new Set<string>();
  for (const w of data.waters) {
    if (waters.has(w.id)) return bad(`duplicate water ${w.id}`);
    waters.add(w.id);
    const banks = new Set<string>();
    for (const bank of w.banks) {
      if (banks.has(bank.id)) return bad(`${w.id} duplicate bank ${bank.id}`);
      banks.add(bank.id);
      for (const mark of bank.closedIn) if (!marks.includes(mark)) return bad(`${w.id} bank ${bank.id} closed mark ${mark}`);
    }
    const species = new Set<string>();
    for (const s of w.species) {
      if (species.has(s.item)) return bad(`${w.id} duplicate species ${s.item}`);
      species.add(s.item);
      const d = itemDef(s.item);
      if (!d || !isStackable(d)) return bad(`${w.id} unknown species ${s.item}`);
    }
  }
  return data;
}

export const FISHING: FishingData = validateFishing(raw);

export function waterFor(id: string): FishWater | undefined {
  return FISHING.waters.find((w) => w.id === id);
}

export function bankFor(water: FishWater, id: string): FishBank | undefined {
  return water.banks.find((b) => b.id === id);
}

/** The waters of one area (the GET /api/fishing/waters?area= answer's rows). */
export function watersForArea(area: string): FishWater[] {
  return FISHING.waters.filter((w) => w.area === area);
}

/** The wait to a bite in a band, in seconds. */
export function waitSeconds(band: FishBand): number {
  return band.waitSeconds;
}

// ------------------------------------------------------------ the bank, the visit (5.1)

/** World px per tile (src/lib/tile.ts), kept here so the rules stay Phaser-free. */
const TILE_PX = 16;

/** Where a bank tile's middle is, in world px. */
export function bankTileMid(t: { tx: number; ty: number }): { x: number; y: number } {
  return { x: t.tx * TILE_PX + TILE_PX / 2, y: t.ty * TILE_PX + TILE_PX / 2 };
}

/** How far a point is from a bank, in world px: to the middle of its nearest tile. */
export function bankDistance(bank: FishBank, x: number, y: number): number {
  let best = Infinity;
  for (const t of bank.tiles) {
    const m = bankTileMid(t);
    best = Math.min(best, Math.hypot(x - m.x, y - m.y));
  }
  return best;
}

/** How near a bank you cast from (`reachTiles`, the server's check of `where`), in world px. */
export function castReachPx(data: FishingData = FISHING): number {
  return data.reachTiles * TILE_PX;
}

/**
 * Walking further than this from the bank pulls the line in (5.1: "more
 * than a tile from the bank"). It is the cast's own reach, so standing
 * anywhere the server would take a cast from never cancels it.
 */
export function leaveReachPx(data: FishingData = FISHING): number {
  return castReachPx(data);
}

/** A bank you can stand at, with its water. */
export interface BankSpot {
  water: FishWater;
  bank: FishBank;
}

/** The nearest bank of an area's waters within reach of (x, y), or null. */
export function bankNear(area: string, x: number, y: number, data: FishingData = FISHING): BankSpot | null {
  let best: (BankSpot & { d: number }) | null = null;
  for (const water of data.waters) {
    if (water.area !== area) continue;
    for (const bank of water.banks) {
      const d = bankDistance(bank, x, y);
      if (d <= castReachPx(data) && (!best || d < best.d)) best = { water, bank, d };
    }
  }
  return best ? { water: best.water, bank: best.bank } : null;
}

/** Is the bank open in a calendar mark (the north and east banks ice over in the Quiet)? */
export function bankOpen(bank: FishBank, mark: string): boolean {
  return !bank.closedIn.includes(mark);
}

/** One tile in a facing, as a step. */
export const FACING_STEP: Readonly<Record<string, { dx: number; dy: number }>> = {
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 },
  east: { dx: 1, dy: 0 },
  west: { dx: -1, dy: 0 },
};

/**
 * Where the float lands, as a tile: out from the bank tile nearest the hero,
 * in the bank's facing, as far as `out` tiles while the tile is water
 * (`isWater`). Null when the first tile out isn't water (no line to cast).
 * Three tiles puts the race's float at the foot of the race, below the
 * wheel rather than under it.
 */
export function floatTile(bank: FishBank, x: number, y: number, isWater: (tx: number, ty: number) => boolean, out = 3): { tx: number; ty: number } | null {
  const step = FACING_STEP[bank.facing];
  if (!step) return null;
  let from = bank.tiles[0]!;
  let best = Infinity;
  for (const t of bank.tiles) {
    const m = bankTileMid(t);
    const d = Math.hypot(x - m.x, y - m.y);
    if (d < best) {
      best = d;
      from = t;
    }
  }
  let at: { tx: number; ty: number } | null = null;
  for (let i = 1; i <= out; i++) {
    const t = { tx: from.tx + step.dx * i, ty: from.ty + step.dy * i };
    if (!isWater(t.tx, t.ty)) break;
    at = t;
  }
  return at;
}

// ------------------------------------------------------------ bands and lines (5.3, 5.4)

export function bandById(id: string, data: FishingData = FISHING): FishBand | undefined {
  return data.bands.find((b) => b.id === id);
}

/** The line a bank reads for a band (the "still" band has no row: the water's empty). */
export const STILL_LINE = 'Nothing moving at all. The water needs a rest.';

/**
 * A band as the server sent it, for keeping: an empty water may come as ''
 * or as 'still' (the "still" band has no row), and both mean still.
 */
export function bandFrom(band: string): string {
  return band === '' ? 'still' : band;
}

export function bandLine(id: string | null | undefined, data: FishingData = FISHING): string | null {
  if (!id) return null;
  if (id === 'still') return STILL_LINE;
  return bandById(id, data)?.line ?? null;
}

// ------------------------------------------------------------ a cast (5.3, 5.5)

/** What a cast is doing at a moment: the float bobbing, a fish on, or slipped off. */
export type CastPhase = 'waiting' | 'ready' | 'lapsed';

/** The times a cast carries (FishingCast's, in Unix seconds). */
export interface CastTimes {
  readyAt: number;
  holdUntil: number;
}

/**
 * How far this screen's window for a fish sits inside the server's, in
 * seconds. The client reads the server's clock through a skew good to about
 * half a second (the `Date` header's whole seconds) plus a round trip, so a
 * Reel the moment the float dips could reach the server before its
 * `ready_at` (`not-yet`), and a Keep at the last moment after its
 * `hold_until` (`no-cast`). The fish waits for you: a moment later costs
 * nothing.
 */
export const CLOCK_GRACE_SECONDS = 1.5;

/**
 * A cast's phase at `now` on this screen (5.3: the fish waits `holdSeconds`
 * after the bite, then slips off), the bite `grace` after the server's
 * `ready_at` and the slip `grace` before its `hold_until`.
 */
export function castPhase(cast: CastTimes, now: number, grace = CLOCK_GRACE_SECONDS): CastPhase {
  if (now < cast.readyAt + grace) return 'waiting';
  return now < cast.holdUntil - grace ? 'ready' : 'lapsed';
}

/**
 * The bite as the client predicts it before the answer (5.5): the band's
 * wait from now, then the hold. The server's `ready_at` corrects it.
 */
export function predictedCast(bandId: string, now: number, data: FishingData = FISHING): CastTimes {
  const wait = bandById(bandId, data)?.waitSeconds ?? data.bands[0]!.waitSeconds;
  return { readyAt: now + wait, holdUntil: now + wait + data.holdSeconds };
}

/**
 * Whether what's on the line has gone back to the water: a line out, or a
 * fish reeled in but not yet kept or let go (5.3: the fish waits
 * `holdSeconds` after the bite, then slips off). The server refuses a
 * settle after `hold_until`, so the client lets go at the same moment.
 */
export function slippedOff(line: CastTimes | null, landed: CastTimes | null, now: number): boolean {
  const held = landed ?? line;
  return !!held && castPhase(held, now) === 'lapsed';
}

/**
 * A settle refusal that ends the landing: the cast is gone (`no-cast`), or the
 * world says the fish isn't on yet (`not-yet`) or the rod has left the pack
 * (`wrong-tool`). Anything else (`busy`, `pending`, `offline`, …) leaves the
 * fish on the bank and the buttons up, to press again.
 */
export function settleEnds(code: string): boolean {
  return code === 'no-cast' || code === 'not-yet' || code === 'wrong-tool';
}

/** When the next cast may start (5.3: spacing from the last start; cancelling doesn't reset it). */
export function nextCastAt(lastStart: number | null, data: FishingData = FISHING): number {
  return lastStart === null ? 0 : lastStart + data.castSpacingSeconds;
}

// ------------------------------------------------------------ words

/** The verbs on the action button (8): Cast, then Pull in while you wait, then Reel. */
export const FISHING_VERBS = { cast: 'Cast', pull: 'Pull in', reel: 'Reel', keep: 'Keep', release: 'Let it go' } as const;

/** What the prompt says once a fish is on (also after a reload at the bank). */
export const ON_THE_LINE = 'Something’s on your line';

/** Fishing refusals in plain words (the server's codes, design 6.1; the client's own outcomes). */
const REFUSALS: Readonly<Record<string, string>> = {
  'already-casting': 'You’ve a line out already.',
  'cast-too-soon': 'Give the water a moment before you cast again.',
  'water-still': STILL_LINE,
  'no-cast': 'The line’s come in. Nothing on it now.',
  'not-yet': 'Nothing on the line yet. Give it a moment.',
  'wrong-tool': 'You’d want your rod for that.',
  'too-far-away': 'Stand on the bank to cast.',
  'tool-blunt': 'This rod’s past fishing with. Finn sells another.',
  'worn-out': 'This rod’s past fishing with. Finn sells another.',
  'not-in-season': 'This bank is iced over. The race above the wheel runs all year.',
  'item-not-found': 'Your rod isn’t in your pack.',
  'not-a-tool': 'That won’t catch anything. You’d want a rod.',
  'invalid-request': 'There’s no fishing from here.',
  offline: 'Needs a connection: the pond is shared.',
  busy: 'Hold on — the last one is still on its way.',
  superseded: 'Another device took over this journey.',
  // A lost answer, replayed under the same key: the words src/content/errors.ts's REPLAYED uses.
  resolved: 'Your last request went through after all. Check what you have before trying again.',
  pending: 'No answer yet — it may have gone through. We’ll find out when the connection is back; nothing will be taken twice.',
};

export const FISHING_FALLBACK = 'The line tangled. Nothing changed — try again in a moment.';

export function fishingRefusal(code: string): string {
  return REFUSALS[code] ?? FISHING_FALLBACK;
}

// ------------------------------------------------------------ the rod in hand (9.3)

/** The held-out rod's art (crafts pass, `rod-held-out`): its grip and tip, in texels of its 128 canvas at 4 a world px. */
export const ROD_ART = { grip: { x: 8, y: 124 }, tip: { x: 123, y: 71 }, density: 4 } as const;

/** How the held rod is drawn: mirrored or not, turned by `rotation` (radians, clockwise) about the grip, and where its tip is. */
export interface RodPose {
  flipX: boolean;
  rotation: number;
  tip: { x: number; y: number };
}

/**
 * The rod held out toward the float: mirrored when the float is to the
 * left, its tip a little above the line to the float (a rod is held over
 * its line), never pointing up past about 35° nor down past about 65°.
 */
export function rodPose(hand: { x: number; y: number }, float: { x: number; y: number }, scale: number): RodPose {
  const dx = float.x - hand.x;
  const dy = float.y - hand.y;
  const flipX = dx < -2;
  const want = Math.min(1.1, Math.max(-0.6, Math.atan2(dy, flipX ? -dx : dx) - 0.5));
  const base = Math.atan2(ROD_ART.tip.y - ROD_ART.grip.y, ROD_ART.tip.x - ROD_ART.grip.x);
  const len = (Math.hypot(ROD_ART.tip.x - ROD_ART.grip.x, ROD_ART.tip.y - ROD_ART.grip.y) / ROD_ART.density) * scale;
  const rot = want - base;
  return {
    flipX,
    rotation: flipX ? -rot : rot,
    tip: { x: hand.x + (flipX ? -1 : 1) * Math.cos(want) * len, y: hand.y + Math.sin(want) * len },
  };
}
