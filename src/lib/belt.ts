/**
 * The hand slot and the belt (playtest 1, held items): what the hero holds
 * decides what the action does. Slot 1 is always the weapon; then one slot
 * per kind of tool carried (axe, pick, spade, bucket, can, …), the best of
 * each, in a fixed order. Nothing to set up: a new tool joins the belt.
 *
 * What's in hand is a choice on this device (src/game/held.ts keeps it), not
 * part of the save: the save's flags only ever grow on the server. No Phaser,
 * no network.
 */
import { itemDef } from './items.ts';
import type { InstanceView } from './api/types.ts';

/** A belt slot's kind: the weapon, or a tool action (content/items.json `actions`). */
export type BeltKind = 'weapon' | 'chop' | 'break' | 'dig' | 'draw' | 'water' | 'trim' | 'mark';

/** Belt order (and keys 1, 2, … follow it, over the kinds you carry). */
export const BELT_ORDER: readonly BeltKind[] = ['weapon', 'chop', 'break', 'dig', 'draw', 'water', 'trim', 'mark'];

export interface BeltSlot {
  kind: BeltKind;
  /** The carried tool in this slot (null for the weapon). */
  instance: string | null;
  itemDef: string | null;
  /** A blunt or cracked tool still sits on the belt, but won't work. */
  usable: boolean;
}

/** Wear states that refuse work. */
const UNUSABLE = new Set(['blunt', 'cracked']);

/**
 * The belt for what's carried: the weapon, then each tool kind's best tool
 * (a usable one first, then the keenest: an ordinary state before a dull one).
 */
export function beltFor(instances: readonly InstanceView[] | null | undefined): BeltSlot[] {
  const slots: BeltSlot[] = [{ kind: 'weapon', instance: null, itemDef: null, usable: true }];
  for (const kind of BELT_ORDER.slice(1)) {
    const tools = (instances ?? []).filter((i) => {
      const d = itemDef(i.itemDef);
      return d?.kind === 'tool' && d.actions?.includes(kind);
    });
    if (!tools.length) continue;
    const rank = (i: InstanceView) => (UNUSABLE.has(i.state) ? 2 : i.state === 'dull' ? 1 : 0);
    const best = [...tools].sort((a, b) => rank(a) - rank(b) || b.usesLeft - a.usesLeft)[0];
    slots.push({ kind, instance: best.id, itemDef: best.itemDef, usable: !UNUSABLE.has(best.state) });
  }
  return slots;
}

/** The slot for a kind, or the weapon when that kind isn't carried (any more). */
export function heldSlot(belt: readonly BeltSlot[], kind: BeltKind): BeltSlot {
  return belt.find((s) => s.kind === kind) ?? belt[0];
}

/** The kind a number key picks (1-based over the belt as carried), or null. */
export function kindForKey(belt: readonly BeltSlot[], n: number): BeltKind | null {
  return belt[n - 1]?.kind ?? null;
}

/** The next or previous kind on the belt (scroll wheel), wrapping round. */
export function stepKind(belt: readonly BeltSlot[], kind: BeltKind, dir: 1 | -1): BeltKind {
  const i = Math.max(0, belt.findIndex((s) => s.kind === kind));
  return belt[(i + dir + belt.length) % belt.length].kind;
}

/** Words for a slot (buttons, hints): the tool's own name, or the kind. */
export const KIND_WORDS: Record<BeltKind, string> = {
  weapon: 'Weapon',
  chop: 'Axe',
  break: 'Pick',
  dig: 'Spade',
  draw: 'Bucket',
  water: 'Watering can',
  trim: 'Lamplighter pole',
  mark: 'Oak-mark punch'
};
