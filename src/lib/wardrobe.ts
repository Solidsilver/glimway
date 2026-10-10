/**
 * The wardrobe as the game shows it (purse-and-wardrobe.md 4): the eight
 * drawn slots, the look a choice makes, piece names, the picker's grouping
 * and sets. Rule 3 of 0.6: the game shows Habitica's gear and never makes or
 * grants it. The owned list comes only from the server's own reads
 * (`GET /api/wardrobe`), and `PlayerState.wardrobe` arrives already resolved,
 * so nothing here checks ownership: it draws and names keys it is given.
 */
import { CATALOG, isNonePiece } from './habitica/gear.ts'
import type { AvatarProfileFull } from './habitica/avatar.ts'
import type { HabiticaProfile } from './habitica/types.ts'

/** The eight drawn slots, in the order the Wardrobe tab lists them (`weaponSpecial` is never drawn). */
export const WARDROBE_SLOTS = ['head', 'headAccessory', 'eyewear', 'armor', 'body', 'back', 'weapon', 'shield'] as const
export type WardrobeSlot = (typeof WARDROBE_SLOTS)[number]

/** What the tab calls each slot (question 9: the wardrobe says "Shield"). */
export const SLOT_NAMES: Record<WardrobeSlot, string> = {
  head: 'Head',
  headAccessory: 'Head extra',
  eyewear: 'Eyewear',
  armor: 'Armor',
  body: 'Body',
  back: 'Back',
  weapon: 'Weapon',
  shield: 'Shield'
}

/** The reserved choice "Nothing": no Habitica key is spelled like this (they're `type_klass_index`). */
export const NOTHING = 'none'

/** Slot → a gear key or `NOTHING`; a slot left out is As on Habitica. */
export type WardrobeChoice = Readonly<Record<string, string>>
export type Look = Record<WardrobeSlot, string | null>

/**
 * The look a choice makes (4.2, shared vectors `content/vectors/wardrobe.json`
 * `lookFor`, replayed by rules.Look on the server): Nothing draws nothing, a
 * chosen key draws itself, and anything else is what Habitica shows there now
 * (the costume when Show costume is on, the battle gear when it's off). A
 * slot Habitica has nothing for is null. The avatar's own rules come after,
 * unchanged: a two-handed weapon hides the shield, a `*_base_0` piece draws
 * nothing.
 */
export function lookFor(profile: Pick<HabiticaProfile, 'equipped' | 'costume' | 'useCostume'>, chosen: WardrobeChoice): Look {
  const habitica = profile.useCostume === true ? profile.costume ?? {} : profile.equipped
  const look = {} as Look
  for (const slot of WARDROBE_SLOTS) {
    const c = Object.hasOwn(chosen, slot) ? chosen[slot] : ''
    look[slot] = c === NOTHING ? null : c ? c : (Object.hasOwn(habitica, slot) && habitica[slot]) || null
  }
  return look
}

/** Whether a choice changes anything: no slot chosen is exactly Habitica's look. */
export function choosesAny(chosen: WardrobeChoice | null | undefined): boolean {
  return !!chosen && WARDROBE_SLOTS.some((s) => !!chosen[s])
}

/**
 * The profile the hero is drawn from with a wardrobe on (4.4): the look as
 * the costume. With nothing chosen the profile is drawn as it is, so
 * Habitica's look (and every slot outside the eight) stays exactly as before.
 */
export function wornProfile<P extends Pick<HabiticaProfile, 'equipped' | 'costume' | 'useCostume'>>(profile: P, chosen: WardrobeChoice | null | undefined): P {
  if (!chosen || !choosesAny(chosen)) return profile
  return { ...profile, useCostume: true, costume: lookFor(profile, chosen) }
}

/** `admiralsUniform` → "Admirals Uniform": the key's words, when the catalog has no name. */
function words(part: string): string {
  const w = part.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2')
  return w.charAt(0).toUpperCase() + w.slice(1)
}

/** A piece's name: Habitica's English `text` from the catalog, else the key's words. */
export function gearName(key: string): string {
  const item = Object.hasOwn(CATALOG.gear, key) ? CATALOG.gear[key] : undefined
  if (item?.text) return item.text
  return words(item?.index || key.split('_').slice(2).join('_') || key)
}

/** The picker's chips (4.1), from the catalog's `klass`; Habitica calls the mage "wizard" and subscriber gear "mystery". */
export const GEAR_CLASSES: readonly { klass: string; label: string }[] = [
  { klass: 'warrior', label: 'Warrior' },
  { klass: 'wizard', label: 'Mage' },
  { klass: 'rogue', label: 'Rogue' },
  { klass: 'healer', label: 'Healer' },
  { klass: 'armoire', label: 'Armoire' },
  { klass: 'special', label: 'Special' },
  { klass: 'mystery', label: 'Subscriber' }
]

/**
 * The owned pieces a slot can wear, in name order: the catalog knows them,
 * they're that slot's type, and they're not a `*_base_0` "none" piece.
 */
export function piecesFor(owned: readonly string[], slot: WardrobeSlot): string[] {
  return [...new Set(owned)]
    .filter((k) => Object.hasOwn(CATALOG.gear, k) && CATALOG.gear[k].type === slot && !isNonePiece(k))
    .sort((a, b) => gearName(a).localeCompare(gearName(b)) || a.localeCompare(b))
}

export interface ClassGroup {
  klass: string
  label: string
  keys: string[]
}

/** Pieces grouped by the chips' classes, in chip order, empty groups left out (order kept within each). */
export function groupByClass(keys: readonly string[]): ClassGroup[] {
  return GEAR_CLASSES.map((c) => ({ ...c, keys: keys.filter((k) => CATALOG.gear[k]?.klass === c.klass) })).filter((g) => g.keys.length > 0)
}

/** The picker's search: by name or key, case-insensitive. */
export function matchesGear(key: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return gearName(key).toLowerCase().includes(q) || key.toLowerCase().includes(q)
}

/**
 * Wear the whole set (4.1): the other slots' owned pieces of `key`'s set
 * (the catalog's `set`), slot → key, leaving out what the hero already wears
 * (`worn`: the look now, `lookFor`, so a piece shown As on Habitica counts).
 * Empty when there's nothing more to put on. One piece per slot: the first
 * in name order.
 */
export function setPieces(key: string, owned: readonly string[], worn: Readonly<Record<string, string | null>>): Partial<Record<WardrobeSlot, string>> {
  const set = CATALOG.gear[key]?.set
  const out: Partial<Record<WardrobeSlot, string>> = {}
  if (!set) return out
  const own = CATALOG.gear[key].type
  for (const slot of WARDROBE_SLOTS) {
    if (slot === own) continue
    const k = piecesFor(owned, slot).find((p) => CATALOG.gear[p].set === set)
    if (k && worn[slot] !== k) out[slot] = k
  }
  return out
}

/** The whole choice with one slot changed: '' is As on Habitica (the slot left out). */
export function withSlot(chosen: WardrobeChoice, slot: WardrobeSlot, value: string): Record<string, string> {
  const next: Record<string, string> = {}
  for (const s of WARDROBE_SLOTS) if (s !== slot && chosen[s]) next[s] = chosen[s]
  if (value) next[slot] = value
  return next
}

/** How a slot row reads (4.1): As on Habitica (and what Habitica shows there), a piece, or Nothing. */
export type SlotReading = { kind: 'habitica'; shows: string | null } | { kind: 'piece'; key: string } | { kind: 'nothing' }

export function readSlot(profile: Pick<HabiticaProfile, 'equipped' | 'costume' | 'useCostume'>, chosen: WardrobeChoice, slot: WardrobeSlot): SlotReading {
  const c = chosen[slot]
  if (c === NOTHING) return { kind: 'nothing' }
  if (c) return { kind: 'piece', key: c }
  const shows = lookFor(profile, {})[slot]
  return { kind: 'habitica', shows: shows && !isNonePiece(shows) ? shows : null }
}

/** Where a tile is cropped on the 90 px Habitica canvas (4.1): the head, the torso, or the whole figure. */
export type TileCrop = 'head' | 'torso' | 'whole'

export function cropFor(slot: WardrobeSlot): TileCrop {
  if (slot === 'head' || slot === 'headAccessory' || slot === 'eyewear') return 'head'
  if (slot === 'armor' || slot === 'body') return 'torso'
  return 'whole'
}

/**
 * The plain figure a picker tile shows (4.1): your own skin and shirt, the
 * bare head, and the one piece; no hair, no other gear, no companions.
 * `key` null draws the figure with nothing in that slot.
 */
export function tileProfile(profile: HabiticaProfile, slot: WardrobeSlot, key: string | null): AvatarProfileFull {
  const gear: Record<string, string | null> = key ? { [slot]: key } : {}
  return {
    ...profile,
    equipped: gear,
    costume: gear,
    useCostume: false,
    selectedPet: null,
    selectedMount: null,
    appearance: { ...profile.appearance, hairStyle: 0, hairBangs: undefined, hairMustache: undefined, hairBeard: undefined, hairFlower: undefined }
  }
}
