/**
 * The hand slot and the belt (playtest 1, held items): what the hero holds
 * decides what the action does. Slot 1 is always the weapon; then one slot
 * per kind of tool carried (axe, pick, spade, trowel, bucket, can, …), the
 * best of each, in a fixed order, and last the empty hands (lane
 * exp/empty-hands, key 0: the only way the action button offers a pet).
 * Nothing to set up: a new tool joins the belt.
 *
 * What's in hand is a choice on this device (src/game/held.ts keeps it), not
 * part of the save: the save's flags only ever grow on the server. No Phaser,
 * no network.
 */
import { itemDef } from './items.ts';
import type { InstanceView } from './api/types.ts';

/** A belt slot's kind: the weapon, a tool action (content/items.json `actions`), or the empty hands. */
export type BeltKind = 'weapon' | 'chop' | 'break' | 'dig' | 'uproot' | 'fish' | 'draw' | 'water' | 'trim' | 'mark' | 'hands';

/** Belt order (keys 1, 2, … follow it over the kinds you carry; the hands are last, on 0). */
export const BELT_ORDER: readonly BeltKind[] = ['weapon', 'chop', 'break', 'dig', 'uproot', 'fish', 'draw', 'water', 'trim', 'mark', 'hands'];

/** The kinds a carried tool can fill (everything but the weapon and the hands). */
const TOOL_KINDS: readonly BeltKind[] = BELT_ORDER.filter((k) => k !== 'weapon' && k !== 'hands');

/**
 * What a press or a click does with each kind in hand when there's nothing
 * for it to work on (the owner's playtest: "you probably couldn't attack with
 * a fishing rod"). The weapon strikes; the sturdy tools (axe, pick, spade)
 * swing, a duller arc at half the damage, enough to fend off a wisp; the rest
 * (trowel, rod, bucket, can, pole, punch) don't swing at all.
 */
export const SWING: Readonly<Record<BeltKind, 'weapon' | 'tool' | null>> = {
  weapon: 'weapon',
  chop: 'tool',
  break: 'tool',
  dig: 'tool',
  uproot: null,
  fish: null,
  draw: null,
  water: null,
  trim: null,
  mark: null,
  hands: null
};

/**
 * The hero's thought when a tool that doesn't swing is pressed at nothing
 * ("You can’t fight with a willow rod."; empty hands: "Your hands are empty.").
 */
export function noSwingThought(toolName: string | null | undefined, kind: BeltKind = 'weapon'): string {
  if (kind === 'hands') return 'Your hands are empty.';
  const name = toolName?.trim().toLowerCase();
  if (!name) return 'That’s no thing to fight with.';
  return `You can’t fight with ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}.`;
}

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
  for (const kind of TOOL_KINDS) {
    const tools = (instances ?? []).filter((i) => {
      const d = itemDef(i.itemDef);
      return d?.kind === 'tool' && d.actions?.includes(kind);
    });
    if (!tools.length) continue;
    const rank = (i: InstanceView) => (UNUSABLE.has(i.state) ? 2 : i.state === 'dull' ? 1 : 0);
    const best = [...tools].sort((a, b) => rank(a) - rank(b) || b.usesLeft - a.usesLeft)[0];
    slots.push({ kind, instance: best.id, itemDef: best.itemDef, usable: !UNUSABLE.has(best.state) });
  }
  // The empty hands are always on the belt, always last (their own key: 0).
  slots.push({ kind: 'hands', instance: null, itemDef: null, usable: true });
  return slots;
}

/** The slot for a kind, or the weapon when that kind isn't carried (any more). */
export function heldSlot(belt: readonly BeltSlot[], kind: BeltKind): BeltSlot {
  return belt.find((s) => s.kind === kind) ?? belt[0];
}

/**
 * The kind a number key picks: 1…9 over the weapon and tools as carried,
 * 0 over the empty hands (always there), or null.
 */
export function kindForKey(belt: readonly BeltSlot[], n: number): BeltKind | null {
  if (n === 0) return belt.some((s) => s.kind === 'hands') ? 'hands' : null;
  return belt.filter((s) => s.kind !== 'hands')[n - 1]?.kind ?? null;
}

/** The key that takes a slot in hand (0 for the hands): what the belt's buttons show. */
export function keyForSlot(belt: readonly BeltSlot[], kind: BeltKind): number {
  if (kind === 'hands') return 0;
  return belt.filter((s) => s.kind !== 'hands').findIndex((s) => s.kind === kind) + 1;
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
  uproot: 'Trowel',
  fish: 'Fish',
  draw: 'Bucket',
  water: 'Watering can',
  trim: 'Lamplighter pole',
  mark: 'Oak-mark punch',
  hands: 'Empty hands'
};
