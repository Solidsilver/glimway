/**
 * Habitica companions as the game shows them (crafts.md 2): names, species
 * groups and the follower a hero walks with. Rule 1 of 0.5: the game shows
 * Habitica's companions and never makes or grants them, so everything here
 * reads keys the account owns and never invents one.
 */
import type { HabiticaProfile } from './habitica/types.ts'
import type { Companions } from './gen/glimway/v1/companions_pb.js'
import type { StallView } from './api/homestead.ts'

/** "CottonCandyBlue" → "Cotton Candy Blue"; "BearCub" → "Bear Cub". */
function words(part: string): string {
  return part.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2')
}

/** Habitica keys are `Species-Potion`: `Fox-Golden` sits under Fox. */
export function speciesOf(key: string): string {
  const dash = key.indexOf('-')
  return words(dash < 0 ? key : key.slice(0, dash))
}

/** `Fox-Golden` → "Golden Fox"; a key without a potion reads as its species. */
export function companionName(key: string): string {
  const dash = key.indexOf('-')
  if (dash < 0) return words(key)
  return `${words(key.slice(dash + 1))} ${words(key.slice(0, dash))}`
}

export interface SpeciesGroup {
  species: string
  keys: string[]
}

/** Owned keys grouped by species, both in name order (the picker's grid and chips). */
export function groupBySpecies(keys: readonly string[]): SpeciesGroup[] {
  const by = new Map<string, string[]>()
  for (const key of [...new Set(keys)].sort((a, b) => companionName(a).localeCompare(companionName(b)))) {
    const s = speciesOf(key)
    const list = by.get(s)
    if (list) list.push(key)
    else by.set(s, [key])
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([species, list]) => ({ species, keys: list }))
}

/** The picker's search: by name or species, case-insensitive. */
export function matchesSearch(key: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return companionName(key).toLowerCase().includes(q) || key.toLowerCase().includes(q)
}

/**
 * The follower choice "No pet": the hero walks alone. A reserved value of
 * `follow_pet`, as the server spells it (store.NoFollower): Habitica's keys
 * are `Species-Potion`, so no pet is ever called this.
 */
export const NO_PET = 'none'

/**
 * The pet that walks with the hero: the chosen follower when the server's
 * resolved state names one (it already fell back for a lapsed key), none for
 * No pet, else Habitica's current pet. Null: no follower at all (no pets is
 * no pet, never a stand-in).
 */
export function followerKey(profile: Pick<HabiticaProfile, 'selectedPet'> | null, companions: Pick<Companions, 'followPet'> | null | undefined): string | null {
  const chosen = companions?.followPet ?? ''
  if (chosen === NO_PET) return null
  if (chosen) return chosen
  return profile?.selectedPet || null
}

/**
 * The stable's bays as this screen shows them (crafts.md 3.1): the server's
 * `HomeView.stalls`, with your own mount's comings and goings on top, since
 * your screen knows them before the homestead is read again. Your stalled
 * mount is out while your companions say so (ridden, on the lead, or
 * saddling up) and while it's still walking home (`homeward`: mount key →
 * when it's off the screen, ms on `now`'s clock). A partner's stays as the
 * server last said, and so does yours while your companions aren't read
 * yet (`mine` null).
 */
export function stallsShown(
  stalls: readonly StallView[],
  homeId: string,
  me: string | null,
  mine: { mountOut: string; mountHome: string } | null,
  homeward: ReadonlyMap<string, number>,
  now: number
): StallView[] {
  return stalls.map((s) => {
    if (!me || !s.mount || s.ownerId !== me) return s
    const out = (mine ? mine.mountOut === s.mount && mine.mountHome === homeId : s.out) || (homeward.get(s.mount) ?? 0) > now
    return out === s.out ? s : { ...s, out }
  })
}

/** When the next of your mounts walking home is off the screen and back in its bay (null: none is). */
export function nextHomecoming(stalls: readonly StallView[], me: string | null, homeward: ReadonlyMap<string, number>, now: number): number | null {
  let next: number | null = null
  for (const s of stalls) {
    const until = s.mount && s.ownerId === me ? homeward.get(s.mount) ?? 0 : 0
    if (until > now && (next === null || until < next)) next = until
  }
  return next
}

/** The bays standing full, as a signature: when it changes, the stable is drawn again. */
export function baySig(shown: readonly StallView[]): string {
  return shown.map((s) => (s.mount && !s.out ? s.mount : '')).join(',')
}

/**
 * What a change to your companions asks of the stable's drawing (`drawn`:
 * the signature last drawn): a redraw when a bay filled or emptied; else,
 * while a mount of yours walks home, a recheck for when it's off the screen.
 * A Go home on your own land changes nothing visible at first (the bay stays
 * empty while it walks), so only that recheck ever fills the bay.
 */
export function stableNext(
  stalls: readonly StallView[],
  shown: readonly StallView[],
  drawn: string,
  me: string | null,
  homeward: ReadonlyMap<string, number>,
  now: number
): { redraw: boolean; recheckAt: number | null } {
  if (baySig(shown) !== drawn) return { redraw: true, recheckAt: null }
  return { redraw: false, recheckAt: nextHomecoming(stalls, me, homeward, now) }
}
