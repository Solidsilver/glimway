import { lotName } from '../lib/lots.ts'
/**
 * Homesteads, game side: the Commons lane of gates (who holds each one),
 * the homesteads seen so far (one map each, behind its gate), and every
 * homestead action: claim a deed, buy, place, move, remove, upgrade, clear a
 * tile, share the deed (invite and sign at the deed table in Pell's office),
 * leave. No Phaser here — the scene layer (src/game/entities/homesteads.ts)
 * draws from it, the UI (the Yard panel, the deed panel, the placement tray)
 * calls it, and both hear about changes on the bus.
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
import { setLandSource } from './lot-land.ts'
import { villageFor } from './village.ts'
import { bus, EV, type MutationResolvedPayload } from './events.ts'
import { grantPaper } from './papers.ts'
import type { Session } from './session.ts'
import { adoptMaterialCounts, adoptMaterials, nextMark } from './materials-order.ts'

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
export { lotName } from '../lib/lots.ts'

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
  /** Last unclaimed gate whose sign the player read (Pell offers it first). */
  chosenGate: number | null = null
  /**
   * The caller's carried materials. One view for the whole game: it lives in
   * Village's carried counts (shop, board, mail and workshop all read it).
   */
  get materials(): Record<string, number> {
    return villageFor(this.session).carriedMaterials()
  }

  /** An answer's whole balance (the stable's): newer than any read asked before. */
  set materials(m: Record<string, number>) {
    adoptMaterials(m, nextMark(), this.session.link)
  }

  /** Some counts an answer showed (an items answer's stacks): those, as of its landing; the rest keep theirs. */
  adoptMaterialCounts(counts: Record<string, number>): void {
    adoptMaterialCounts(counts, nextMark(), this.session.link)
  }
  private loading: Promise<void> | null = null
  private polling = 0
  /**
   * Reads and answers are ordered, as the Wilds store's are, on the clock
   * they share (materials-order.ts): a read takes the next mark as it is
   * asked, an applied answer the next as it lands. A read keeps whatever was
   * set after it was asked (the lane, a gate's home and its row, the
   * materials), so an earlier read answered late never undoes an action.
   */
  private laneSeq = 0
  /** Per gate: the latest read or answer that set its full home (a home, none, or not the one known). */
  private readonly homeSeq = new Map<number, number>()
  /**
   * Per gate, the mark of each group of its lane row (ROW_GROUPS). Every
   * source writes the groups it knows, at its mark, never over a newer one,
   * whether or not the full home is cached: a lane read at its asked mark, a
   * gate's home read, an action's home, a shelf update.
   */
  private readonly rowSeq = new Map<number, Partial<Record<RowGroup, number>>>()

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

  /** Empty homes you were on the deed of: Pell gives them back, free, until the deed is lost. */
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

  /**
   * Read the lane, then your own homestead. Safe to call repeatedly: joins a
   * read already in flight, which may have been asked before a change. After
   * a change, await `fresh()` instead.
   */
  load(): Promise<void> {
    return this.loading ?? this.fresh()
  }

  /**
   * The fresh read: the lane, then your own homestead, asked now, never
   * joining a read already in flight (it may predate the change). Resolves
   * once both are adopted (or found older than what is held). Await it after
   * a change made elsewhere (a partner's signature, a seeded test) or one
   * that moved the lane; later `load()` calls join it.
   */
  fresh(): Promise<void> {
    const p: Promise<void> = this.doLoad().finally(() => {
      if (this.loading === p) this.loading = null
    })
    this.loading = p
    return p
  }

  private async doLoad(): Promise<void> {
    const link = this.session.link!
    const mark = nextMark()
    const lane = await link.readCommons()
    if (!lane.ok) {
      // A newer lane is held: this read's failure says nothing about it.
      if (mark < this.laneSeq) return
      this.status = 'offline'
      this.emit('offline')
      return
    }
    const before = JSON.stringify([this.gates, this.gateCount, this.invites, this.myGateValue, this.status])
    let contradicted: number[] = []
    if (mark > this.laneSeq) {
      this.laneSeq = mark
      contradicted = this.adoptLane(lane.value, mark)
    }
    for (const home of lane.value.homes ?? []) this.adoptHomeRead(home, mark)
    this.status = 'ready'
    // Only a lane that changed is redrawn (Silas and Pell re-read it every conversation).
    if (JSON.stringify([this.gates, this.gateCount, this.invites, this.myGateValue, this.status]) !== before) this.emit('roster')
    const g = this.myGate
    // Cached homes the lane now contradicts are read again (yours below, awaited).
    for (const c of contradicted) if (c !== g) void this.fetchHome(c)
    if (g !== null) await this.fetchHome(g)
    this.emitGoal()
  }

  /**
   * The lane as read at `mark`: each gate's row takes the groups the lane is
   * the newer word on. Where it is the newer word on who holds a gate, the
   * cached home follows: a gate it names free is known free, and a home it
   * doesn't name is dropped, each as of `mark` (a gate read asked before the
   * lane can't install it again; see `agrees`). A cached home of the holder
   * it names that its newer row contradicts (another tier, members, shelf)
   * stays to look at until it is read again: the gates returned.
   */
  private adoptLane(v: CommonsLaneView, mark: number): number[] {
    const before = this.myGateValue
    const prev = new Map(this.gates.map((g) => [g.gate, g]))
    const contradicted: number[] = []
    this.gates = v.gates.map((lane) => {
      const g = lane.gate
      const known = this.homes.get(g)
      const held = prev.get(g)
      const row = { ...(held ?? lane) }
      // A gate first seen in this lane, whose home a later read set: the row starts from that home.
      const homeAt = this.homeSeq.get(g) ?? 0
      if (!held && known !== undefined && homeAt > mark) this.writeRow(row, homeRow(known), homeAt)
      this.writeRow(row, lane, mark)
      if (this.rowSeq.get(g)?.holder === mark && mark > homeAt) {
        if (row.homeId === null) {
          this.homes.set(g, null)
          this.homeSeq.set(g, mark)
        } else if (known !== undefined && known?.id !== row.homeId) {
          this.homes.delete(g)
          this.homeSeq.set(g, mark)
        }
      }
      return row
    })
    this.gateCount = v.gateCount
    this.invites = v.invites
    this.myGateValue = v.mine?.gate ?? null
    if (before !== this.myGateValue) this.emitGoal()
    for (const row of this.gates) if (this.homes.get(row.gate) && !this.cacheAgrees(row.gate)) contradicted.push(row.gate)
    return contradicted
  }

  /** Is the gate's cached home (or none) still what its row says? (Unknown: no.) */
  private cacheAgrees(gate: number): boolean {
    const known = this.homes.get(gate)
    return known !== undefined && this.agrees(gate, known, this.homeSeq.get(gate) ?? 0)
  }

  /** Write the row groups `fields` speaks for, as of `mark`, except those a newer source wrote. */
  private writeRow(row: GateInfo, fields: Partial<GateInfo>, mark: number): void {
    const seq = this.rowSeq.get(row.gate) ?? {}
    for (const group of Object.keys(ROW_GROUPS) as RowGroup[]) {
      const keys = ROW_GROUPS[group]
      if (!keys.some((k) => k in fields) || (seq[group] ?? 0) > mark) continue
      for (const k of keys) if (k in fields) Object.assign(row, { [k]: fields[k] })
      seq[group] = mark
    }
    this.rowSeq.set(row.gate, seq)
  }

  /**
   * Does a gate's home, read at `mark`, agree with every group of the gate's
   * row a later source wrote? A home that doesn't is older than what the row
   * says (another holder, another tier or members, a shelf since moved), and
   * isn't installed, cached home or not.
   */
  private agrees(gate: number, home: HomeView | null, mark: number): boolean {
    const row = this.gateInfo(gate)
    const seq = this.rowSeq.get(gate)
    if (!row || !seq) return true
    const told = homeRow(home)
    const newer = (group: RowGroup) => (seq[group] ?? 0) > mark
    if (newer('holder') && row.homeId !== told.homeId) return false
    if (newer('summary') && (row.tier !== told.tier || row.desolate !== told.desolate || memberIds(row.members) !== memberIds(told.members ?? []))) return false
    if (newer('shelf') && !!row.shelf !== told.shelf) return false
    return true
  }

  /**
   * A gate read asked at `mark`: the home behind it (or none), and always the
   * caller's own materials, each unless something newer was set since. False
   * when the home is older than what is held.
   */
  private adoptRead(v: { gate: number; landSeed?: number; home: HomeView | null; materials: Record<string, number> }, mark: number): boolean {
    if (v.landSeed !== undefined) this.seeds.set(v.gate, v.landSeed)
    adoptMaterials(v.materials, mark, this.session.link)
    return this.readHome(v.gate, v.home, mark)
  }

  /*
   * Homes come in two ways, and each source says which: a read's home is as
   * of the mark taken when the read was asked (a gate read, a workshop or
   * storage read), and is installed only if nothing told since is newer; an
   * action's home is as of its answer landing, newer than any read asked
   * before it. A read never takes a landing mark.
   */

  /** A home some other read carried (a storage read's), as of `mark`, taken when that read was asked. False when it is older than what is held. */
  adoptHomeRead(home: HomeView, mark: number): boolean {
    return this.readHome(home.gate, home, mark)
  }

  /** A home an action's answer carried (or a prediction standing in for one, or the home put back after a refusal): newer than any read asked before it. */
  adoptHomeAnswer(home: HomeView | null): void {
    if (home) this.install(home.gate, home, nextMark(), true)
  }

  /** A read's home (or none), installed unless older than the home held or than a row group a later source wrote. */
  private readHome(gate: number, home: HomeView | null, mark: number): boolean {
    if (mark <= (this.homeSeq.get(gate) ?? 0) || !this.agrees(gate, home, mark)) return false
    this.install(gate, home, mark, false)
    return true
  }

  /** Hold a gate's home as of `at`: the cache, and the row groups it tells. */
  private install(gate: number, home: HomeView | null, at: number, answer: boolean): void {
    const before = JSON.stringify([this.homes.get(gate), this.gateInfo(gate), this.myGateValue])
    this.homes.set(gate, home)
    this.homeSeq.set(gate, at)
    if (home) {
      this.seeds.set(gate, home.landSeed)
      // Your gate moved with it: a lane read asked before this is older.
      if (home.member && this.myGateValue !== gate && at > this.laneSeq) {
        this.myGateValue = gate
        this.laneSeq = at
      }
    }
    const row = this.gateInfo(gate)
    if (row) this.writeRow(row, homeRow(home), at)
    this.reconcilePapers()
    if (answer || JSON.stringify([home, row, this.myGateValue]) !== before) this.emit('home', gate)
  }

  /**
   * A gate's shelf as of `at`: presence and stock. Village is its one caller:
   * a shelf read passes the mark taken when it was asked, a stock, take or
   * buy answer the mark taken as it landed.
   */
  adoptShelf(gate: number, hasShelf: boolean, stocked: boolean, at: number): void {
    const row = this.gateInfo(gate)
    if (row) this.writeRow(row, { shelf: hasShelf, shelfStocked: hasShelf && stocked }, at)
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
      this.adoptHomeAnswer(res.result.home)
      adoptMaterials(res.result.materials, nextMark(), this.session.link)
    }
    void this.fresh()
    bus.emit(EV.toast, {
      text: p.outcome === 'landed' ? 'Your last order with Silas went through after all.' : 'Your last order with Silas didn’t go through. Nothing was charged.',
      icon: 'glim'
    })
  }

  /** The homestead behind a gate, fresh from the server (walking through it). */
  async fetchHome(gate: number): Promise<HomeView | null> {
    const link = this.session.link
    if (!link) return null
    for (let tries = 0; tries < 3; tries++) {
      const mark = nextMark()
      const r = await link.readHome(gate)
      if (!r.ok) break
      // Older than something told since: the cached home stands only if its row still agrees with it; else ask again.
      if (this.adoptRead(r.value, mark) || this.cacheAgrees(gate)) break
    }
    // The home as held: this read's, or a newer answer's.
    return this.homes.get(gate) ?? null
  }

  // ------------------------------------------------------------ actions

  async act(action: HomeAction): Promise<ActResult> {
    const link = this.session.link!
    const r = await link.homeAction(action)
    if (!r.ok) {
      // `resolved`: an earlier order this repeats went through after all; show what it changed.
      if (r.code === 'gate-taken' || r.code === 'already-homesteaded' || r.code === 'not-a-member' || r.code === 'invite-not-found' || r.code === 'resolved') void this.fresh()
      return { ok: false, code: r.code, text: homeErrorText(r.code) }
    }
    adoptMaterials(r.materials, nextMark(), this.session.link)
    if (r.home) this.adoptHomeAnswer(r.home)
    if (action.op === 'claim' || action.op === 'leave' || action.op === 'joint' || action.op === 'invite') {
      if (action.op === 'leave') {
        const at = nextMark()
        const g = this.myGateValue
        this.myGateValue = null
        this.laneSeq = at
        if (g !== null) {
          this.homes.delete(g)
          this.homeSeq.set(g, at)
        }
      }
      // The lane moved: a read already in flight was asked before it.
      await this.fresh()
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

  /** Buy the deed to a gate's land from Pell. */
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
   * Offer to share your deed with someone at Pell's deed table, and sign your
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
      // The partner signs elsewhere: each look is a fresh read (it reads your home too).
      await this.fresh()
      const after = this.myGate !== null ? (this.mine?.members.length ?? 0) : 0
      if (this.myGate !== gateBefore || after !== before) {
        this.polling++
        this.emit('joint', this.myGate ?? undefined)
        bus.emit(EV.toast, { text: 'Pell amends the deed. Both names, one entry.', icon: 'lantern' })
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

/**
 * A gate's lane row in groups, by what tells them: who holds it; your deed
 * terms there (what a free gate costs you; whether you may take back an
 * empty home you were on the deed of), each its own; how it stands (tier,
 * desolation, members and their names); whether a shelf stands at the gate;
 * whether it is stocked. The lane tells them all, a shelf read or answer the
 * last two. A home tells only what it knows (homeRow).
 */
const ROW_GROUPS = {
  holder: ['homeId'],
  price: ['price'],
  reclaim: ['reclaim'],
  summary: ['tier', 'desolate', 'names', 'members', 'mine'],
  shelf: ['shelf'],
  stock: ['shelfStocked']
} as const satisfies Record<string, readonly (keyof GateInfo)[]>

type RowGroup = keyof typeof ROW_GROUPS

/**
 * What a gate's home (or none) tells of its row, and nothing it doesn't:
 * names from its members, a shelf from anything standing at the gate (as
 * the lane reads it, commons.go). The deed terms are yours, and the lane's
 * to tell: a home says a held gate isn't for sale, and an occupied one (or
 * none) can't be taken back, but not what a free gate costs you nor whether
 * you may take back an empty home.
 */
function homeRow(home: HomeView | null): Partial<GateInfo> {
  if (!home) return { homeId: null, reclaim: false, tier: 0, desolate: false, names: [], members: [], mine: false, shelf: false, shelfStocked: false }
  const shelf = home.items.some((item) => item.scene === 'gate')
  return {
    homeId: home.id,
    price: null,
    ...(home.members.length > 0 ? { reclaim: false } : {}),
    tier: home.tier,
    desolate: home.desolate,
    names: home.members.map((m) => m.displayName),
    members: home.members,
    mine: home.member,
    shelf,
    ...(shelf ? {} : { shelfStocked: false })
  }
}

const memberIds = (members: readonly { id: string }[]) => members.map((m) => m.id).join(',')

/** The homestead state for this session (made on first use; it feeds the land maps). */
export function homesteadsFor(session: Session): Homesteads {
  if (!current || current.session !== session) {
    const homes = new Homesteads(session)
    current = { session, homes }
    // Its carried counts mirror the one material balance from the start (materials-order.ts).
    villageFor(session)
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

// ------------------------------------------------------------ Silas's words

export const SILAS = BUILDER_NPC_DATA

/** "{name}'s Place" (canon wording), with the game's typographic apostrophe. */
export function signText(name: string): string {
  return SIGN_FORMAT.replace('{name}', name).replace("'", '’')
}

export function itemName(itemDef: string): string {
  return homeItem(itemDef)?.name ?? itemDef
}
