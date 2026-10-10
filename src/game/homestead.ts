/**
 * Homesteads, game side: the Commons lane of gates (who holds each one),
 * the homesteads seen so far (one map each, behind its gate), and every
 * homestead action: claim a deed, buy, place, move, remove, upgrade, clear a
 * tile, share the deed (invite and sign at Silas's table), leave. No Phaser
 * here — the scene layer (src/game/entities/homesteads.ts) draws from it,
 * the UI (Silas's shop, the placement tray) calls it, and both hear about
 * changes on the bus.
 *
 * Players who can't reach the server get a walkable Commons and wild land
 * behind every gate, with no homes: building needs a world.
 */
import { HOMESTEAD_DATA, homeItem, type HomeInstance, type HomeScene } from '../lib/homestead.ts'
import type { DeedInvite, GateInfo, HomeAction, HomeActionResponse, HomeView } from '../lib/api/types.ts'
import type { CommonsLaneView } from './link.ts'
import type { Refusal } from '../lib/api/errors.ts'
import { homeErrorText } from '../content/errors.ts'
import { BUILDER_NPC_DATA, SIGN_FORMAT } from '../content/expansion-writing.ts'
import { setCommonsGateCount } from './worlds.ts'
import { setLandSource } from './homeland.ts'
import { villageFor } from './village.ts'
import { bus, EV, type MutationResolvedPayload } from './events.ts'
import { grantPaper } from './papers.ts'
import type { Session } from './session.ts'

export interface NamePrompt {
  title: string
  body: string
  placeholder: string
  max: number
}

/** Story flags (synced with progress). */
export const HOME_FLAGS = {
  met: 'home:met-silas',
  /** Walked through your own gate since the deed (the guidance is done). */
  arrived: 'home:arrived'
} as const

export const PAPERS = {
  deed: 'deed-of-sale-commons-plot',
  foundation: 'orrins-drift-slap-foundation-standard',
  toolbox: 'to-the-bench-across',
  firebox: 'silas-pine-offcut-scrap'
} as const

/** `guest` stays in the type only for readers in the scene layer (TODO(C2), src/game/entities/homestead-{art,talk}.ts): nothing sets it any more. */
export type HomeStatus = 'guest' | 'loading' | 'ready' | 'offline'

export interface ArrangeView {
  /** Standing on your own land or in your own cottage. */
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
  | { kind: 'clear' }
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
  scene: HomeScene
  tier: number
  items: PlacementItemView[]
  selected: string | null
  /** Why the ghost can't go where it is, in words (null: it can). */
  problem: string | null
  canRotate: boolean
  busy: boolean
  message: { text: string; kind: 'ok' | 'error' } | null
  /** A tree, stump or boulder picked on lit ground: Silas can clear it. */
  clearing: { x: number; y: number; what: string; cost: number } | null
  /** Where the piece in hand stands (grid tiles), if one is. */
  spot: { x: number; y: number; rotation: number } | null
}

export type ActResult = { ok: true; itemId?: string; status?: 'joined' | 'waiting' } | Refusal

/** "Lot 3": how a gate is named to players (gates count from 0). */
export function lotName(gate: number): string {
  return `Lot ${gate + 1}`
}

/**
 * One per session. Holds the lane and the homesteads seen so far, and
 * performs homestead actions through the session's server link.
 */
export class Homesteads {
  status: HomeStatus
  gates: GateInfo[] = []
  gateCount: number = HOMESTEAD_DATA.commons.spareGates
  invites: DeedInvite[] = []
  private myGateValue: number | null = null
  /** Homesteads by gate (null: known to be unclaimed land). */
  readonly homes = new Map<number, HomeView | null>()
  /** Land seeds the server sent, by gate. */
  readonly seeds = new Map<number, number>()
  /** Last unclaimed gate whose sign the player read (Silas offers it first). */
  chosenGate: number | null = null
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
  private polling = 0

  private readonly session: Session

  constructor(session: Session) {
    this.session = session
    this.status = 'loading'
    bus.on(EV.mutationResolved, (p) => {
      if (current?.homes === this) this.onResolved(p)
    })
  }

  get connected(): boolean {
    return !!this.session.link
  }

  get myId(): string | null {
    return this.session.link?.accountId ?? null
  }

  /** Your gate (null: no deed). */
  get myGate(): number | null {
    return this.myGateValue
  }

  get mine(): HomeView | null {
    const g = this.myGate
    return g === null ? null : this.homes.get(g) ?? null
  }

  /** You hold a deed (alone or jointly). */
  get claimed(): boolean {
    return this.myGate !== null
  }

  gateInfo(gate: number): GateInfo | null {
    return this.gates.find((g) => g.gate === gate) ?? null
  }

  /** Unclaimed gates on the lane, the chosen one first. */
  unclaimed(): GateInfo[] {
    const free = this.gates.filter((g) => g.homeId === null)
    return free.sort((a, b) => (a.gate === this.chosenGate ? -1 : b.gate === this.chosenGate ? 1 : a.gate - b.gate))
  }

  /** Empty homes you were on the deed of: Silas gives them back, free, until the deed is lost. */
  reclaimable(): GateInfo[] {
    return this.gates.filter((g) => g.reclaim)
  }

  /** Everyone on any deed but you (mail goes to their boxes). */
  neighbours(): { id: string; name: string }[] {
    const me = this.myId
    const out: { id: string; name: string }[] = []
    for (const g of this.gates) for (const m of g.members) if (m.id !== me && !out.some((o) => o.id === m.id)) out.push({ id: m.id, name: m.displayName || 'A neighbour' })
    return out
  }

  /** An invitation waiting for you to sign (someone wants to share their deed). */
  inviteForMe(): DeedInvite | null {
    const me = this.myId
    return this.invites.find((i) => i.to.id === me && i.expiresAt * 1000 > Date.now()) ?? null
  }

  /** Invitations you've offered (as a member of your homestead). */
  invitesFromMe(): DeedInvite[] {
    const me = this.myId
    return this.invites.filter((i) => i.from.id === me && i.expiresAt * 1000 > Date.now())
  }

  /** Read the lane, then your own homestead. Safe to call repeatedly. */
  load(): Promise<void> {
    if (this.loading) return this.loading
    this.loading = this.doLoad().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async doLoad(): Promise<void> {
    const link = this.session.link!
    const lane = await link.readCommons()
    if (!lane.ok) {
      this.status = 'offline'
      this.emit('offline')
      return
    }
    const before = JSON.stringify([this.gates, this.gateCount, this.invites, this.myGateValue, this.status])
    this.adoptLane(lane.value)
    this.status = 'ready'
    // Only a lane that changed is redrawn (Silas re-reads it every conversation).
    if (JSON.stringify([this.gates, this.gateCount, this.invites, this.myGateValue, this.status]) !== before) this.emit('roster')
    const g = this.myGate
    if (g !== null) await this.fetchHome(g)
    this.emitGoal()
  }

  private adoptLane(v: CommonsLaneView): void {
    const before = this.myGateValue
    this.gates = v.gates
    this.gateCount = v.gateCount
    this.invites = v.invites
    this.myGateValue = v.mine?.gate ?? null
    for (const g of v.gates) {
      const known = this.homes.get(g.gate)
      if (g.homeId === null) this.homes.set(g.gate, null)
      else if (known === null || (known && known.id !== g.homeId)) this.homes.delete(g.gate)
    }
    setCommonsGateCount(this.gateCount)
    if (before !== this.myGateValue) this.emitGoal()
  }

  /** A gate read: the home behind it (or none), and always the caller's own materials. */
  private adoptRead(v: { gate: number; landSeed?: number; home: HomeView | null; materials: Record<string, number> }): void {
    const before = this.homes.get(v.gate)
    if (v.landSeed !== undefined) this.seeds.set(v.gate, v.landSeed)
    this.homes.set(v.gate, v.home)
    this.materials = v.materials
    this.reconcilePapers()
    if (before === undefined || JSON.stringify(before) !== JSON.stringify(v.home)) this.emit('home', v.gate)
  }

  /** A home the server just sent (an action's answer, a workshop read). */
  adoptHome(home: HomeView | null): void {
    if (!home) return
    this.homes.set(home.gate, home)
    this.seeds.set(home.gate, home.landSeed)
    if (home.member) this.myGateValue = home.gate
    const row = this.gateInfo(home.gate)
    if (row) {
      row.tier = home.tier
      row.desolate = home.desolate
      row.shelf = home.items.some((item) => item.itemDef === 'gate-shelf' && item.scene === 'gate')
      if (!row.shelf) row.shelfStocked = false
    }
    this.reconcilePapers()
    this.emit('home', home.gate)
  }

  /** Refresh lane art after a slot is stocked, emptied, or a shelf is moved. */
  adoptShelfState(gate: number, hasShelf: boolean, stocked: boolean): void {
    const row = this.gateInfo(gate)
    if (row) {
      row.shelf = hasShelf
      row.shelfStocked = hasShelf && stocked
    }
    this.emit('shelf', gate)
  }

  /**
   * Papers that follow from the home's state, not from one answer: a deed
   * means Silas's deed paper; a cottage means a laid foundation (a lost
   * upgrade answer must still bring Orrin's standard once the home reads tier 1).
   */
  private reconcilePapers(): void {
    if (this.myGate !== null) grantPaper(this.session, PAPERS.deed)
    if ((this.mine?.tier ?? 0) >= 1) grantPaper(this.session, PAPERS.foundation)
  }

  /** A homestead mutation whose answer was lost is now known (Link.resolveUnresolved). */
  private onResolved(p: MutationResolvedPayload): void {
    if (p.op.kind !== 'home') return
    const res = p.res as HomeActionResponse | undefined
    if (p.outcome === 'landed' && res?.result) {
      this.adoptHome(res.result.home)
      this.materials = res.result.materials
    }
    void this.load()
    bus.emit(EV.toast, {
      text: p.outcome === 'landed' ? 'Your last order with Silas went through after all.' : 'Your last order with Silas didn’t go through. Nothing was charged.',
      icon: 'glim'
    })
  }

  /** The homestead behind a gate, fresh from the server (walking through it). */
  async fetchHome(gate: number): Promise<HomeView | null> {
    const link = this.session.link
    if (!link) return null
    const r = await link.readHome(gate)
    if (!r.ok) return this.homes.get(gate) ?? null
    this.adoptRead(r.value)
    return r.value.home
  }

  // ------------------------------------------------------------ actions

  async act(action: HomeAction): Promise<ActResult> {
    const link = this.session.link!
    const r = await link.homeAction(action)
    if (!r.ok) {
      // `resolved`: an earlier order this repeats went through after all; show what it changed.
      if (r.code === 'gate-taken' || r.code === 'already-homesteaded' || r.code === 'not-a-member' || r.code === 'invite-not-found' || r.code === 'resolved') void this.load()
      return { ok: false, code: r.code, text: homeErrorText(r.code) }
    }
    this.materials = r.materials
    if (r.home) this.adoptHome(r.home)
    if (action.op === 'claim' || action.op === 'leave' || action.op === 'joint' || action.op === 'invite') {
      if (action.op === 'leave') {
        const g = this.myGateValue
        this.myGateValue = null
        if (g !== null) this.homes.delete(g)
      }
      await this.load()
    }
    this.emit(action.op, r.home?.gate)
    return { ok: true, itemId: r.itemId, status: r.status }
  }

  buy(itemDef: string): Promise<ActResult> {
    return this.act({ op: 'buy', itemDef })
  }

  upgrade(): Promise<ActResult> {
    return this.act({ op: 'upgrade', tier: (this.mine?.tier ?? 0) + 1 })
  }

  /** Buy the deed to a gate's land from Silas. */
  async claim(gate: number): Promise<ActResult> {
    const r = await this.act({ op: 'claim', gate })
    if (r.ok) {
      grantPaper(this.session, PAPERS.deed)
      this.emitGoal()
    }
    return r
  }

  leave(): Promise<ActResult> {
    return this.act({ op: 'leave' })
  }

  clear(x: number, y: number): Promise<ActResult> {
    return this.act({ op: 'clear', x, y })
  }

  /**
   * Offer to share your deed with someone at Silas's table, and sign your
   * side at once. The deed is amended when they sign too (within the window).
   */
  async offerDeed(to: string): Promise<ActResult> {
    const mine = this.mine
    if (!mine) return { ok: false, code: 'not-a-member', text: homeErrorText('not-a-member') }
    const r = await this.act({ op: 'invite', to })
    if (!r.ok) return r
    return this.sign(mine.id, to)
  }

  /** Sign a joint deed at the table (yours to offer, or theirs to accept). */
  async sign(homeId: string, to: string): Promise<ActResult> {
    const r = await this.act({ op: 'joint', homeId, to })
    if (r.ok && r.status === 'waiting') this.pollDeed()
    return r
  }

  /**
   * While a joint deed waits on the other signature, watch the lane: the
   * deed is amended when the partner signs (or the offer lapses).
   */
  private pollDeed(): void {
    const id = ++this.polling
    const until = Date.now() + HOMESTEAD_DATA.jointDeed.confirmWindowSeconds * 1000 + 2000
    const tick = async () => {
      if (id !== this.polling || current?.homes !== this || Date.now() > until) return
      const before = this.myGate !== null ? (this.mine?.members.length ?? 0) : 0
      const gateBefore = this.myGate
      await this.load()
      if (this.myGate !== null) await this.fetchHome(this.myGate)
      const after = this.myGate !== null ? (this.mine?.members.length ?? 0) : 0
      if (this.myGate !== gateBefore || after !== before) {
        this.polling++
        this.emit('joint', this.myGate ?? undefined)
        bus.emit(EV.toast, { text: 'Silas amends the deed. Both names, in his square hand.', icon: 'lantern' })
        return
      }
      setTimeout(() => void tick(), 2000)
    }
    setTimeout(() => void tick(), 1500)
  }

  /** Owned decorations: everything on your land and in your pack. */
  owned(): HomeInstance[] {
    return this.mine?.items ?? []
  }

  ownedCount(itemDef: string): number {
    return this.owned().filter((i) => i.itemDef === itemDef).length
  }

  cottagePrice(): number {
    return HOMESTEAD_DATA.tiers[1].glims
  }

  /** What the deed to this gate costs you (null: not for sale). */
  deedPrice(gate: number): number | null {
    return this.gateInfo(gate)?.price ?? null
  }

  /** The homestead goal: walk to your gate once you have the deed. */
  goal(): string | null {
    const g = this.myGate
    if (g === null || this.session.state.flags.includes(HOME_FLAGS.arrived)) return null
    return `Find ${lotName(g)} on the Commons lane: your gate. Follow the marker.`
  }

  emitGoal(): void {
    bus.emit(EV.homeGoal, { text: this.goal() })
  }

  /** You walked through your own gate: the guidance is done. */
  arrived(gate: number): void {
    if (gate !== this.myGate || this.session.state.flags.includes(HOME_FLAGS.arrived)) return
    this.session.addFlag(HOME_FLAGS.arrived)
    this.emitGoal()
  }

  /** `gate`: only that gate changed (the scene redraws just it). */
  private emit(reason: string, gate?: number): void {
    bus.emit(EV.homeChanged, { reason, gate })
  }
}

let current: { session: Session; homes: Homesteads } | null = null

/** The homestead state for this session (made on first use; it feeds the land maps). */
export function homesteadsFor(session: Session): Homesteads {
  if (!current || current.session !== session) {
    const homes = new Homesteads(session)
    current = { session, homes }
    setLandSource({
      worldId: () => session.link?.worldId || '',
      state: (gate) => {
        const h = homes.homes.get(gate)
        return h ? { cleared: h.cleared, stumps: h.stumps ?? [], plants: h.plants ?? [], desolate: h.desolate } : null
      },
      fetchLand: (gate) => session.link?.api.operations.homeLand(gate) ?? null
    })
  }
  return current.homes
}

/**
 * The Wilds' claims and the shop share one server-owned balance: when the
 * Wilds side moves it, the shop's mirror follows (the reverse rides
 * EV.homeChanged, which the Wilds store watches).
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
