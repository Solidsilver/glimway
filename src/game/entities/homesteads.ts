import { homeEntrance } from '../../lib/lots.ts'
/**
 * Homesteads in the scene. Four places:
 *
 *   - The Commons lane: Silas out by his sawhorse (part of his hour), the
 *     hame on the gate, and a signpost at every homestead gate. After a
 *     deed, a marker leads you to your own gate.
 *   - Silas's Yard (`in:commons:yard` and Pell's office through its side
 *     door): Silas at his counter, Pell at the desk (../yard-talk.ts).
 *   - A homestead's land (behind its gate): the camp or cottage on the home
 *     site, the mailbox, every placed piece, lantern posts and the ground
 *     their light holds, desolation; placement mode for members (lit, open
 *     ground only), and clearing a tile with Silas's saw.
 *   - Inside a cottage: the hearth, the workshop's chest and bench, indoor
 *     placement.
 *
 * Data comes from src/game/homestead.ts (one per session); this layer only
 * draws it and turns presses into actions. Everything it draws is rebuilt
 * when that data changes.
 */
import { LotHomes } from '../wilds/lot-chunk.ts'
import { FixedScope } from '../wilds/fixed-scope'
import Phaser from 'phaser'
import { parseHomeArea } from '../../lib/homestead'
import { clearable, servedLand } from '../../lib/homestead-land'
import type { HomeView, StallView } from '../../lib/api/types'
import { baySig, nextHomecoming, stableNext, stallsShown } from '../../lib/companions'
import { homeBay, type BayWalk } from '../../lib/stable-layout'
import { type SeatPose } from '../seats'
import { bus, EV } from '../events'
import type { Session } from '../session'
import { TILE, tileCenter, tileFeet, tileKey, tileMid } from '../../lib/tile'
import type { WorldData } from '../worlds'
import type { CommonsLane } from '../wilds/fixed'
import type { FixedHooks } from '../wilds/fixed-chunk'
import type { LandWorld } from '../homeland'
import { ROOM_BENCH, ROOM_HEARTH } from '../cottage'
import { villageFor, type Village } from '../village'
import { homesteadsFor, lotName, signText, type Homesteads, type PlacementCommand } from '../homestead'
import type { Effects } from './fx'
import type { Interactables } from './interactables'
import { expose } from '../dev-hooks'
import { onSceneEnd } from '../scene-end'

import { HomesteadArt } from './homestead-art'
import { HomesteadTalk } from './homestead-talk'
import { HomesteadArranging } from './homestead-placement'
import { HomesteadYard } from './homestead-yard'
import { homeward } from './led-mount'
import { isYardRoom } from '../yard-talk'

export interface HomesteadDeps {
  world: WorldData
  session: Session
  fx: Effects
  reducedMotion: boolean
  solidGroup: Phaser.Physics.Arcade.StaticGroup
  interactables: Interactables
  hero: () => Phaser.Physics.Arcade.Sprite
  /** The hero, to sit on a placed seat (and stand back up). */
  sitter: () => { readonly isSeated: boolean; sit(pose: SeatPose): void; standUp(): void }
  /** On the open map: the Commons lane (its gates and fixtures, world tiles), drawn a chunk at a time. */
  commons: CommonsLane | null
  /** In a cottage (`in:home:<gate>`): which gate's homestead it stands on. */
  room: { gate: number } | null
  /** Walk into a cottage: an area change into `in:home:<gate>`. */
  enterRoom: (gate: number, doorstep: { tx: number; ty: number }) => void
  /** The map no longer matches the data (the lane grew, land was cleared): rebuild it. */
  rebuild: () => void
  refreshLot?: (key: string) => void
}

/** A homestead is read again for a mount's coming or going at most this often (ms). */
const REREAD_MS = 1_000

/** Land rebuilds in a row (cleared tiles, desolation or the served land changed under us). */
let rebuilds = 0

export class HomesteadLayer {
  /** Drawing (./homestead-art.ts), using things (./homestead-talk.ts) and arranging (./homestead-placement.ts). */
  readonly art: HomesteadArt
  readonly talk: HomesteadTalk
  readonly arranging: HomesteadArranging
  readonly homes: Homesteads
  readonly village: Village
  readonly commons: CommonsLane | null
  readonly land: LandWorld | null
  /** The homestead this scene stands on (its land, or a cottage on it). */
  readonly gate: number | null
  /** One of Silas's Yard's rooms (the shop, Pell's office), or null. */
  readonly yardRoom: string | null
  /** Its yard pets, on the land (./homestead-yard.ts). */
  readonly yard: HomesteadYard | null
  readonly lots: LotHomes | null

  constructor(
    readonly scene: Phaser.Scene,
    readonly deps: HomesteadDeps
  ) {
    this.homes = homesteadsFor(deps.session)
    this.village = villageFor(deps.session)
    this.commons = deps.commons
    const landGate = deps.room ? null : parseHomeArea(deps.world.areaId)
    this.land = landGate !== null ? (deps.world as LandWorld) : null
    this.gate = deps.room?.gate ?? landGate
    this.yardRoom = isYardRoom(deps.world.areaId) ? deps.world.areaId : null
    this.art = new HomesteadArt(this)
    this.talk = new HomesteadTalk(this)
    this.arranging = new HomesteadArranging(this)
    this.yard = this.land ? new HomesteadYard(scene, deps.reducedMotion, () => deps.hero()) : null
    this.lots = deps.world.open ? new LotHomes(this) : null
    if (this.commons) this.art.buildCommonsFixtures()
    this.art.emitThumbs()
    const onChange = (p?: { gate?: number }) => this.scheduleRedraw(p?.gate)
    const onCommand = (c: PlacementCommand) => (this.lots?.active()?.arranging ?? this.arranging).command(c)
    const onArrange = () => (this.lots?.active()?.arranging ?? this.arranging).startPlacement()
    const onHomeAction = (p: { action: string }) => void (this.lots?.actionOwner?.talk ?? this.lots?.active()?.talk ?? this.talk).onAction(p.action)
    const onInvalidated = ({ gate }: { gate: number }) => {
      if (this.lots?.has(gate) || this.gate === gate) void this.homes.fetchHome(gate)
    }
    bus.on(EV.homeInvalidated, onInvalidated)
    bus.on(EV.homeAction, onHomeAction)
    bus.on(EV.homeChanged, onChange)
    // Mail changes your mailbox flag: just your place.
    const onVillage = (p?: { what?: string }) => p?.what === 'mail' && this.scheduleRedraw(this.homes.myGate ?? undefined)
    bus.on(EV.villageChanged, onVillage)
    bus.on(EV.homeCommand, onCommand)
    bus.on(EV.homeArrangeToggle, onArrange)
    // The stable's bays follow the mounts (crafts.md 3.1): yours from your own
    // companions, a partner's from the homestead read again when the land
    // hears their mount went out or came home.
    const onCompanions = () => this.onCompanionsChange()
    const onCompanionsOf = (p: { accountId: string }) => this.onCompanionsOf(p.accountId)
    bus.on(EV.companions, onCompanions)
    bus.on(EV.companionsOf, onCompanionsOf)
    // A destroyed game never shuts its scene down: either way, async work stops.
    onSceneEnd(scene, () => {
      this.gone = true
      this.talk.silasHold.release()
    })
    onSceneEnd(scene, () => {
      this.homecoming?.remove()
      this.redrawTimer?.remove()
      this.lots?.destroy()
      bus.off(EV.homeInvalidated, onInvalidated)
      bus.off(EV.homeChanged, onChange)
      bus.off(EV.villageChanged, onVillage)
      bus.off(EV.homeCommand, onCommand)
      bus.off(EV.homeArrangeToggle, onArrange)
      bus.off(EV.homeAction, onHomeAction)
      bus.off(EV.companions, onCompanions)
      bus.off(EV.companionsOf, onCompanionsOf)
      if (this.arranging.placement) this.arranging.endPlacement(false)
      this.yard?.destroy()
      this.arranging.emitArrange({ available: false, scene: null, tier: 0 })
    })
    // Read-only view of homesteads for playtests; `fresh()` awaits a fresh read of the lane and your home.
    expose('__fsHomes', Object.assign(() => ({
      status: this.homes.status,
      claimed: this.homes.claimed,
      myGate: this.homes.myGate,
      gateCount: this.homes.gateCount,
      gates: this.homes.gates,
      invites: this.homes.invites,
      mine: this.homes.mine,
      goal: this.homes.goal(),
      here: this.lots?.active()?.here() ?? (this.gate === null ? null : this.homes.homes.get(this.gate) ?? null),
      slots: this.commons?.gates.map((g) => ({ gate: g.gate, tx: g.tx, ty: g.ty, side: g.side, sign: g.sign, entry: g.entry, shelf: g.shelf })) ?? [],
      features: this.commons?.features ?? null,
      land: this.land ? { gate: this.land.gate, door: this.land.door, doorstep: this.land.doorstep, mailbox: this.land.mailbox, site: this.land.site, desolate: this.land.desolate } : null,
      guide: this.art.guide ? { x: this.art.guide.marker.x, y: this.art.guide.marker.y, arrow: this.art.guide.arrow.visible } : null,
      placing: this.placing,
      yard: (this.lots?.active()?.yard ?? this.yard)?.debug() ?? [],
      stalls: this.here()?.stalls ?? [],
      // The mounts standing in their bays on screen (./homestead-stable.ts tags each image).
      stalled: [...new Set(this.scene.children.list.filter((o) => o.active && typeof o.getData('stalled') === 'string').map((o) => o.getData('stalled') as string))],
      placement: (this.lots?.active()?.arranging ?? this.arranging).placementView,
      stats: {
        gateDraws: this.art.gateDraws,
        tweens: this.scene.tweens.getTweens().length,
        deadTweens: this.scene.tweens.getTweens().filter((t) => (t.targets ?? []).some((o) => !(o as Phaser.GameObjects.GameObject).active)).length
      }
    }), { fresh: () => this.homes.fresh() }), scene)
    // Playtests: a tap on a land/room grid tile while arranging (as a pointer would).
    expose('__fsDevTapTile', (x, y) => {
      const arranging = this.lots?.active()?.arranging ?? this.arranging
      const p = arranging.placement
      if (p) arranging.onPointer({ worldX: p.ox + tileMid(x), worldY: p.oy + tileMid(y) } as Phaser.Input.Pointer)
    }, scene)
    this.redraw()
    if (this.commons || this.yardRoom) void this.homes.load()
    if (this.gate !== null) void this.loadHere()
    if ((this.commons || this.land) && this.homes.connected) void this.village.loadMail()
    // Whose place this is: said once the homestead behind the gate is known.
    if ((this.land || deps.room) && (!this.homes.connected || this.homes.homes.has(this.gate!))) this.announce()
    else if (this.land || deps.room) this.announcePending = true
  }

  private announcePending = false
  /** The scene ended (async work that outlives it stops). */
  gone = false
  /** Placement mode owns input: the hero waits. */
  get placing(): boolean {
    return this.arranging.placement !== null || !!this.lots?.active()?.arranging.placement
  }

  /** The homestead this scene shows (null: unclaimed land, or not read yet). */
  here(): HomeView | null {
    return this.gate === null ? null : this.homes.homes.get(this.gate) ?? null
  }

  /** Where your `mount` walks into its bay on this land, or null when its bay isn't here (Go home, ./avatar.ts). */
  baySpot(mount: string): BayWalk | null {
    const child = this.lots?.active()
    const L = child?.land ?? this.land, h = child?.here() ?? this.here()
    const bay = L ? homeBay(h, this.homes.myId, mount) : null
    if (!bay || !L?.gridOrigin) return bay
    const { x, y } = L.gridOrigin
    return { front: { x: bay.front.x + x, y: bay.front.y + y }, stand: { x: bay.stand.x + x, y: bay.stand.y + y }, depth: bay.depth + y }
  }

  /**
   * The stable's bays as this screen shows them (../../lib/companions.ts):
   * the server's stalls, with your own mount out while it's out with you or
   * still walking home.
   */
  stallsHere(): StallView[] {
    const home = this.here()
    if (!home) return []
    const link = this.deps.session.link
    // Until your companions are read, your bays show what the server said.
    return stallsShown(home.stalls, home.id, this.homes.myId, link?.companionsRead ? link.companions : null, homeward, Date.now())
  }

  /** Which bays stand full, as last drawn (a companions change redraws only when it changes this). */
  private stallsDrawn = ''
  /** The redraw that puts a mount walking home back in its bay. */
  private homecoming: Phaser.Time.TimerEvent | null = null

  /** Your companions changed: redraw if a bay filled or emptied, else watch for a mount walking home. */
  private onCompanionsChange(): void {
    if (this.lots) { this.lots.companions(); return }
    const home = this.here()
    if (!this.land || !home) return
    const next = stableNext(home.stalls, this.stallsHere(), this.stallsDrawn, this.homes.myId, homeward, Date.now())
    if (next.redraw) this.scheduleRedraw(this.gate!)
    else this.recheckAt(next.recheckAt)
  }

  /** A redraw at `at` (Date.now() ms; null: none), replacing any earlier one. */
  private recheckAt(at: number | null): void {
    this.homecoming?.remove()
    this.homecoming = at === null ? null : this.scene.time.delayedCall(Math.max(0, at - Date.now()) + 20, () => this.scheduleRedraw(this.gate!))
  }

  /** When this land last read its homestead for a mount's coming or going, and whether another read waits. */
  private rereadAt = -Infinity
  private rereadWaiting = false

  /**
   * Someone's mount went out or came home (presence): read this homestead
   * again if it's theirs to show. At most one read a second: a burst (out,
   * then home) ends with one more read after the last.
   */
  private onCompanionsOf(accountId: string): void {
    if (this.lots) { this.lots.companionsOf(accountId); return }
    const home = this.here()
    if (!this.land || !home || accountId === this.homes.myId) return
    if (!home.members.some((m) => m.id === accountId) && !home.stalls.some((s) => s.ownerId === accountId)) return
    const read = () => {
      this.rereadAt = Date.now()
      if (!this.gone) void this.homes.fetchHome(this.gate!)
    }
    const wait = this.rereadAt + REREAD_MS - Date.now()
    if (wait <= 0) return read()
    if (this.rereadWaiting) return
    this.rereadWaiting = true
    this.scene.time.delayedCall(wait, () => {
      this.rereadWaiting = false
      read()
    })
  }

  /** Walking onto a homestead's land (or into its cottage): read it fresh. */
  private async loadHere(): Promise<void> {
    if (this.gate === null) return
    // (Not sys.isActive(): this starts inside create(), before the scene runs.)
    if (this.homes.status === 'loading' || this.homes.gates.length === 0) await this.homes.load()
    if (this.gone) return
    await this.homes.fetchHome(this.gate)
    if (this.gone) return
    if (this.announcePending) {
      this.announcePending = false
      this.announce()
    }
    if (this.land) this.homes.arrived(this.gate)
    this.checkLandMatches()
  }

  /**
   * The land map bakes in cleared tiles and desolation (they change what is
   * solid and what grows): when the data says otherwise, rebuild where we stand.
   */
  private checkLandMatches(): void {
    if (!this.land) return
    const h = this.here()
    const L = this.land
    const want = [...(h?.cleared ?? [])]
      .filter(([x, y]) => x >= 0 && y >= 0 && x < L.width && y < L.height && clearable(L.land.tiles[y * L.width + x]))
      .map(([x, y]) => tileKey(x, y))
      .sort()
      .join(';')
    const built: string[] = []
    for (let y = 0; y < this.land.height; y++)
      for (let x = 0; x < this.land.width; x++) {
        const k = this.land.land.tiles[y * this.land.width + x]
        if (clearable(k) && !this.land.solid[y][x]) built.push(tileKey(x, y))
      }
    // Built on plain ground before the server's land arrived: rebuild on it.
    const landArrived = !this.land.served && servedLand(this.land.gate) !== null
    const stale = want !== built.sort().join(';') || (h?.desolate ?? false) !== this.land.desolate || landArrived
    // Never a rebuild loop: at most a few in a row for one map.
    if (stale && rebuilds < 3) {
      rebuilds++
      this.deps.rebuild()
    } else if (!stale) rebuilds = 0
  }

  // ------------------------------------------------------------ drawing

  /** Gates whose drawing needs refreshing, or 'all'; flushed once per frame. */
  private pending: Set<number> | 'all' | null = null
  private redrawTimer: Phaser.Time.TimerEvent | null = null
  /** Coalesce change events: one redraw a frame, only of the gates that changed. */
  scheduleRedraw(gate?: number): void {
    const first = this.pending === null
    if (gate === undefined || this.pending === 'all') this.pending = 'all'
    else {
      const set: Set<number> = this.pending ?? new Set()
      set.add(gate)
      this.pending = set
    }
    if (first) this.redrawTimer = this.scene.time.delayedCall(0, () => this.flushRedraw())
  }

  private flushRedraw(): void {
    this.redrawTimer = null
    const p = this.pending
    this.pending = null
    if (this.gone || !p || !this.scene.sys.isActive()) return
    this.redraw(p === 'all' ? undefined : p)
  }

  private redraw(gates?: Set<number>): void {
    if (this.commons) {
      if (this.lots) this.lots.refresh(gates)
      this.art.drawGates(gates)
      this.art.drawGuide()
    } else if (this.gate !== null && (!gates || gates.has(this.gate))) {
      if (this.land) {
        this.checkLandMatches()
        this.art.drawLand()
        this.yard?.sync(this.here())
        this.stallsDrawn = baySig(this.stallsHere())
        this.recheckAt(nextHomecoming(this.here()?.stalls ?? [], this.homes.myId, homeward, Date.now()))
      } else this.art.drawRoom()
    }
    this.publishInteractions()
    if (this.arranging.placement) this.arranging.refreshPlacement()
  }

  /** Whose place this is, in words ("Ada’s Place", "Ada & Bo’s place", "Lot 3"). */
  placeName(home: HomeView | null, gate: number): string {
    if (!home || home.members.length === 0) return lotName(gate)
    if (home.members.length === 1) return signText(home.members[0].displayName || 'A neighbour')
    return `${home.members.map((m) => m.displayName || 'A neighbour').slice(0, 2).join(' & ')}’s Place`
  }

  private announce(): void {
    const gate = this.gate!
    const home = this.here()
    const mine = !!home?.member
    // `key` names the place for first-visit memory: whose it is, inside or out.
    const whose = mine ? 'mine' : home ? 'visit' : 'wild'
    if (this.deps.room) {
      bus.emit(EV.homeRoom, {
        key: `cottage:${gate}:${whose}`,
        eyebrow: mine ? 'Home' : lotName(gate),
        title: mine ? 'Your cottage' : this.placeName(home, gate),
        body: mine ? 'Steady as a route stone. She’ll creak come autumn.' : 'Wipe your boots. Look, don’t touch.'
      })
      return
    }
    bus.emit(EV.homeRoom, {
      key: `land:${gate}:${whose}`,
      eyebrow: `${lotName(gate)} · Behind the Commons gates`,
      title: mine ? 'Your land' : home ? this.placeName(home, gate) : 'Unclaimed land',
      body: mine
        ? 'Held by lamplight. Set a named lantern post at the edge to hold more.'
        : home
          ? home.desolate
            ? 'Nobody has lit these lamps in a while. The wild is coming back.'
            : 'A neighbour’s place. Look, don’t touch.'
          : 'Nobody’s land yet. Pell sells the deed, at Silas’s Yard on the Commons.'
    })
  }

  /**
   * Whose place this scene is: your own land or cottage, someone else's, or
   * not a homestead (the goal needle's way-finding, src/game/entities/goal-guide.ts).
   */
  get placeKind(): 'home' | 'cottage' | 'other-home' | 'other-cottage' | null {
    const active = this.lots?.active()
    if (active) return active.placeKind
    if (this.gate === null) return null
    const own = this.gate === this.homes.myGate
    if (this.deps.room) return own ? 'cottage' : 'other-cottage'
    return this.land ? (own ? 'home' : 'other-home') : null
  }

  /**
   * Where a "How do I…?" step happens, in this scene's world px (null: not
   * in this scene, or not known yet): your gate on the lane; your door and
   * mailbox on your land; the bench and hearth inside. (Silas and Pell are
   * found by their hour: ./goal-guide.ts.)
   */
  guidePoint(where: string): { x: number; y: number } | null {
    if (where === 'lane') { const active = this.lots?.active(); return active ? tileCenter(homeEntrance(active.gate!).tx, homeEntrance(active.gate!).ty) : null }
    const mine = this.homes.myGate
    if (this.lots && where !== 'gate') {
      const child = this.lots.active()
      if (child) return child.guidePoint(where)
    }
    if (this.commons) {
      if (where === 'gate' && mine !== null) {
        const slot = this.commons.gates.find((g) => g.gate === mine)
        return slot ? tileCenter(slot.tx, slot.ty) : null
      }
      return null
    }
    if (this.gate === null || this.gate !== mine) return null
    if (this.land) {
      if (where === 'door') return tileFeet(this.land.door.tx, this.land.door.ty)
      if (where === 'mailbox') return tileFeet(this.land.mailbox.tx, this.land.mailbox.ty)
      return null
    }
    if (this.deps.room) {
      if (where === 'bench') return { x: ROOM_BENCH.x, y: 60 }
      if (where === 'hearth') return { x: ROOM_HEARTH.x - 14, y: ROOM_HEARTH.y + 14 }
    }
    return null
  }


  /**
   * The open map's fixed chunks attach and detach the lane's fixtures they
   * own: the gates' signs and shelves, the hame (../wilds/fixed-chunk.ts).
   */
  private fixedScope = new FixedScope(true)

  private publishInteractions(): void {
    const points = this.talk.interactionList().filter((p) => !this.commons || this.fixedScope.has(Math.floor(p.x / TILE), Math.floor((p.y - 8) / TILE)))
    this.deps.interactables.register(this, points)
  }

  attachFixedChunk(key: string): (() => void)[] {
    return [...(this.lots?.attach(key) ?? []), ...this.art.attachChunk(key), () => {
      this.fixedScope.keys.add(key)
      this.publishInteractions()
    }]
  }

  detachFixedChunk(key: string): void {
    this.lots?.detach(key)
    this.fixedScope.keys.delete(key)
    this.art.detachChunk(key)
    this.art.drawGuide()
    this.publishInteractions()
  }

  readonly fixedHooks: FixedHooks = {
    attach: (key) => this.attachFixedChunk(key),
    detach: (key) => this.detachFixedChunk(key)
  }

  /** Per frame: the way to your gate, and whether the hero may arrange their place. */
  update(dt: number): void {
    this.art.updateGuide()
    if (this.lots) this.lots.update(dt)
    else this.arranging.update(dt)
    this.yard?.update(dt)
  }

  /** A homestead action decided in a conversation or outside one (EV.homeAction). */
  onAction(action: string): Promise<void> {
    return this.talk.onAction(action)
  }
}
