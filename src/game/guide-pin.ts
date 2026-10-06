/**
 * The pinned "How do I…?" guide (src/lib/guides.ts): one per device, in
 * localStorage. While one is pinned (and not done), the goal line, its
 * needle and the edge glow follow its current step instead of the story.
 * Also builds the GuideContext from what this session knows.
 */
import { bus, EV } from './events'
import type { Session } from './session'
import { guideById, guideProgress, type GuideContext, type GuideProgress } from '../lib/guides'
import { homesteadsFor } from './homestead'
import { itemsFor } from './items'
import { villageFor } from './village'
import { itemDef } from '../lib/items'
import { HEARTH_RECIPES } from '../lib/workshop'

const KEY = 'fingersnap:pinned-guide'

function load(): string | null {
  try {
    const v = localStorage.getItem(KEY)
    return v && guideById(v) ? v : null
  } catch {
    return null
  }
}

export const pinned = { id: load() }

/** Pin a guide (null unpins). EV.guidePin tells the HUD and the scene. */
export function setPinned(id: string | null): void {
  if (pinned.id === id) return
  pinned.id = id
  try {
    if (id) localStorage.setItem(KEY, id)
    else localStorage.removeItem(KEY)
  } catch {
    /* kept for this visit */
  }
  bus.emit(EV.guidePin, { id })
}

const HEARTH_MADE = new Set(HEARTH_RECIPES.map((r) => r.output.id))

/** What the guides can see of this player now. */
export function guideContext(session: Session): GuideContext {
  const homes = session.link ? homesteadsFor(session) : null
  const village = session.link ? villageFor(session) : null
  const view = session.link ? itemsFor(session).view : null
  const mine = homes?.mine ?? null
  const me = homes?.myId ?? null
  const instances = view?.instances ?? []
  const tools = new Set<string>()
  for (const i of instances) {
    const d = itemDef(i.itemDef)
    if (d?.kind === 'tool') for (const a of d.actions ?? []) tools.add(a)
  }
  const goods = new Map<string, boolean>()
  for (const it of mine?.items ?? []) goods.set(it.itemDef, (goods.get(it.itemDef) ?? false) || it.scene !== null)
  for (const [def, n] of Object.entries(village?.inventory?.decorations ?? {})) if (n > 0 && !goods.has(def)) goods.set(def, false)
  return {
    connected: !!session.link,
    claimed: !!homes?.claimed,
    tier: mine ? mine.tier : homes?.claimed ? 0 : -1,
    tools: [...tools],
    fitted: instances.some((i) => itemDef(i.itemDef)?.kind === 'tool' && i.fittings.length > 0),
    fittings: instances.filter((i) => itemDef(i.itemDef)?.kind === 'fitting').length,
    materials: homes ? { ...homes.materials } : {},
    cooked: (view?.stacks ?? []).filter((s) => HEARTH_MADE.has(s.itemDef) && !!me && s.maker?.id === me).reduce((n, s) => n + s.qty, 0),
    sentMail: !!me && (village?.mail ?? []).some((m) => m.fromId === me),
    homeGoods: [...goods].map(([itemDef, placed]) => ({ itemDef, placed })),
    flags: session.state.flags
  }
}

/** The pinned guide's progress now (null: none pinned). */
export function pinnedProgress(session: Session): GuideProgress | null {
  const g = pinned.id ? guideById(pinned.id) : null
  return g ? guideProgress(g, guideContext(session)) : null
}
