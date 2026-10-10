/**
 * The level-20 moves' rules on the screen (docs/design/crafts.md 4.3): what
 * Stand, Kindle and Echo change about a fight while they last. The fight is
 * client-side, like the signatures; the server only bounds the mana and the
 * healing (4.4). Pure: the hero writes into the field, the creatures read
 * it each frame (src/game/entities/enemies.ts), tests drive it directly.
 * None of it touches the Warden.
 */
import { TILE } from './tile.ts';
import { HEAL_FORMULA } from './combat-timing.ts';

/** Planted (Stand): a lunge that would reach the hero stops short and staggers. */
export interface FieldStand {
  left: number;
  stagger: number;
}

/** A patch of hollow light (Kindle): creatures inside move at `slow` of their speed. */
export interface FieldPatch {
  x: number;
  y: number;
  /** Radius, world px. */
  r: number;
  slow: number;
  left: number;
}

/** A faded copy (Echo): creatures aim at it instead of the hero. */
export interface FieldDecoy {
  x: number;
  y: number;
  left: number;
}

/** A lunge that comes this much closer than its reach still stops short of a planted hero (world px). */
export const STAND_MARGIN = 4;

export class CombatField {
  stand: FieldStand | null = null;
  patches: FieldPatch[] = [];
  decoy: FieldDecoy | null = null;

  /** Time passes (seconds): what has run out goes. */
  tick(dt: number): void {
    if (this.stand && (this.stand.left -= dt) <= 0) this.stand = null;
    for (const p of this.patches) p.left -= dt;
    this.patches = this.patches.filter((p) => p.left > 0);
    if (this.decoy && (this.decoy.left -= dt) <= 0) this.decoy = null;
  }

  /** The hero is planted: no walking, and lunges stop short. */
  get planted(): boolean {
    return this.stand !== null;
  }

  plant(seconds: number, stagger: number): void {
    this.stand = { left: seconds, stagger };
  }

  kindle(x: number, y: number, r: number, slow: number, seconds: number): void {
    this.patches.push({ x, y, r, slow, left: seconds });
  }

  echo(x: number, y: number, seconds: number): void {
    this.decoy = { x, y, left: seconds };
  }

  /** The speed multiplier at a point: the slowest patch it stands in, 1 outside them all. */
  slowAt(x: number, y: number): number {
    let k = 1;
    for (const p of this.patches) if (inCircle(x, y, p.x, p.y, p.r)) k = Math.min(k, p.slow);
    return k;
  }

  /** Where creatures aim: the decoy while it lasts, else the hero (`at`). */
  aimFor(at: { x: number; y: number }): { x: number; y: number } {
    return this.decoy ? { x: this.decoy.x, y: this.decoy.y } : at;
  }

  /** A new area or a fall: nothing carries over. */
  clear(): void {
    this.stand = null;
    this.patches = [];
    this.decoy = null;
  }
}

export function inCircle(px: number, py: number, cx: number, cy: number, r: number): boolean {
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Kindle's patch: `reachTiles` ahead of the hero's feet in their facing (no aiming; the same on every device). */
export function kindleSpot(x: number, y: number, facing: { x: number; y: number }, reachTiles: number): { x: number; y: number } {
  const len = Math.hypot(facing.x, facing.y) || 1;
  return { x: x + (facing.x / len) * reachTiles * TILE, y: y + (facing.y / len) * reachTiles * TILE };
}

/**
 * When a Ward-light's pulses land (seconds after the cast): the first a
 * second in, the last a second before it fades, evenly between —
 * 1, 2.5 and 4 s for the table's 5 s and 3 pulses.
 */
export function wardPulseTimes(durationSeconds: number, pulses: number): number[] {
  if (pulses <= 0) return [];
  if (pulses === 1) return [Math.min(1, durationSeconds)];
  const first = Math.min(1, durationSeconds / 2);
  const last = Math.max(first, durationSeconds - 1);
  const step = (last - first) / (pulses - 1);
  return Array.from({ length: pulses }, (_, i) => Math.round((first + step * i) * 1000) / 1000);
}

/**
 * One Ward-light pulse (crafts.md 4.3: "each pulse is 0.4 of your Mend"):
 * the caster's Mend times the table's share, unrounded, exactly as the
 * server's rules.WardPulseHeal credits it (content/vectors/magic.json pins
 * the two together).
 */
export function wardPulseHeal(mend: number, pulseHealFraction: number): number {
  return mend * pulseHealFraction;
}

/**
 * A friend's pulse on this screen: the hub's own number when the relayed
 * cast carries one (filled from the caster's profile), else a Mend's base
 * share — the friend's stats aren't on this screen.
 */
export function friendPulseHeal(relayed: number | undefined, pulseHealFraction: number): number {
  return relayed !== undefined && Number.isFinite(relayed) && relayed > 0 ? relayed : wardPulseHeal(HEAL_FORMULA.base, pulseHealFraction);
}
