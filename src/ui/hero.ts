import { DEMO_CHARACTER } from '../content/world'
import type { HabiticaProfile } from '../lib/habitica/types'

/**
 * The hero's name, class and level as the Character panel and the bag's
 * hero row show them: the imported Habitica hero, or the guest's wayfarer.
 */
export function heroLine(profile: HabiticaProfile | null): { name: string; className: string; level: number } {
  return {
    name: profile?.name ?? DEMO_CHARACTER.name,
    className: profile?.class ? profile.class[0].toUpperCase() + profile.class.slice(1) : profile ? 'Adventurer' : 'Wayfarer',
    level: profile?.level ?? DEMO_CHARACTER.level
  }
}
