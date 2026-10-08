/**
 * The pin (docs/design/indoors.md 5.5): one slot per player and device, in
 * localStorage, holding `quest:<id>` or `guide:<id>`. Pinning one unpins
 * the other. While a quest or a "How do I…?" guide (src/lib/guides.ts) is
 * pinned and open, the goal line, its needle and the edge glow follow its
 * next step; with nothing pinned (or a done or locked pin) they follow the
 * road's current quest. Also builds the GuideContext and the quest talks'
 * context from what this session knows.
 */
import { bus, EV } from './events.ts'
import type { Session } from './session.ts'
import { guideById, guideProgress, newlyMet, type GuideContext, type GuideProgress } from '../lib/guides.ts'
import { deviceKey } from './held.ts'
import { homesteadsFor } from './homestead.ts'
import { itemsFor } from './items.ts'
import { villageFor } from './village.ts'
import { itemDef } from '../lib/items.ts'
import { HEARTH_RECIPES } from '../lib/workshop.ts'
import { nextStep, questById, questStatus, roadQuest, type QuestWhere } from '../lib/quests.ts'
import type { QuestTalkContext } from '../content/quests/index.ts'
import type { GuideWhere } from '../content/guides.ts'

/** One pin per player and world on this device (src/game/held.ts deviceKey). */
// `fingersnap:` is the game's old name, kept so saved pins load.
let key = 'fingersnap:pinned-guide'

/** A stored slot, or a bare guide id from before quests could be pinned. */
function load(): string | null {
  try {
    const v = localStorage.getItem(key)
    if (!v) return null
    if (v.startsWith('quest:')) return questById(v.slice(6)) ? v : null
    const g = v.startsWith('guide:') ? v.slice(6) : v
    return guideById(g) ? `guide:${g}` : null
  } catch {
    return null
  }
}

/** The slot: `quest:<id>`, `guide:<id>` or null. */
export const pinned = { slot: load() }

/** The pinned guide's id (null: a quest or nothing is pinned). */
export function pinnedGuide(): string | null {
  return pinned.slot?.startsWith('guide:') ? pinned.slot.slice(6) : null
}

/** The pinned quest's id (null: a guide or nothing is pinned). */
export function pinnedQuest(): string | null {
  return pinned.slot?.startsWith('quest:') ? pinned.slot.slice(6) : null
}

/** Pin a quest or a guide by slot (null unpins). EV.guidePin tells the HUD and the scene. */
export function setPinned(slot: string | null): void {
  if (pinned.slot === slot) return
  pinned.slot = slot
  try {
    if (slot) localStorage.setItem(key, slot)
    else localStorage.removeItem(key)
  } catch {
    /* kept for this visit */
  }
  bus.emit(EV.guidePin, { id: slot })
}

/** Read this player's pin in this world (when a session starts). */
export function usePinFor(session: Session): void {
  const k = deviceKey('fingersnap:pinned-guide', session)
  if (k === key) return
  key = k
  pinned.slot = load()
  bus.emit(EV.guidePin, { id: pinned.slot })
}

/**
 * Remember every guide step met now as a story mark, so a finished step
 * never un-ticks (the timber spent, the tea drunk).
 */
export function recordGuideSteps(session: Session): void {
  for (const f of newlyMet(guideContext(session))) session.addFlag(f)
}

const HEARTH_MADE = new Set(HEARTH_RECIPES.map((r) => r.output.id))

/** What the guides can see of this player now. */
export function guideContext(session: Session): GuideContext {
  const homes = homesteadsFor(session)
  const village = villageFor(session)
  const view = itemsFor(session).view
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
    madeTool: !!me && instances.some((i) => itemDef(i.itemDef)?.kind === 'tool' && i.maker?.id === me),
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
  const id = pinnedGuide()
  const g = id ? guideById(id) : null
  return g ? guideProgress(g, guideContext(session)) : null
}

/** What the quest talks can see now (src/content/quests/index.ts). */
export function questContext(session: Session): QuestTalkContext {
  return {
    quests: session.quests,
    needs: session.needs,
    gate: (quest) => session.gateContext(quest),
    pinned: pinned.slot,
    connected: session.needs.habitica
  }
}

/** The pinned quest, while it's open (a done or locked pin falls back to the road). */
export function pinnedOpenQuest(session: Session): string | null {
  const id = pinnedQuest()
  const q = id ? questById(id) : undefined
  return q && questStatus(q, session.quests, session.needs) === 'open' ? q.id : null
}

/** What the needle follows: a pinned guide's step, else a quest step's `where` (the pin's, or the road's). */
export type GoalTarget = { kind: 'guide'; where: GuideWhere | null } | { kind: 'quest'; quest: string; where: QuestWhere }

/** The guide's step is re-read twice a second at most (it reads the item and home models). */
let guideAt = -1
let guideCache: GoalTarget | null = null

export function goalTarget(session: Session): GoalTarget | null {
  if (pinnedGuide()) {
    const now = performance.now()
    if (guideAt < 0 || now - guideAt >= 500) {
      guideAt = now
      const p = pinnedProgress(session)
      guideCache = p && !p.done && !p.locked && p.current !== null ? { kind: 'guide', where: p.steps[p.current].where } : null
    }
    if (guideCache) return guideCache
  }
  const id = pinnedOpenQuest(session) ?? roadQuest(session.quests)?.id
  const q = id ? questById(id) : undefined
  const where = q ? nextStep(q, session.quests)?.where : undefined
  return q && where ? { kind: 'quest', quest: q.id, where } : null
}
