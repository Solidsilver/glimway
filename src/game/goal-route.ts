/**
 * Where a quest step's target is, worked out without the scene (the goal
 * guide, ./entities/goal-guide.ts, draws the needle, the edge glint and the
 * glow from it; tests read it under node). A step's `where` names an area
 * and a person, a spot or an enemy. A resident's place is their schedule's
 * (src/lib/residents.ts): when the step names a resident, the schedule says
 * which area they're in, and the needle and the glow agree on it.
 */
import type { QuestWhere } from '../lib/quests.ts'
import { residentAt, type ResidentPlace } from '../lib/residents.ts'
import { TILE } from '../lib/tile.ts'

export interface Point {
  x: number
  y: number
}

/** Live positions in the scene (null when the thing isn't here). */
export interface QuestLook {
  npcAt: (id: string) => Point | null
  spotAt: (id: string) => Point | null
  wardenAt: () => Point | null
  enemyAt: (id: string) => Point | null
  /** What a quest enemy lies on (the lost finger under the finger-wisp): the glow's natural place. */
  lootAt: (enemy: string) => Point | null
}

/** A step's place: its area, and the resident's spot when the step names one (null: the journal, or nowhere). */
export function questPlace(where: QuestWhere, now: number, at: (id: string, now: number) => ResidentPlace | null = residentAt): { area: string; resident: ResidentPlace | null } | null {
  if (where.ui) return null // the journal: the book button glows instead
  const resident = where.npc ? at(where.npc, now) : null
  // The schedule wins over the step's area: that's where the person is drawn.
  const area = resident?.area ?? where.area
  return area ? { area, resident } : null
}

/**
 * The target itself, in this (its) area: the enemy (or what it lies on), the
 * person, or the spot; a resident not drawn yet stands at their schedule's
 * tile. `id` is what it is ("finger-wisp", "orrin", "road-1").
 */
export function questPointHere(where: QuestWhere, resident: ResidentPlace | null, look: QuestLook): (Point & { id: string }) | null {
  const tag = (id: string, p: Point | null) => (p ? { ...p, id } : null)
  if (where.enemy === 'stone-warden') {
    // The warden, or its route stone while it isn't standing up to be settled.
    const w = tag('stone-warden', look.wardenAt() ?? look.spotAt('clue'))
    if (w) return w
  } else if (where.enemy) {
    const e = tag(where.enemy, look.lootAt(where.enemy) ?? look.enemyAt(where.enemy))
    if (e) return e
  }
  if (where.npc) {
    const n = tag(where.npc, look.npcAt(where.npc) ?? (resident ? { x: (resident.tx + 0.5) * TILE, y: (resident.ty + 0.5) * TILE } : null))
    if (n) return n
  }
  return where.spot ? tag(where.spot, look.spotAt(where.spot)) : null
}
