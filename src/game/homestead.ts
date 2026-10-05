/**
 * Homesteads, game side: what the Commons knows about the world's plots and
 * homes, and every homestead action (claim, buy, place, move, remove,
 * upgrade, rest). No Phaser here — the scene layer
 * (src/game/entities/homesteads.ts) draws from it, the UI (Silas's shop, the
 * placement tray) calls it, and both hear about changes on the bus.
 *
 * Guests and connected players who can't reach the server get a walkable
 * Commons with no homes: building needs a world.
 */
import { HOMESTEAD_DATA, homeItem, type HomeInstance } from '../lib/homestead'
import type { HomeAction, HomeActionResponse, HomeView, PlotInfo } from '../lib/api/types'
import type { MutationOp } from './link'
import type { ApiErrorCode } from '../lib/api/errors'
import { BUILDER_NPC_DATA, SIGN_FORMAT } from '../content/expansion-writing'
import { setCommonsPlotCount } from './worlds'
import { villageFor } from './village'
import { bus, EV } from './events'
import { grantPaper } from './papers'
import type { Session } from './session'

export const HOME_EV = {
  /** The roster or a home changed: { reason }. */
  changed: 'home:changed',
  /** The UI should open Silas's shop. */
  openShop: 'ui:home-shop',
  /** Placement-mode state for the tray: PlacementView | null. */
  placement: 'ui:home-placement',
  /** Tray → scene: a placement command (PlacementCommand). */
  command: 'game:home-command',
  /** Whether the player stands where they may arrange their home: ArrangeView. */
  arrange: 'ui:home-arrange',
  /** Decoration art as data URLs: Record<itemId, string>. */
  thumbs: 'ui:home-thumbs',
  /** Entered someone's cottage: { title, eyebrow, body }. */
  room: 'ui:home-room'
} as const

/** Story flags (synced with progress). */
export const HOME_FLAGS = {
  met: 'home:met-silas',
  claimed: 'home:claimed'
} as const

export const PAPERS = {
  deed: 'deed-of-sale-commons-plot',
  foundation: 'orrins-drift-slap-foundation-standard',
  toolbox: 'to-the-bench-across',
  firebox: 'silas-pine-offcut-scrap'
} as const

export type HomeStatus = 'guest' | 'loading' | 'ready' | 'offline'

/** A slot on the Commons map and who it belongs to. */
export interface PlotView {
  /** Map slot (the plot index, or the next free slot for a plotless member). */
  slot: number
  ownerId: string
  name: string
  tier: number
  /** False for members who haven't been given a plot yet (a reserved, empty plot). */
  allocated: boolean
  mine: boolean
}

export interface ArrangeView {
  /** Standing on your own plot or in your own cottage. */
  available: boolean
  scene: 'outdoor' | 'indoor' | null
  tier: number
}

export type PlacementCommand =
  | { kind: 'select'; itemId: string }
  | { kind: 'nudge'; dx: number; dy: number }
  | { kind: 'rotate' }
  | { kind: 'confirm' }
  | { kind: 'remove' }
  | { kind: 'cancel' }
  | { kind: 'exit' }

export interface PlacementItemView {
  id: string
  itemDef: string
  name: string
  placed: boolean
  /** Placed in the other scene (outdoors while arranging indoors, or the reverse). */
  elsewhere: boolean
  /** Can go in the scene being arranged. */
  fits: boolean
}

export interface PlacementView {
  scene: 'outdoor' | 'indoor'
  tier: number
  items: PlacementItemView[]
  selected: string | null
  /** Why the ghost can't go where it is, in words (null: it can). */
  problem: string | null
  canRotate: boolean
  busy: boolean
  message: { text: string; kind: 'ok' | 'error' } | null
}

/** Player-facing words for a homestead refusal. */
export function homeErrorText(code: ApiErrorCode | 'offline' | 'superseded' | 'busy' | string): string {
  switch (code) {
    case 'tier-required':
      return 'That needs the cottage first. Silas can raise it for you.'
    case 'tier-unavailable':
      return 'Silas isn’t building that yet.'
    case 'placement-overlap':
      return 'Something’s already there.'
    case 'out-of-bounds':
      return 'That’s past the edge of your plot.'
    case 'invalid-placement':
      return 'That one doesn’t belong there.'
    case 'insufficient-embers':
      return 'Not enough embers for that.'
    case 'insufficient-materials':
      return 'You’re short on materials for that.'
    case 'already-placed':
      return 'That’s already set out.'
    case 'not-placed':
      return 'That’s already put away.'
    case 'item-not-owned':
      return 'That isn’t yours to move.'
    case 'offline':
      return 'Needs a connection. Nothing changed — try again when you’re back online.'
    case 'superseded':
      return 'Another device took over this journey.'
    case 'busy':
      return 'Hold on — the last one is still on its way.'
    case 'resolved':
      return 'Your last order with Silas went through after all. Check what you have before trying again.'
    case 'pending':
      return 'No answer yet — it may have gone through. We’ll find out when the connection is back; nothing will be charged twice.'
    default:
      return 'Silas didn’t catch that. Nothing changed — try again in a moment.'
  }
}

export type ActResult = { ok: true; itemId?: string } | { ok: false; code: string; text: string }

/**
 * One per session. Holds the world's plots and the homes seen so far, and
 * performs homestead actions through the session's server link.
 */
export class Homesteads {
  status: HomeStatus
  roster: PlotInfo[] = []
  readonly homes = new Map<string, HomeView>()
  /**
   * The caller's carried materials. One view for the whole game: it lives in
   * Village's carried counts (shop, board, mail and workshop all read it).
   */
  get materials(): Record<string, number> {
    return villageFor(this.session).carriedMaterials()
  }

  set materials(m: Record<string, number>) {
    villageFor(this.session).setCarriedMaterials(m)
  }
  private loading: Promise<void> | null = null

  constructor(private session: Session) {
    this.status = session.link ? 'loading' : 'guest'
    bus.on(EV.mutationResolved, (p: Parameters<Homesteads['onResolved']>[0]) => {
      if (current?.homes === this) this.onResolved(p)
    })
  }

  get connected(): boolean {
    return !!this.session.link
  }

  get myId(): string | null {
    return this.session.link?.habiticaId ?? null
  }

  get mine(): HomeView | null {
    const id = this.myId
    return id ? this.homes.get(id) ?? null : null
  }

  get claimed(): boolean {
    return this.session.state.flags.includes(HOME_FLAGS.claimed)
  }

  /** The plot views for the map, by slot. Plotless members take the next free slots. */
  plots(): PlotView[] {
    const me = this.myId
    const out: PlotView[] = []
    let next = Math.max(-1, ...this.roster.map((p) => p.plotIndex ?? -1)) + 1
    for (const p of this.roster) {
      const allocated = p.plotIndex !== null
      const home = this.homes.get(p.ownerId)
      out.push({
        slot: allocated ? p.plotIndex! : next++,
        ownerId: p.ownerId,
        name: home?.displayName || p.displayName || 'A neighbour',
        tier: home?.tier ?? p.tier,
        allocated,
        mine: p.ownerId === me
      })
    }
    return out
  }

  /** Slots the map must have room for. */
  slotCount(): number {
    return this.plots().reduce((n, p) => Math.max(n, p.slot + 1), 0)
  }

  myPlot(): PlotView | null {
    return this.plots().find((p) => p.mine) ?? null
  }

  /** Read the roster and every member's home (in order). Safe to call repeatedly. */
  load(): Promise<void> {
    if (!this.session.link) {
      this.status = 'guest'
      return Promise.resolve()
    }
    if (this.loading) return this.loading
    this.loading = this.doLoad().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async doLoad(): Promise<void> {
    const link = this.session.link!
    const roster = await link.readCommons()
    if (!roster.ok) {
      this.status = 'offline'
      this.emit('offline')
      return
    }
    this.roster = roster.value
    setCommonsPlotCount(this.slotCount())
    this.status = 'ready'
    this.emit('roster')
    // Your own home first (Silas needs it to walk you to your plot), then the neighbours.
    const me = this.myId
    const order = [...this.roster].sort((a, b) => (a.ownerId === me ? -1 : b.ownerId === me ? 1 : 0))
    for (const p of order) {
      const r = await link.readHome(p.ownerId)
      if (!r.ok) continue
      this.adoptRead(r.value)
    }
  }

  /** A home read: the owner's home, and always the caller's own materials. */
  private adoptRead(v: { home: HomeView; materials: Record<string, number> }): void {
    const before = this.homes.get(v.home.ownerId)
    this.homes.set(v.home.ownerId, v.home)
    this.materials = v.materials
    this.reconcilePapers()
    // Only the plot that changed is redrawn (and only if it did change).
    if (!before || JSON.stringify(before) !== JSON.stringify(v.home)) this.emit('home', v.home.ownerId)
  }

  /**
   * Papers that follow from the home's state, not from one answer: a cottage
   * means a laid foundation (a lost upgrade answer must still bring Orrin's
   * standard once the home reads tier 1).
   */
  private reconcilePapers(): void {
    if ((this.mine?.tier ?? 0) >= 1) grantPaper(this.session, PAPERS.foundation)
  }

  /** A homestead mutation whose answer was lost is now known (Link.resolveUnresolved). */
  private onResolved(p: { op: MutationOp; outcome: 'landed' | 'refused'; res?: HomeActionResponse }): void {
    if (p.op.kind !== 'home') return
    if (p.outcome === 'landed' && p.res?.result) {
      this.homes.set(p.res.result.home.ownerId, p.res.result.home)
      this.materials = p.res.result.materials
      this.reconcilePapers()
      this.emit(p.op.op, p.res.result.home.ownerId)
    } else {
      const me = this.myId
      if (me) void this.fetchHome(me)
    }
    bus.emit(EV.toast, {
      text: p.outcome === 'landed' ? 'Your last order with Silas went through after all.' : 'Your last order with Silas didn’t go through. Nothing was charged.',
      icon: 'ember'
    })
  }

  /** A member's home, fresh from the server (visiting their cottage). */
  async fetchHome(ownerId: string): Promise<HomeView | null> {
    const link = this.session.link
    if (!link) return null
    const r = await link.readHome(ownerId)
    if (!r.ok) return this.homes.get(ownerId) ?? null
    this.adoptRead(r.value)
    return r.value.home
  }

  // ------------------------------------------------------------ actions

  async act(action: HomeAction): Promise<ActResult> {
    const link = this.session.link
    if (!link) return { ok: false, code: 'guest', text: 'Plots are for people with a world. Sign in to your world to claim one.' }
    const r = await link.homeAction(action)
    if (!r.ok) return { ok: false, code: r.code, text: homeErrorText(r.code) }
    this.homes.set(r.home.ownerId, r.home)
    this.materials = r.materials
    const row = this.roster.find((p) => p.ownerId === r.home.ownerId)
    if (row) row.tier = r.home.tier
    this.reconcilePapers()
    this.emit(action.op, r.home.ownerId)
    return { ok: true, itemId: r.itemId }
  }

  buy(itemDef: string): Promise<ActResult> {
    return this.act({ op: 'buy', itemDef })
  }

  upgrade(): Promise<ActResult> {
    return this.act({ op: 'upgrade', tier: (this.mine?.tier ?? 0) + 1 })
  }

  /** Talking Silas through it: your plot becomes yours (the deed is his, shown to you). */
  claim(): boolean {
    if (!this.mine || this.claimed) return false
    this.session.addFlag(HOME_FLAGS.claimed)
    grantPaper(this.session, PAPERS.deed)
    this.emit('claim', this.myId ?? undefined)
    return true
  }

  /** Owned instances (all of them, placed or not). */
  owned(): HomeInstance[] {
    return this.mine?.items ?? []
  }

  ownedCount(itemDef: string): number {
    return this.owned().filter((i) => i.itemDef === itemDef).length
  }

  cottagePrice(): number {
    return HOMESTEAD_DATA.tiers[1].embers
  }

  /** `ownerId`: only that plot changed (the scene redraws just it). */
  private emit(reason: string, ownerId?: string): void {
    bus.emit(HOME_EV.changed, { reason, ownerId })
  }
}

let current: { session: Session; homes: Homesteads } | null = null

/** The homestead state for this session (made on first use). */
export function homesteadsFor(session: Session): Homesteads {
  if (!current || current.session !== session) current = { session, homes: new Homesteads(session) }
  return current.homes
}

/**
 * The Wilds' claims and the shop share one server-owned balance: when the
 * Wilds side moves it, the shop's mirror follows (the reverse rides
 * HOME_EV.changed, which the Wilds store watches).
 */
export function syncWildsMaterials(materials: Record<string, number> | null): void {
  if (current) current.homes.materials = { ...(materials ?? {}) }
}

/** The shop's current material mirror, for the Wilds store to follow. */
export function currentHomesteadMaterials(): Record<string, number> | null {
  return current ? { ...current.homes.materials } : null;
}

// ------------------------------------------------------------ Silas's words

export const SILAS = BUILDER_NPC_DATA

/** "{name}'s Place" (canon wording), with the game's typographic apostrophe. */
export function signText(name: string): string {
  return SIGN_FORMAT.replace('{name}', name).replace("'", '’')
}

export function itemName(itemDef: string): string {
  return homeItem(itemDef)?.name ?? itemDef
}
