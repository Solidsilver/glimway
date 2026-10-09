/**
 * Habitica companions as the game shows them (crafts.md 2): names, species
 * groups and the follower a hero walks with. Rule 1 of 0.5: the game shows
 * Habitica's companions and never makes or grants them, so everything here
 * reads keys the account owns and never invents one.
 */
import type { HabiticaProfile } from './habitica/types.ts'
import type { Companions } from './gen/glimway/v1/companions_pb.js'

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
 * The pet that walks with the hero: the chosen follower when the server's
 * resolved state names one (it already fell back for a lapsed key), else
 * Habitica's current pet. Null: no follower at all (no pets is no pet, never
 * a stand-in).
 */
export function followerKey(profile: Pick<HabiticaProfile, 'selectedPet'> | null, companions: Pick<Companions, 'followPet'> | null | undefined): string | null {
  const chosen = companions?.followPet ?? ''
  if (chosen) return chosen
  return profile?.selectedPet || null
}
