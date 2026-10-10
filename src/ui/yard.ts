/**
 * Silas's Yard, the panel's rules without the panel (silas-yard.md 2.5):
 * which tab it opens on, what Furnish's chips keep, what Mend lists and
 * whether Silas is near enough to mend, and how many of a bundle are left
 * today. src/ui/YardPanel.svelte draws them; the server checks every buy.
 */
import type { YardTab } from '../game/event-names.ts'
import type { InstanceView } from '../lib/api/items.ts'
import type { HomeItem, HomesteadData } from '../lib/homestead.ts'
import { HOMESTEAD_DATA, shopSections } from '../lib/homestead.ts'
import { ITEM_RULES, itemDef, menderNear } from '../lib/items.ts'
import { residentAt, residentById } from '../lib/residents.ts'
import { TILE } from '../lib/tile.ts'

export type { YardTab } from '../game/event-names.ts'

export const YARD_TABS: readonly { id: YardTab; label: string }[] = [
  { id: 'build', label: 'Build' },
  { id: 'furnish', label: 'Furnish' },
  { id: 'materials', label: 'Materials' },
  { id: 'mend', label: 'Mend' }
]

/** The next tier Silas can raise on your deed (a purchasable one: the cottage, then the workshop), or null (no deed, or nothing more to raise). */
export function nextTier(tier: number | null, data: HomesteadData = HOMESTEAD_DATA): number | null {
  if (tier === null) return null
  return data.tiers[tier + 1]?.purchasable ? tier + 1 : null
}

/** Where the panel opens: Build while an upgrade is open to you (a cottage or a workshop to raise), otherwise Furnish. */
export function defaultYardTab(tier: number | null, data: HomesteadData = HOMESTEAD_DATA): YardTab {
  return nextTier(tier, data) !== null ? 'build' : 'furnish'
}

export type FurnishFilter = 'all' | 'indoor' | 'outdoor'

export const FURNISH_FILTERS: readonly { id: FurnishFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'indoor', label: 'Indoors' },
  { id: 'outdoor', label: 'Outdoors' }
]

/**
 * The tabs' goods from the shop's sections: Build holds the buildings and
 * the lantern post (the next post's price); Furnish every other piece Silas
 * sells, finished ones first, then those from the Wilds.
 */
export function yardGoods(data: HomesteadData = HOMESTEAD_DATA): { build: HomeItem[]; furnish: HomeItem[] } {
  const { buildings, finished, wilds } = shopSections(data)
  const post = data.lanternPosts.item
  const pieces = [...finished, ...wilds]
  return { build: [...buildings, ...pieces.filter((i) => i.id === post)], furnish: pieces.filter((i) => i.id !== post) }
}

/** Furnish's chips: a piece that goes indoors or out shows under both. */
export function furnishFilter(items: readonly HomeItem[], f: FurnishFilter): HomeItem[] {
  return f === 'all' ? [...items] : items.filter((i) => i.where.includes(f))
}

/** A tool in your pack that Silas could mend, and his price. */
export interface MendRow {
  instance: string
  itemDef: string
  name: string
  condition: number
  maxCondition: number
  glims: number
  /** The mender's materials, if the tool's repair names any. */
  materials: Record<string, number>
}

/**
 * Mend's list: the tools in your pack that need mending and that a mender
 * mends (an heirloom with a repair; a cheap tool just breaks). Warden-set
 * tools heal on their own and aren't listed.
 */
export function mendList(instances: readonly InstanceView[]): MendRow[] {
  const out: MendRow[] = []
  for (const inst of instances) {
    const d = itemDef(inst.itemDef)
    if (!d?.repair || inst.wardenSet || inst.condition >= inst.maxCondition) continue
    out.push({
      instance: inst.id,
      itemDef: inst.itemDef,
      name: d.name,
      condition: inst.condition,
      maxCondition: inst.maxCondition,
      glims: d.repair.menderGlims ?? 0,
      materials: { ...(d.repair.mender ?? {}) }
    })
  }
  return out.sort((a, b) => a.condition / a.maxCondition - b.condition / b.maxCondition || a.name.localeCompare(b.name))
}

/**
 * Whether Silas is near enough to mend (`here`: your area and feet, in
 * pixels; `now`: the server's Unix seconds). With a cycle (0.7) he mends
 * wherever it has him; until then, at his mender row's spot. The radius is
 * his mender row's. The server checks again.
 */
export function silasInReach(here: { area: string; x: number; y: number }, now: number): boolean {
  const row = ITEM_RULES.menders.find((m) => m.npc === 'silas')
  if (!residentById('silas')) return menderNear(here.area, here.x, here.y)?.npc === 'silas'
  const at = residentAt('silas', now)
  if (!at || at.area !== here.area) return false
  const r = (row?.radiusTiles ?? 4) * TILE
  return Math.hypot(here.x - (at.tx * TILE + TILE / 2), here.y - (at.ty * TILE + TILE / 2)) <= r
}

/** The start of the UTC day `nowS` falls in (the sellers' caps count from it, as the server does). */
export function utcDayStart(nowS: number): number {
  return Math.floor(nowS / 86_400) * 86_400
}

/** A Glim log line as far as a cap cares (src/lib/gen/glimway/v1/purse_pb PurseLine). */
export interface BuyLine {
  at: number
  reason: string
  seller: string
  itemDef: string
}

/**
 * How many of each good you bought from a seller today, from the Glim log's
 * lines (`sellerName`: the seller's npc, as the line names it).
 */
export function boughtToday(lines: readonly BuyLine[], sellerName: string, nowS: number): Record<string, number> {
  const from = utcDayStart(nowS)
  const out: Record<string, number> = {}
  for (const l of lines) if (l.reason === 'market-buy' && l.seller === sellerName && l.at >= from) out[l.itemDef] = (out[l.itemDef] ?? 0) + 1
  return out
}

/** "2 of 3 left today", or null for a good with no cap. */
export function leftToday(cap: number, bought: number): string | null {
  if (cap <= 0) return null
  return `${Math.max(0, cap - bought)} of ${cap} left today`
}
