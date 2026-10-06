/**
 * Homesteads in the scene. Three places:
 *
 *   - The Commons lane: Silas at his yard (deeds, upgrades, the shop, joint
 *     deeds at his table), the hame on the gate, and a signpost at every
 *     homestead gate. After a deed, a marker leads you to your own gate.
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
import Phaser from 'phaser'
import { HOMESTEAD_DATA, canRotate, checkPlacement, checkRemoval, homeItem, parseHomeArea, rotatedFootprint, type HomeInstance, type HomeItem, type HomeScene, type PlacementGround, type Rotation } from '../../lib/homestead'
import { LAND, buildableKind, clearable, clearedSet, effectiveKind, homeLights, isLit, type Light } from '../../lib/homestead-land'
import { checkSpend } from '../../lib/embers'
import type { HomeView } from '../../lib/api/types'
import { CARTING_DAY_NOTICE } from '../../content/expansion-writing'
import type { Dialogue, DialogueChoice } from '../../content/world'
import { paperFlag } from '../../content/papers'
import { bus, EV } from '../events'
import { touchVec, uiBlocked, uiState } from '../input'
import { sfx } from '../sfx'
import type { Session } from '../session'
import { TILE } from '../textures'
import type { InteractId, WorldData } from '../worlds'
import type { CommonsWorld, GateSlot } from '../commons'
import type { LandWorld } from '../homeland'
import { COTTAGE_H, decoFlat, decoKey } from '../commons-art'
import { itemsFrame, itemWorldArt } from '../items-pass'
import { commonsAnim, commonsDataUrl } from '../commons-pass'
import { ROOM_BENCH, ROOM_CHEST, ROOM_GRID, ROOM_HEARTH } from '../cottage'
import { grantPaper } from '../papers'
import { presence } from '../presence'
import { itemsFor } from '../items'
import { keepsakeAsk } from '../keepsakes'
import { VILLAGE_EV, villageFor, type Village } from '../village'
import { openBoard } from './village-life'
import { costPhrase, WORKSHOP_TIER } from '../../lib/village'
import {
  HOME_EV,
  HOME_FLAGS,
  PAPERS,
  SILAS,
  homeErrorText,
  homesteadsFor,
  lotName,
  signText,
  itemName,
  type ArrangeView,
  type Homesteads,
  type PlacementCommand,
  type PlacementView
} from '../homestead'
import type { Effects } from './fx'
import type { Interactable, InteractionProvider, Interactables } from './interactables'

export interface HomesteadDeps {
  world: WorldData
  session: Session
  fx: Effects
  reducedMotion: boolean
  solidGroup: Phaser.Physics.Arcade.StaticGroup
  interactables: Interactables
  hero: () => Phaser.Physics.Arcade.Sprite
  /** In a cottage: which gate's homestead it stands on. */
  room: { gate: number } | null
  /** Walk into a cottage (the scene fades and rebuilds). */
  enterRoom: (gate: number, doorstep: { tx: number; ty: number }) => void
  /** The map no longer matches the data (the lane grew, land was cleared): rebuild it. */
  rebuild: () => void
}

const SILAS_ID = 'home:silas'
/** Land rebuilds in a row (cleared tiles, desolation or the seed changed under us). */
let rebuilds = 0
const POST = HOMESTEAD_DATA.lanternPosts.item

interface Drawn {
  objects: Phaser.GameObjects.GameObject[]
  bodies: Phaser.GameObjects.GameObject[]
}

interface Placement {
  scene: HomeScene
  /** Grid origin in world px, and size in tiles. */
  ox: number
  oy: number
  cols: number
  rows: number
  selected: string | null
  x: number
  y: number
  rotation: Rotation
  busy: boolean
  message: { text: string; kind: 'ok' | 'error' } | null
  /** A clearable tile picked (outdoors, nothing in hand). */
  clearing: { x: number; y: number } | null
  overlay: Phaser.GameObjects.Graphics
  ghost: Phaser.GameObjects.Image | null
}

export class HomesteadLayer implements InteractionProvider {
  private readonly homes: Homesteads
  private readonly village: Village
  private readonly commons: CommonsWorld | null
  private readonly land: LandWorld | null
  /** The homestead this scene stands on (its land, or a cottage on it). */
  private readonly gate: number | null
  private gateDrawn = new Map<number, Drawn>()
  private homeDrawn: Drawn = { objects: [], bodies: [] }
  private fixtures: Drawn = { objects: [], bodies: [] }
  private silas: Phaser.GameObjects.Sprite | null = null
  private placement: Placement | null = null
  private arrange: ArrangeView = { available: false, scene: null, tier: 0 }
  private arrangeTimer = 0
  private idleLine = Math.floor(Math.random() * SILAS.dialogue.idleLines.length)
  /** The way to your gate (Commons): a bobbing marker over it and an arrow at the screen's edge. */
  private guide: { marker: Phaser.GameObjects.Image; arrow: Phaser.GameObjects.Image; label: Phaser.GameObjects.Text } | null = null
  private shade: Phaser.GameObjects.Graphics | null = null
  /** The tray's last view (playtests read the piece's spot from it). */
  private placementView: PlacementView | null = null

  constructor(private scene: Phaser.Scene, private deps: HomesteadDeps) {
    this.homes = homesteadsFor(deps.session)
    this.village = villageFor(deps.session)
    this.commons = deps.world.areaId === 'commons' ? (deps.world as CommonsWorld) : null
    const landGate = deps.room ? null : parseHomeArea(deps.world.areaId)
    this.land = landGate !== null ? (deps.world as LandWorld) : null
    this.gate = deps.room?.gate ?? landGate
    if (this.commons) this.buildCommonsFixtures()
    this.emitThumbs()
    const onChange = (p?: { gate?: number }) => this.scheduleRedraw(p?.gate)
    const onCommand = (c: PlacementCommand) => this.command(c)
    const onArrange = () => this.startPlacement()
    const onHomeAction = (p: { action: string }) => void this.onAction(p.action)
    bus.on(HOME_EV.action, onHomeAction)
    bus.on(HOME_EV.changed, onChange)
    // Mail changes your mailbox flag: just your place.
    const onVillage = (p: { what: string }) => p?.what === 'mail' && this.scheduleRedraw(this.homes.myGate ?? undefined)
    bus.on(VILLAGE_EV.changed, onVillage)
    bus.on(HOME_EV.command, onCommand)
    bus.on('game:home-arrange', onArrange)
    scene.events.once('shutdown', () => {
      this.gone = true
      bus.off(HOME_EV.changed, onChange)
      bus.off(VILLAGE_EV.changed, onVillage)
      bus.off(HOME_EV.command, onCommand)
      bus.off('game:home-arrange', onArrange)
      bus.off(HOME_EV.action, onHomeAction)
      if (this.placement) this.endPlacement(false)
      this.emitArrange({ available: false, scene: null, tier: 0 })
    })
    // Read-only view of homesteads for playtests.
    ;(window as unknown as { __fsHomes?: () => unknown }).__fsHomes = () => ({
      status: this.homes.status,
      claimed: this.homes.claimed,
      myGate: this.homes.myGate,
      gateCount: this.homes.gateCount,
      gates: this.homes.gates,
      invites: this.homes.invites,
      mine: this.homes.mine,
      goal: this.homes.goal(),
      here: this.gate === null ? null : this.homes.homes.get(this.gate) ?? null,
      slots: this.commons?.gates.map((g) => ({ gate: g.gate, tx: g.tx, ty: g.ty, side: g.side, sign: g.sign, entry: g.entry })) ?? [],
      features: this.commons?.features ?? null,
      land: this.land ? { gate: this.land.gate, door: this.land.door, doorstep: this.land.doorstep, mailbox: this.land.mailbox, site: this.land.site, desolate: this.land.desolate } : null,
      guide: this.guide ? { x: this.guide.marker.x, y: this.guide.marker.y, arrow: this.guide.arrow.visible } : null,
      placing: !!this.placement,
      placement: this.placement ? this.placementView : null,
      stats: {
        gateDraws: this.gateDraws,
        tweens: this.scene.tweens.getTweens().length,
        deadTweens: this.scene.tweens.getTweens().filter((t) => t.targets.some((o) => !(o as Phaser.GameObjects.GameObject).active)).length
      }
    })
    if (import.meta.env.DEV) {
      // Playtests: a tap on a land/room grid tile while arranging (as a pointer would).
      ;(window as unknown as { __fsDevTapTile?: (x: number, y: number) => void }).__fsDevTapTile = (x: number, y: number) => {
        const p = this.placement
        if (p) this.onPointer({ worldX: p.ox + (x + 0.5) * TILE, worldY: p.oy + (y + 0.5) * TILE } as Phaser.Input.Pointer)
      }
    }
    this.redraw()
    if (this.commons) void this.homes.load()
    if (this.gate !== null) void this.loadHere()
    if ((this.commons || this.land) && this.homes.connected) void this.village.loadMail()
    // Whose place this is: said once the homestead behind the gate is known.
    if ((this.land || deps.room) && (!this.homes.connected || this.homes.homes.has(this.gate!))) this.announce()
    else if (this.land || deps.room) this.announcePending = true
  }

  private announcePending = false
  /** The scene shut down (async work that outlives it stops). */
  private gone = false

  /** Placement mode owns input: the hero waits. */
  get placing(): boolean {
    return this.placement !== null
  }

  /** The homestead this scene shows (null: unclaimed land, or not read yet). */
  private here(): HomeView | null {
    return this.gate === null ? null : this.homes.homes.get(this.gate) ?? null
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
      .map(([x, y]) => `${x},${y}`)
      .sort()
      .join(';')
    const built: string[] = []
    for (let y = 0; y < this.land.height; y++)
      for (let x = 0; x < this.land.width; x++) {
        const k = this.land.land.tiles[y * this.land.width + x]
        if (clearable(k) && !this.land.solid[y][x]) built.push(`${x},${y}`)
      }
    const seed = this.homes.seeds.get(this.land.gate)
    const stale = want !== built.sort().join(';') || (h?.desolate ?? false) !== this.land.desolate || (seed !== undefined && seed !== this.land.seed)
    // Never a rebuild loop: at most a few in a row for one map.
    if (stale && rebuilds < 3) {
      rebuilds++
      this.deps.rebuild()
    } else if (!stale) rebuilds = 0
  }

  // ------------------------------------------------------------ fixtures

  private buildCommonsFixtures(): void {
    const f = this.commons!.features
    // Silas, at his sawhorse (the Commons pass; code-drawn fallback).
    const sx = f.silas.tx * TILE + 8
    const sy = f.silas.ty * TILE + TILE
    this.silas = this.scene.add.sprite(sx, sy, 'silas-idle-0').setOrigin(0.5, 1).setDepth(sy)
    const breathing = commonsAnim(this.scene, 'silas-breathing') ?? 'silas-breathing'
    if (this.scene.anims.exists(breathing)) this.silas.play(breathing)
    this.addBody(this.fixtures, sx, sy - 4, 12, 8)
    // The hame on the north gatepost, kept polished: a glint now and then.
    const hx = f.hame.tx * TILE + 8
    const hy = (f.hame.ty + 1) * TILE - 34
    this.scene.add.image(hx + 1, hy, 'hame').setOrigin(0.5, 0).setDepth((f.hame.ty + 1) * TILE + 1)
    const glint = this.scene.add.image(hx - 4, hy + 4, 'spark').setDepth((f.hame.ty + 1) * TILE + 2).setAlpha(0)
    if (!this.deps.reducedMotion) {
      this.scene.tweens.add({ targets: glint, alpha: 1, scale: 1.4, duration: 260, yoyo: true, repeat: -1, repeatDelay: 2600, ease: 'Sine.easeInOut' })
    }
    this.emitSilasPortrait()
  }

  /** The decoration art for the shop and tray, scaled up crisp. */
  private emitThumbs(): void {
    const out: Record<string, string> = {}
    for (const it of HOMESTEAD_DATA.items) {
      try {
        const src = this.scene.textures.get(decoKey(it.id, 0)).getSourceImage() as HTMLCanvasElement
        // Trimmed to the art (a chair stands in the bottom of its two-tile canvas).
        const b = opaqueBounds(src)
        const scale = Math.max(1, Math.floor(36 / Math.max(b.w, b.h)))
        const o = document.createElement('canvas')
        o.width = b.w * scale
        o.height = b.h * scale
        const ctx = o.getContext('2d')!
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(src, b.x, b.y, b.w, b.h, 0, 0, o.width, o.height)
        out[it.id] = o.toDataURL()
      } catch {
        /* thumbnails are decoration */
      }
    }
    bus.emit(HOME_EV.thumbs, out)
  }

  private emitSilasPortrait(): void {
    // The delivered dialogue bust, when the Commons pass loaded.
    const bust = commonsDataUrl(this.scene, 'portrait-silas')
    if (bust) {
      bus.emit(EV.portraits, { [SILAS.name]: bust })
      return
    }
    try {
      const src = this.scene.textures.get('silas-idle-0').getSourceImage() as HTMLCanvasElement
      const o = document.createElement('canvas')
      o.width = 14
      o.height = 14
      const ctx = o.getContext('2d')!
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(src, 1, 1, 14, 13, 0, 1, 14, 13)
      bus.emit(EV.portraits, { [SILAS.name]: o.toDataURL() })
    } catch {
      /* portraits are decoration */
    }
  }

  // ------------------------------------------------------------ drawing

  /** Gates whose drawing needs refreshing, or 'all'; flushed once per frame. */
  private pending: Set<number> | 'all' | null = null
  /** Gate signs drawn since the scene started (playtests check redraws stay linear). */
  private gateDraws = 0

  /** Coalesce change events: one redraw a frame, only of the gates that changed. */
  private scheduleRedraw(gate?: number): void {
    const first = this.pending === null
    if (gate === undefined || this.pending === 'all') this.pending = 'all'
    else {
      const set: Set<number> = this.pending ?? new Set()
      set.add(gate)
      this.pending = set
    }
    if (first) this.scene.time.delayedCall(0, () => this.flushRedraw())
  }

  private flushRedraw(): void {
    const p = this.pending
    this.pending = null
    if (!p || !this.scene.sys.isActive()) return
    this.redraw(p === 'all' ? undefined : p)
  }

  private redraw(gates?: Set<number>): void {
    if (this.commons) {
      if (this.homes.gateCount > this.commons.gates.length) {
        this.deps.rebuild()
        return
      }
      this.drawGates(gates)
      this.drawGuide()
    } else if (this.gate !== null && (!gates || gates.has(this.gate))) {
      if (this.land) {
        this.checkLandMatches()
        this.drawLand()
      } else this.drawRoom()
    }
    this.deps.interactables.setDynamic(this.interactionList(), this)
    if (this.placement) this.refreshPlacement()
  }

  private clear(d: Drawn): void {
    // Repeating glow/flicker tweens die with their objects, never orphaned.
    for (const o of d.objects) {
      this.scene.tweens.killTweensOf(o)
      o.destroy()
    }
    for (const b of d.bodies) {
      this.deps.solidGroup.remove(b, true, true)
    }
    d.objects = []
    d.bodies = []
  }

  private addBody(d: Drawn, cx: number, cy: number, w: number, h: number): void {
    const img = this.scene.physics.add.staticImage(cx, cy, 'px').setDisplaySize(w, h).refreshBody()
    img.setVisible(false)
    this.deps.solidGroup.add(img)
    d.bodies.push(img)
  }

  private add<T extends Phaser.GameObjects.GameObject>(d: Drawn, o: T): T {
    d.objects.push(o)
    return o
  }

  // ---- the Commons lane

  private drawGates(only?: Set<number>): void {
    for (const slot of this.commons!.gates) {
      if (only && !only.has(slot.gate)) continue
      this.gateDraws++
      const d = this.gateDrawn.get(slot.gate) ?? { objects: [], bodies: [] }
      this.clear(d)
      this.gateDrawn.set(slot.gate, d)
      this.drawGateSign(d, slot)
    }
  }

  /** The words on a gate's signpost. */
  private signWords(slot: GateSlot): { text: string; kind: 'held' | 'open' | 'weathered' } {
    const info = this.homes.gateInfo(slot.gate)
    if (!info || info.homeId === null) return { text: this.homes.status === 'guest' ? `Wild land\n${lotName(slot.gate)}` : `Unclaimed\n${lotName(slot.gate)}`, kind: 'open' }
    const names = info.names.length === 0 ? 'Nobody' : info.names.length === 1 ? short(info.names[0], 11) : `${short(info.names[0], 6)} & ${info.names.length > 2 ? 'co.' : short(info.names[1], 5)}`
    const text = info.names.length === 1 ? signText(names).replace(' Place', '\nPlace') : `${names}\n${lotName(slot.gate)}`
    return { text, kind: info.desolate ? 'weathered' : 'held' }
  }

  private drawGateSign(d: Drawn, slot: GateSlot): void {
    const { text, kind } = this.signWords(slot)
    const x = slot.sign.tx * TILE + 8
    const y = slot.sign.ty * TILE + TILE
    const sign = this.add(d, this.scene.add.image(x, y, kind === 'open' ? 'plot-sign-reserved' : 'plot-sign').setOrigin(0.5, 1).setDepth(y))
    if (kind === 'weathered') sign.setTint(0x9a9a9a)
    this.add(
      d,
      this.scene.add
        .text(x, y - 15, text, {
          fontFamily: '"Pixelify Sans", monospace',
          fontSize: '6px',
          color: kind === 'open' ? '#ffe9a8' : kind === 'weathered' ? '#c8c0b0' : '#fff3c4',
          stroke: '#2b1d1a',
          strokeThickness: 2,
          align: 'center',
          lineSpacing: -2,
          resolution: 10
        })
        .setOrigin(0.5, 0.5)
        .setDepth(y + 0.5)
    )
    // A weathered sign leans and has gone grey: the place has been empty a while.
    if (kind === 'weathered') sign.setAngle(slot.side === 'west' ? -5 : 5)
  }

  /** After a deed: a marker over your gate, and an arrow at the screen's edge pointing to it. */
  private drawGuide(): void {
    const g = this.homes.myGate
    const show = g !== null && !this.deps.session.state.flags.includes(HOME_FLAGS.arrived)
    const slot = show ? this.commons!.gates.find((s) => s.gate === g) : undefined
    if (!slot) {
      if (this.guide) {
        this.scene.tweens.killTweensOf(this.guide.marker)
        this.guide.marker.destroy()
        this.guide.arrow.destroy()
        this.guide.label.destroy()
        this.guide = null
      }
      return
    }
    const mx = slot.tx * TILE + 8
    const my = slot.ty * TILE - 22
    if (!this.guide) {
      const marker = this.scene.add.image(mx, my, 'mark-chevron').setAngle(90).setDepth(5600).setTint(0xffd24a)
      if (!this.deps.reducedMotion) this.scene.tweens.add({ targets: marker, y: my - 4, duration: 600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
      const arrow = this.scene.add.image(0, 0, 'mark-chevron').setDepth(5601).setTint(0xffd24a).setScrollFactor(0).setVisible(false)
      const label = this.scene.add
        .text(0, 0, `${lotName(slot.gate)}: yours`, { fontFamily: '"Pixelify Sans", monospace', fontSize: '7px', color: '#fff3c4', stroke: '#2b1d1a', strokeThickness: 3, resolution: 8 })
        .setOrigin(0.5, 1)
        .setDepth(5601)
      this.guide = { marker, arrow, label }
    }
    this.guide.marker.setPosition(mx, my)
    this.guide.label.setPosition(mx, my - 8).setScrollFactor(1)
  }

  /** Per frame (Commons): keep the edge arrow pointing at your gate while it is off screen. */
  private updateGuide(): void {
    if (!this.guide || !this.commons) return
    const cam = this.scene.cameras.main
    const view = cam.worldView
    const tx = this.guide.marker.x
    const ty = this.guide.marker.y + 22
    const inView = tx > view.x + 8 && tx < view.right - 8 && ty > view.y + 8 && ty < view.bottom - 8
    this.guide.arrow.setVisible(!inView)
    if (inView) return
    // Screen space: where the line from the view's centre to the gate leaves the screen.
    const W = cam.width
    const H = cam.height
    const z = cam.zoom
    const a = Math.atan2(ty - view.centerY, tx - view.centerX)
    const hw = W / 2 - 28
    const hh = H / 2 - 28
    const t = Math.min(hw / Math.max(1e-6, Math.abs(Math.cos(a))), hh / Math.max(1e-6, Math.abs(Math.sin(a))))
    const X = W / 2 + Math.cos(a) * t
    const Y = H / 2 + Math.sin(a) * t
    // Scroll-factor-0 objects still zoom about the camera's centre.
    this.guide.arrow.setPosition((X - W / 2) / z + W / 2, (Y - H / 2) / z + H / 2).setRotation(a)
  }

  // ---- a homestead's land

  private drawLand(): void {
    const d = this.homeDrawn
    this.clear(d)
    const L = this.land!
    const home = this.here()
    const ox = L.origin.x
    const oy = L.origin.y
    this.drawShade()
    if (!home) {
      // Unclaimed: a stake and a sign on the site, nothing else.
      const sx = (L.site.x + L.site.w / 2) * TILE
      const sy = (L.site.y + L.site.h - 1) * TILE
      this.add(d, this.scene.add.image(sx, sy, 'plot-sign-reserved').setOrigin(0.5, 1).setDepth(sy))
      this.add(
        d,
        this.scene.add
          .text(sx, sy - 15, this.homes.status === 'guest' ? `Wild land\n${lotName(L.gate)}` : `Unclaimed\n${lotName(L.gate)}`, { fontFamily: '"Pixelify Sans", monospace', fontSize: '6px', color: '#ffe9a8', stroke: '#2b1d1a', strokeThickness: 2, align: 'center', lineSpacing: -2, resolution: 10 })
          .setOrigin(0.5, 0.5)
          .setDepth(sy + 0.5)
      )
      this.addBody(d, sx, sy - 3, 6, 6)
      for (const [x, y] of [[L.site.x, L.site.y], [L.site.x + L.site.w, L.site.y], [L.site.x, L.site.y + L.site.h], [L.site.x + L.site.w, L.site.y + L.site.h]])
        this.add(d, this.scene.add.image(x * TILE, y * TILE, 'stake').setOrigin(0.5, 1).setDepth(y * TILE))
      return
    }
    const desolate = home.desolate
    if (home.tier >= 1) this.drawCottage(d, ox, oy, home.tier, desolate)
    else this.drawCamp(d, ox, oy, desolate)
    this.drawMailbox(d, home.member && this.village.waitingCount() > 0)
    this.drawItems(d, home, 'outdoor', 0, 0, desolate)
  }

  /**
   * The ground past the lamplight sits in shadow: the homestead's land is
   * what its lamps hold. Drawn per tile, just over the ground.
   */
  private drawShade(): void {
    const L = this.land!
    this.shade?.destroy()
    const home = this.here()
    if (!home) {
      this.shade = null
      return
    }
    const lights = this.lights(home)
    const g = this.scene.add.graphics().setDepth(-3.5)
    g.fillStyle(0x0c0c18, home.desolate ? 0.38 : 0.28)
    for (let y = 1; y < L.height - 1; y++)
      for (let x = 1; x < L.width - 1; x++) if (!isLit(lights, x, y)) g.fillRect(x * TILE, y * TILE, TILE, TILE)
    this.shade = g
  }

  private lights(home: HomeView, except?: string): Light[] {
    return homeLights(home.items.filter((i) => i.itemDef === POST && i.scene === 'outdoor' && i.id !== except && i.x !== null && i.y !== null) as { x: number; y: number }[])
  }

  private drawCamp(d: Drawn, ox: number, oy: number, desolate: boolean): void {
    const S = this.scene
    this.add(d, S.add.image(ox + 128, oy + 50, 'camp-patch').setDepth(-4))
    this.add(d, S.add.image(ox + 98, oy + 30, 'camp-windbreak').setOrigin(0.5, 1).setDepth(oy + 30))
    this.add(d, S.add.image(ox + 96, oy + 48, 'camp-cot').setOrigin(0.5, 1).setDepth(oy + 48))
    this.addBody(d, ox + 96, oy + 43, 30, 8)
    this.add(d, S.add.image(ox + 138, oy + 62, 'camp-ring').setOrigin(0.5, 1).setDepth(oy + 56))
    this.addBody(d, ox + 138, oy + 57, 18, 8)
    if (!desolate) {
      const flame = this.add(d, S.add.sprite(ox + 138, oy + 57, 'camp-flame-0').setOrigin(0.5, 1).setDepth(oy + 57))
      const flicker = commonsAnim(S, 'camp-flame-animation')
      if (flicker && !this.deps.reducedMotion) flame.play({ key: flicker, startFrame: Math.floor(Math.random() * 3) })
      else if (!this.deps.reducedMotion) {
        let f = 0
        const t = S.time.addEvent({ delay: 260, loop: true, callback: () => flame.active && flame.setTexture(`camp-flame-${(f = 1 - f)}`) })
        flame.once('destroy', () => t.remove())
      }
      const glow = this.add(d, S.add.image(ox + 138, oy + 52, 'glow').setBlendMode(Phaser.BlendModes.ADD).setScale(0.7).setAlpha(0.7).setDepth(4001))
      if (!this.deps.reducedMotion) S.tweens.add({ targets: glow, alpha: 0.45, duration: 700, yoyo: true, repeat: -1 })
    }
    this.add(d, S.add.image(ox + 162, oy + 70, 'camp-logseat').setOrigin(0.5, 1).setDepth(oy + 70))
    this.add(d, S.add.image(ox + 172, oy + 26, 'woodpile').setOrigin(0.5, 1).setDepth(oy + 26))
    this.addBody(d, ox + 172, oy + 22, 14, 8)
    this.drawLamp(d, ox + 184, oy + 48, !desolate)
  }

  /** The post box beside the gate path, its flag up when a parcel waits for you. */
  private drawMailbox(d: Drawn, flag: boolean): void {
    const at = this.mailboxSpot()
    this.add(d, this.scene.add.image(at.x, at.y, flag ? 'mailbox-flag' : 'mailbox').setOrigin(0.5, 1).setDepth(at.y))
    this.addBody(d, at.x, at.y - 3, 6, 6)
  }

  private mailboxSpot(): { x: number; y: number } {
    const m = this.land!.mailbox
    return { x: m.tx * TILE + 8, y: (m.ty + 1) * TILE }
  }

  private drawCottage(d: Drawn, ox: number, oy: number, tier: number, desolate: boolean): void {
    const img = this.add(d, this.scene.add.image(ox + 128, oy + 80, tier >= 2 ? 'cottage-workshop' : 'cottage').setOrigin(0.5, 1).setDepth(oy + 80))
    // Desolate: dark windows, the paint gone dull.
    if (desolate) img.setTint(0x8a8a9a)
    this.addBody(d, ox + 128, oy + 80 - (COTTAGE_H - 20) / 2 - 2, 92, COTTAGE_H - 24)
    this.drawLamp(d, ox + 184, oy + 80, !desolate)
  }

  private drawLamp(d: Drawn, x: number, y: number, lit = true): void {
    const props = this.scene.textures.get('fingersnap-props')
    if (!props.has('lantern-post')) return
    const f = props.get('lantern-post')!
    this.add(d, this.scene.add.image(x, y, 'fingersnap-props', 'lantern-post').setOrigin(0.5, 1).setScale(26 / f.height).setDepth(y))
    if (lit) {
      const glow = this.add(d, this.scene.add.image(x + 3, y - 19, 'glow').setBlendMode(Phaser.BlendModes.ADD).setScale(0.7).setDepth(4001))
      if (!this.deps.reducedMotion) this.scene.tweens.add({ targets: glow, alpha: 0.72, duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    }
    this.addBody(d, x, y - 3, 8, 6)
  }

  private drawItems(d: Drawn, home: HomeView, scene: HomeScene, ox: number, oy: number, desolate = false): void {
    for (const it of home.items) {
      if (it.scene !== scene || it.x === null || it.y === null) continue
      const def = homeItem(it.itemDef)
      if (!def) continue
      const rot = it.rotation ?? 0
      const [fw, fh] = rotatedFootprint(def, rot)
      const bx = ox + it.x * TILE
      const by = oy + (it.y + fh) * TILE
      const flat = decoFlat(it.itemDef)
      const key = decoKey(it.itemDef, rot)
      // Pieces without runtime art draw the items-pass world sprite (the
      // items pass's own art for the piece, footprint-sized).
      const art = this.scene.textures.exists(key) ? null : itemWorldArt(it.itemDef)
      if (!art && !this.scene.textures.exists(key)) continue
      let img: Phaser.GameObjects.Image
      if (art) {
        const f = itemsFrame(art.slice('items-art:'.length))
        const w = f ? f.width : fw * TILE
        const h = f ? f.height : fh * TILE
        const scale = Math.min((fw * TILE) / w, (fh * TILE) / h) || 1
        img = this.add(d, this.scene.add.image(bx + (fw * TILE) / 2, by, art).setOrigin(0.5, 1).setScale(scale).setDepth(flat ? -3 : by))
      } else {
        img = this.add(d, this.scene.add.image(bx, by, key).setOrigin(0, 1).setDepth(flat ? -3 : by))
      }
      if (rot === 180 || rot === 270) img.setFlipX(true)
      if (desolate) img.setTint(0xa0a0aa)
      img.setData('instance', it.id)
      if (!flat) this.addBody(d, bx + (fw * TILE) / 2, by - (fh * TILE) / 2 - 1, fw * TILE - 4, fh * TILE - 6)
      // Lamps glow; a lantern post wears its name on the crossbar.
      if (it.itemDef === POST) {
        if (!desolate) {
          const glow = this.add(d, this.scene.add.image(bx + 11, by - 26, 'glow').setBlendMode(Phaser.BlendModes.ADD).setScale(0.6).setAlpha(0.8).setDepth(4001))
          if (!this.deps.reducedMotion) this.scene.tweens.add({ targets: glow, alpha: 0.55, duration: 1300, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
        }
        if (it.name) {
          this.add(
            d,
            this.scene.add
              .text(bx + 8, by - 40, short(it.name, 18), { fontFamily: '"Pixelify Sans", monospace', fontSize: '5px', color: '#fff3c4', stroke: '#2b1d1a', strokeThickness: 2, resolution: 10 })
              .setOrigin(0.5, 1)
              .setDepth(by + 0.5)
          )
        }
      } else if (!desolate && (it.itemDef === 'iron-lantern' || it.itemDef === 'amber-sconce' || it.itemDef === 'stone-hearth')) {
        this.add(d, this.scene.add.image(bx + (fw * TILE) / 2, by - 10, 'glow').setBlendMode(Phaser.BlendModes.ADD).setScale(0.5).setAlpha(0.75).setDepth(4001))
      }
    }
  }

  // ---- inside a cottage

  private drawRoom(): void {
    const d = this.homeDrawn
    this.clear(d)
    const S = this.scene
    // The hearth fire, flickering.
    const fire = this.add(d, S.add.sprite(ROOM_HEARTH.x + 8, ROOM_HEARTH.fireY, 'room-fire-0').setOrigin(0.5, 1).setDepth(-4))
    const flicker = commonsAnim(S, 'hearth-fire-animation')
    if (flicker && !this.deps.reducedMotion) fire.play(flicker)
    else if (!this.deps.reducedMotion) {
      let f = 0
      const t = S.time.addEvent({ delay: 240, loop: true, callback: () => fire.active && fire.setTexture(`room-fire-${(f = 1 - f)}`) })
      fire.once('destroy', () => t.remove())
    }
    const glow = this.add(d, S.add.image(ROOM_HEARTH.x + 8, 38, 'glow').setBlendMode(Phaser.BlendModes.ADD).setScale(1.3).setAlpha(0.8).setDepth(4001))
    if (!this.deps.reducedMotion) S.tweens.add({ targets: glow, alpha: 0.55, duration: 800, yoyo: true, repeat: -1 })
    const home = this.here()
    if (home) this.drawItems(d, home, 'indoor', ROOM_GRID.tx * TILE, ROOM_GRID.ty * TILE)
    if (home && home.tier >= 2) {
      // The workshop's chest and bench stand against the back wall, off the floor grid.
      this.add(d, S.add.image(ROOM_CHEST.x, 50, 'workshop-chest').setOrigin(0.5, 1).setDepth(49))
      this.add(d, S.add.image(ROOM_BENCH.x, 52, 'workshop-bench').setOrigin(0.5, 1).setDepth(49))
    }
  }

  /** Whose place this is, in words ("Ada’s Place", "Ada & Bo’s place", "Lot 3"). */
  private placeName(home: HomeView | null, gate: number): string {
    if (!home || home.members.length === 0) return lotName(gate)
    if (home.members.length === 1) return signText(home.members[0].displayName || 'A neighbour')
    return `${home.members.map((m) => m.displayName || 'A neighbour').slice(0, 2).join(' & ')}’s Place`
  }

  private announce(): void {
    const gate = this.gate!
    const home = this.here()
    const mine = !!home?.member
    if (this.deps.room) {
      bus.emit(HOME_EV.room, {
        eyebrow: 'Hearthwick Commons',
        title: mine ? 'Your cottage' : this.placeName(home, gate),
        body: mine ? 'Steady as a route stone. She’ll creak come autumn.' : 'Wipe your boots. Look, don’t touch.'
      })
      return
    }
    bus.emit(HOME_EV.room, {
      eyebrow: `${lotName(gate)} · Behind the Commons gates`,
      title: mine ? 'Your land' : home ? this.placeName(home, gate) : 'Unclaimed land',
      body: mine
        ? 'Held by lamplight. Set a named lantern post at the edge to hold more.'
        : home
          ? home.desolate
            ? 'Nobody has lit these lamps in a while. The wild is coming back.'
            : 'A neighbour’s place. Look, don’t touch.'
          : 'Nobody’s land yet. Silas sells the deed, at his yard on the Commons.'
    })
  }

  // ------------------------------------------------------------ interactions

  /** Where a placed piece stands (px, its footprint's bottom-centre). */
  private decoSpot(it: HomeInstance, scene: HomeScene): { x: number; y: number } {
    const def = homeItem(it.itemDef)
    const [fw, fh] = rotatedFootprint(def ?? { footprint: [1, 1] } as HomeItem, it.rotation ?? 0)
    const ox = (scene === 'indoor' ? ROOM_GRID.tx * TILE : 0)
    const oy = (scene === 'indoor' ? ROOM_GRID.ty * TILE : 0)
    return { x: ox + (it.x ?? 0) * TILE + (fw * TILE) / 2, y: oy + ((it.y ?? 0) + fh) * TILE - 4 }
  }

  private interactionList(): Interactable[] {
    const out: Interactable[] = []
    if (this.deps.room) {
      out.push({ id: 'home:hearth', x: ROOM_HEARTH.x + 8, y: ROOM_HEARTH.y + 10, label: 'Sit by the hearth' })
      const home = this.here()
      // Cooking at the hearth (your own place, connected): the hearth recipes.
      if (home?.member && this.homes.connected) out.push({ id: 'home:cook', x: ROOM_HEARTH.x - 14, y: ROOM_HEARTH.y + 14, label: 'Cook at the hearth' })
      if (home) {
        for (const it of home.items) {
          if (!home.member || !this.homes.connected) break
          if (it.itemDef !== 'writing-desk' || it.scene !== 'indoor' || it.x === null || it.y === null) continue
          out.push({ id: `home:desk:${it.id}`, ...this.decoSpot(it, 'indoor'), label: 'Sit at the desk' })
        }
      }
      if (home && home.tier >= 2) {
        out.push({ id: 'home:chest', x: ROOM_CHEST.x, y: 60, label: home.member ? 'Open the chests' : 'Look at the chest' })
        out.push({ id: 'home:bench', x: ROOM_BENCH.x, y: 60, label: home.member ? 'Work at the bench' : 'Look at the bench' })
      }
      return out
    }
    if (this.land) {
      const L = this.land
      const home = this.here()
      if (!home) {
        out.push({ id: 'home:stake', x: (L.site.x + L.site.w / 2) * TILE, y: (L.site.y + L.site.h - 1) * TILE + 2, label: 'Read the sign' })
        return out
      }
      const box = this.mailboxSpot()
      const first = home.members.find((m) => m.id !== this.homes.myId)
      if (home.member || first) out.push({ id: 'home:mail', x: box.x, y: box.y + 2, label: home.member ? 'Check your mailbox' : `Leave something for ${short(first!.displayName || 'a neighbour', 16)}` })
      const door = { x: (L.door.tx + 1) * TILE, y: L.doorstep.ty * TILE + 4 }
      if (home.tier >= 1) out.push({ id: 'home:door', ...door, label: home.member ? 'Go inside' : `Visit the cottage` })
      else if (home.member) out.push({ id: 'home:bed', x: L.origin.x + 96, y: L.origin.y + 52, label: 'Your bedroll' })
      for (const it of home.items) {
        if (it.itemDef !== POST || it.scene !== 'outdoor' || it.x === null || it.y === null) continue
        out.push({ id: `home:post:${it.id}`, x: it.x * TILE + 8, y: (it.y + 1) * TILE + 2, label: `Read the lamp${it.name ? `: ${short(it.name, 20)}` : ''}` })
      }
      // A woodpile of yours on the land: stack green timber, collect seasoned.
      for (const it of home.items) {
        if (!home.member || !this.homes.connected) break
        if (it.itemDef !== 'woodpile' || it.scene !== 'outdoor' || it.x === null || it.y === null) continue
        out.push({ id: `home:woodpile:${it.id}`, ...this.decoSpot(it, 'outdoor'), label: 'Tend the woodpile' })
      }
      return out
    }
    if (!this.commons) return out
    const f = this.commons.features
    const at = (t: { tx: number; ty: number }, dy = 0) => ({ x: t.tx * TILE + 8, y: t.ty * TILE + TILE + dy })
    out.push({ id: SILAS_ID, ...at(f.silas, -4), label: 'Talk to Silas' })
    out.push({ id: 'home:hame', ...at(f.hame, 6), label: 'Look at the hame' })
    out.push({ id: 'home:board', ...at(f.board, 2), label: 'Read the notice board' })
    out.push({ id: 'home:well', ...at({ tx: f.well.tx, ty: f.well.ty }, 4), label: 'Look into the well' })
    out.push({ id: 'home:toolbox', ...at(f.toolbox), label: 'Look in Silas’s toolbox' })
    out.push({ id: 'home:firebox', ...at(f.firebox, 2), label: 'Look at the firebox' })
    for (const slot of this.commons.gates) out.push({ id: `home:sign:${slot.gate}`, ...at(slot.sign, 2), label: `Read the sign · ${lotName(slot.gate)}` })
    return out
  }

  owns(id: InteractId): boolean {
    return id.startsWith('home:')
  }

  marker(id: InteractId): 'quest' | 'talk' | null {
    if (id !== SILAS_ID) return null
    if (this.homes.connected && this.homes.status === 'ready' && (!this.homes.claimed || this.homes.inviteForMe())) return 'quest'
    if (!this.deps.session.state.flags.includes(HOME_FLAGS.met)) return 'talk'
    return null
  }

  markerOffset(id: InteractId): number | null {
    if (id === SILAS_ID) return 24
    if (id === 'home:hame') return 40
    if (id === 'home:board') return 32
    if (id === 'home:well') return 44
    if (id === 'home:door') return 30
    if (id.startsWith('home:post:')) return 36
    return 16
  }

  label(id: InteractId): string | null {
    if (id === 'home:bed') return `Rest at your bedroll · ${checkSpend(this.deps.session.state, { kind: 'home-rest' }).cost} ember`
    if (id === 'home:hearth' && this.ownRoom()) return `Rest by your hearth · ${checkSpend(this.deps.session.state, { kind: 'home-rest' }).cost} ember`
    return null
  }

  verb(id: InteractId): string | null {
    if (id === 'home:door') return 'Enter'
    if (id === 'home:bed' || id === 'home:hearth') return 'Rest'
    if (id === 'home:cook') return 'Cook'
    if (id.startsWith('home:desk:')) return 'Sit'
    if (id.startsWith('home:woodpile:')) return 'Stack'
    if (id === SILAS_ID) return 'Talk'
    if (id.startsWith('home:sign:') || id === 'home:stake' || id.startsWith('home:post:')) return 'Read'
    return 'Look'
  }

  activate(id: InteractId): void {
    if (id === SILAS_ID) return this.talkToSilas()
    if (id === 'home:bed' || (id === 'home:hearth' && this.ownRoom())) return this.offerRest(id === 'home:bed' ? 'Your bedroll' : 'Your hearth')
    if (id === 'home:door') return void this.goInside()
    if (id.startsWith('home:sign:')) return this.readSign(Number(id.slice('home:sign:'.length)))
    if (id.startsWith('home:post:')) {
      const post = this.here()?.items.find((i) => i.id === id.slice('home:post:'.length))
      return this.say({
        speaker: post?.name ? `“${post.name}”` : 'A lantern post',
        lines: [post?.name ? `A lantern post, its name cut into the crossbar: ${post.name}. The ground stays put as far as its light reaches.` : 'A lantern post. Nobody has named it, and the dark doesn’t care about it.']
      })
    }
    if (id === 'home:stake') {
      const gate = this.gate!
      this.homes.chosenGate = gate
      return this.say({
        speaker: lotName(gate),
        lines: [
          this.homes.connected
            ? 'A stake and a slate: UNCLAIMED. DEEDS FROM S. — THE YARD. Wild ground all round, but there’s a level patch here where a camp would sit.'
            : 'Wild ground, and a level patch where a camp would sit. Deeds are for people with a world: sign in to yours from the Menu.'
        ]
      })
    }
    if (id === 'home:mail') {
      if (!this.homes.connected) return this.say({ speaker: 'Mailbox', lines: ['A carter’s post box. Parcels go between neighbours in a world. Sign in to yours from the Menu.'] })
      const home = this.here()
      sfx('open')
      const other = home?.members.find((m) => m.id !== this.homes.myId)
      bus.emit(VILLAGE_EV.open, home?.member || !other ? { panel: 'mail' } : { panel: 'mail', to: other.id })
      return
    }
    if (id.startsWith('home:desk:')) {
      if (!this.ownRoom() || !this.homes.connected) {
        return this.say({ speaker: 'A writing desk', lines: ['A slant-top desk, a jar of quills, rag paper. Its owner copies out pages here.'] })
      }
      sfx('open')
      bus.emit(VILLAGE_EV.open, { panel: 'desk' })
      return
    }
    if (id.startsWith('home:woodpile:')) {
      if (!this.homes.connected || !this.here()?.member) {
        return this.say({ speaker: 'A woodpile', lines: ['Green timber, stacked to season. “Green wood sinks, dry wood sings.”'] })
      }
      sfx('open')
      bus.emit(VILLAGE_EV.open, { panel: 'woodpile' })
      return
    }
    const say = (speaker: string, lines: string[]) => this.say({ speaker, lines })
    switch (id) {
      case 'home:hearth': {
        const name = this.placeName(this.here(), this.gate ?? 0)
        return say(name, ['Quarried stone, never drift-stone. It is warm, and it isn’t yours to sit by. Leave one for Ada, and let yourself out.'])
      }
      case 'home:cook': {
        sfx('open')
        bus.emit(VILLAGE_EV.open, { panel: 'hearth' })
        return
      }
      case 'home:hame':
        return say('The Commons Gate', [
          'A carter’s hame hangs on the gatepost: an empty collar, its brass polished bright. It hangs for the cart that never came home.',
          CARTING_DAY_NOTICE
        ])
      case 'home:board':
        return openBoard()
      case 'home:chest':
      case 'home:bench': {
        if (this.ownRoom()) {
          sfx('open')
          bus.emit(VILLAGE_EV.open, { panel: id === 'home:chest' ? 'chest' : 'bench' })
          return
        }
        const name = this.placeName(this.here(), this.gate ?? 0)
        return say(id === 'home:chest' ? 'The chest' : 'The bench', [id === 'home:chest' ? `Oak and iron, waxed against the damp. It belongs to ${name}, and it’s shut.` : `A heavy bench, clean tools racked over it. Someone at ${name} keeps it tidy.`])
      }
      case 'home:well':
        return say('The Carters’ Well', ['The old staging well. Every cart filled its casks here before the lantern road. The rope is new; the bucket isn’t.'])
      case 'home:toolbox': {
        this.deps.session.addFlag(HOME_FLAGS.met)
        const found = grantPaper(this.deps.session, PAPERS.toolbox)
        return say('Silas’s Toolbox', found
          ? ['Chisels wrapped in oilcloth, a fold rule, a tally-pouch gone soft with handling. Something is scratched on the pouch. You copy it out.']
          : ['Chisels in oilcloth, a fold rule, the tally-pouch. Everything clean. Rust is just iron forgetting it is a saw.'])
      }
      case 'home:firebox': {
        const ready = this.deps.session.questStage === 'complete' && (this.homes.mine?.tier ?? 0) >= 1
        if (ready && !this.deps.session.state.flags.includes(paperFlag(PAPERS.firebox))) {
          grantPaper(this.deps.session, PAPERS.firebox)
          return say('Silas’s Firebox', ['A wedge of pine offcut waits in the kindling box, charcoal all over it. Silas hasn’t burned this one. You take a careful look.'])
        }
        return say('Silas’s Firebox', ['The firebox ticks as it cools. A box of pine offcuts waits for kindling, every one of them drawn on.'])
      }
    }
  }

  private readSign(gate: number): void {
    const info = this.homes.gateInfo(gate)
    if (!info || info.homeId === null) {
      this.homes.chosenGate = gate
      const price = info?.price
      this.say({
        speaker: lotName(gate),
        lines: [
          this.homes.status === 'guest'
            ? 'UNCLAIMED. Wild land past the gate. Deeds are for people with a world: sign in to yours from the Menu.'
            : `UNCLAIMED. Wild land past the gate. Deeds from S. at the yard${price === 0 ? ' — first deed on the Compact' : price ? ` — ${price} embers` : ''}.`,
          'Walk through and have a look, if you like. The woods don’t mind.'
        ]
      })
      return
    }
    const names = info.names.length ? info.names.join(', ') : 'nobody now'
    this.say({
      speaker: lotName(gate),
      lines: [
        info.desolate
          ? `The paint has gone grey. You can just make out: ${names}. Nobody has lit the lamps back there in a while.`
          : info.mine
            ? `Your sign: ${names}. Silas cut the letters deep so the weather has to work for it.`
            : `${names}. A neighbour’s place: walk through to visit.`
      ]
    })
  }

  private ownRoom(): boolean {
    return !!this.deps.room && !!this.here()?.member
  }

  private say(d: Dialogue): void {
    uiState.dialogueOpen = true
    // Carrying Hollis's fox adds the quiet line (give it back / not yet).
    let lines = d.lines
    let choices = d.choices
    if (d.speaker === SILAS.name) {
      const ask = keepsakeAsk('silas', this.deps.session.state.flags, itemsFor(this.deps.session).view?.stacks.map((s) => s.itemDef) ?? [])
      if (ask) {
        lines = [...lines, ask.line]
        choices = [...(choices ?? []), ...ask.choices]
      }
    }
    sfx('open')
    bus.emit(EV.dialogue, { id: 'home', speaker: d.speaker, lines, choices })
  }

  /** Who stands at Silas's table right now (presence, this world), but you. */
  private atTable(): { id: string; name: string }[] {
    const feed = presence()
    if (!feed) return []
    const t = HOMESTEAD_DATA.commons.silasTable
    const now = performance.now()
    const out: { id: string; name: string }[] = []
    for (const p of feed.peersIn('commons')) {
      if (p.leftAt !== null) continue
      const at = p.track.at(now)
      if (at && Math.hypot(at.x - t.x, at.y - t.y) <= t.radius) out.push({ id: p.habiticaId, name: p.displayName || 'A neighbour' })
    }
    return out
  }

  private heroAtTable(): boolean {
    const t = HOMESTEAD_DATA.commons.silasTable
    const h = this.deps.hero()
    return Math.hypot(h.x - t.x, h.y - t.y) <= t.radius
  }

  /** Silas checks his plot book first (who holds what, who wants a joint deed), then talks. */
  private talkToSilas(): void {
    if (this.homes.connected && this.homes.status === 'ready') {
      uiState.dialogueOpen = true
      void this.homes.load().finally(() => {
        if (this.gone) return
        this.talkToSilasNow()
      })
      return
    }
    this.talkToSilasNow()
  }

  private talkToSilasNow(): void {
    const s = this.deps.session
    const lines = SILAS.dialogue
    const first = !s.state.flags.includes(HOME_FLAGS.met)
    s.addFlag(HOME_FLAGS.met)
    if (!this.homes.connected) {
      this.say({
        speaker: SILAS.name,
        lines: [
          ...(first ? lines.firstMeeting.lines : [lines.idleLines[this.nextIdle()]]),
          'Deeds out here are for folk with a world, mind. Sign in to your world and I’ll sell you one. Land past any gate on the lane.'
        ]
      })
      return
    }
    if (this.homes.status !== 'ready') {
      this.say({
        speaker: SILAS.name,
        lines: [
          ...(first ? lines.firstMeeting.lines : []),
          this.homes.status === 'offline'
            ? 'Can’t make out the plot book just now. Weather, likely. Come back when the road to your world is clear.'
            : 'Hold on, I’m finding your page in the plot book.'
        ]
      })
      if (this.homes.status !== 'loading') void this.homes.load()
      return
    }
    const mine = this.homes.mine
    if (!this.homes.claimed) {
      const invite = this.homes.inviteForMe()
      const choices: DialogueChoice[] = []
      if (invite) choices.push({ text: `Sign ${short(invite.from.name, 14)}’s deed`, note: `${lotName(invite.gate)} · together, at the table`, action: `home:sign:${invite.homeId}` })
      for (const g of this.homes.reclaimable().slice(0, 2)) choices.push({ text: `Take back ${lotName(g.gate)}`, note: 'Your old deed, as it stands · free', action: `home:claim:${g.gate}` })
      for (const g of this.homes.unclaimed().slice(0, 4)) {
        const price = g.price ?? HOMESTEAD_DATA.deeds.embers
        const short = price > s.state.embers
        choices.push(short ? { text: `The deed to ${lotName(g.gate)}`, note: `Needs ${price} embers`, disabled: true } : { text: `The deed to ${lotName(g.gate)}`, note: price === 0 ? 'First deed: on the Compact' : `${price} embers`, action: `home:claim:${g.gate}` })
      }
      choices.push({ text: 'Not yet' })
      this.say({
        speaker: SILAS.name,
        lines: [
          ...(first ? lines.firstMeeting.lines : ['There you are, neighbour.']),
          invite
            ? `${invite.from.name} wants your name on their deed, ${lotName(invite.gate)}. Both of you here at my table, both of you sign, and it’s done.`
            : this.homes.reclaimable().length
              ? `Your old page’s still in the book: ${lotName(this.homes.reclaimable()[0].gate)}. Nobody’s struck it out. Say the word and your name goes back on, or pick fresh land.`
            : 'I measure land in lantern-light, not yards. Pick a gate on the lane, read the sign, walk the ground if you like. Then I’ll draw you the deed.'
        ],
        choices
      })
      return
    }
    if (!mine) {
      this.say({ speaker: SILAS.name, lines: ['Hold on, I’m finding your page in the plot book.'] })
      void this.homes.load()
      return
    }
    const choices: DialogueChoice[] = []
    if (mine.tier === 0) {
      const cost = this.homes.cottagePrice()
      const short = s.state.embers < cost
      choices.push(short ? { text: 'Raise a cottage', note: `Needs ${cost} embers`, disabled: true } : { text: 'Raise a cottage', note: `${cost} embers`, action: 'home:upgrade' })
    }
    if (mine.tier === 1) {
      const why = workshopShort(s.state.embers, this.homes.materials)
      choices.push(why ? { text: 'Build on a workshop', note: why, disabled: true } : { text: 'Build on a workshop', note: workshopPrice(), action: 'home:upgrade' })
    }
    choices.push({ text: 'See what you’ve finished', action: 'home:shop' })
    choices.push({ text: 'Share the deed', note: 'Someone at the table with you', action: 'home:share' })
    choices.push({ text: 'Give up my place on the deed', action: 'home:leave' })
    choices.push({ text: 'Just passing' })
    const intro = mine.tier === 0
      ? [s.state.embers < this.homes.cottagePrice() ? lines.notEnoughEmbers.lines[0] : 'Your camp’s holding. Four skids and a slate roof, and you’d have a door to hang a fox over. Say the word.']
      : mine.tier === 1
        ? ['Deep eaves, a heavy bench and a chest that doesn’t drink the damp. Bring me timber, stone and fiber from the Wilds and I’ll build you a workshop.', lines.sellDecorations.lines[0]]
        : [lines.sellDecorations.lines[0]]
    this.say({ speaker: SILAS.name, lines: mine.tier === 0 ? intro : [lines.idleLines[this.nextIdle()], ...intro], choices })
  }

  private nextIdle(): number {
    this.idleLine = (this.idleLine + 1) % SILAS.dialogue.idleLines.length
    return this.idleLine
  }

  private offerRest(speaker: string): void {
    const s = this.deps.session
    const check = s.checkSpend({ kind: 'home-rest' })
    const offline = s.link && !s.link.online
    const choice: DialogueChoice = offline
      ? { text: 'Rest a while', note: 'Needs a connection', disabled: true }
      : check.ok
        ? { text: 'Rest a while', note: `${check.cost} ember`, action: 'home-rest' }
        : { text: 'Rest a while', note: check.reason === 'full' ? 'Already rested' : check.reason === 'needs-earned' ? `Needs ${check.cost} ember earned on Habitica` : `Needs ${check.cost} ember`, disabled: true }
    this.say({
      speaker,
      lines: [speaker === 'Your bedroll'
        ? 'The cot is up off the ground on its blocks, the way the pamphlets say. The fire’s banked. Your own lamp keeps the dark off.'
        : 'Your own hearth, banked low. The floor creaks the way Silas promised.'],
      choices: [choice, { text: 'Not now' }]
    })
  }

  private async goInside(): Promise<void> {
    if (!this.land) return
    sfx('open')
    this.deps.enterRoom(this.land.gate, this.land.doorstep)
  }

  /** A choice picked in a homestead conversation. */
  async onAction(action: string): Promise<void> {
    if (action.startsWith('home:claim:')) return this.claim(Number(action.slice('home:claim:'.length)))
    if (action.startsWith('home:sign:')) return this.signDeed(action.slice('home:sign:'.length))
    if (action.startsWith('home:offer:')) return this.offerDeed(action.slice('home:offer:'.length))
    if (action === 'home:share') return this.share()
    if (action === 'home:leave') {
      bus.emit(HOME_EV.confirmLeave, { place: this.placeName(this.homes.mine, this.homes.myGate ?? 0), shared: (this.homes.mine?.members.length ?? 1) > 1 })
      return
    }
    if (action === 'home:leave-confirmed') return this.leave()
    if (action === 'home:shop') {
      bus.emit(HOME_EV.openShop)
      return
    }
    if (action === 'home:upgrade') {
      const r = await this.homes.upgrade()
      if (!this.scene.sys.isActive()) return
      if (r.ok) {
        sfx('lantern')
        const workshop = (this.homes.mine?.tier ?? 0) >= 2
        this.say({
          speaker: SILAS.name,
          lines: workshop
            ? ['There. Deep eaves, a heavy bench, and a chest that won’t drink the damp. Clean your tools. Rust is just iron forgetting it is a saw.']
            : [...SILAS.dialogue.afterUpgrade.lines.map((l) => l.replace('Go on in.', 'It’s up on your land, past your gate. Go on in.'))]
        })
      } else if (r.code === 'insufficient-embers') {
        this.say({ speaker: SILAS.name, lines: SILAS.dialogue.notEnoughEmbers.lines })
      } else {
        bus.emit(EV.toast, { text: r.text, kind: 'error' })
      }
    }
  }

  private async claim(gate: number): Promise<void> {
    const back = this.homes.gateInfo(gate)?.reclaim ?? false
    const r = await this.homes.claim(gate)
    if (!this.scene.sys.isActive()) return
    if (!r.ok) {
      this.say({ speaker: SILAS.name, lines: [r.code === 'insufficient-embers' ? SILAS.dialogue.notEnoughEmbers.lines[0] : r.text] })
      return
    }
    sfx('quest')
    this.scheduleRedraw()
    if (back) {
      this.say({ speaker: SILAS.name, lines: [`There. Your name’s back on ${lotName(gate)}, same ink. It’s all as you left it, give or take the weeds.`] })
      bus.emit(EV.toast, { text: `${lotName(gate)} is yours again.`, icon: 'lantern' })
      return
    }
    this.say({
      speaker: SILAS.name,
      lines: [
        ...SILAS.dialogue.offerCampsite.lines,
        `There: ${lotName(gate)}, in my square hand, measured in lantern-light. Your camp’s set up past the gate. Follow the lane; you’ll see your sign.`
      ]
    })
    bus.emit(EV.toast, { text: `${lotName(gate)} is yours. Follow the marker to your gate.`, icon: 'lantern' })
  }

  private async leave(): Promise<void> {
    const r = await this.homes.leave()
    if (!this.scene.sys.isActive()) return
    if (!r.ok) {
      bus.emit(EV.toast, { text: r.text, kind: 'error' })
      return
    }
    sfx('close')
    this.scheduleRedraw()
    this.say({
      speaker: SILAS.name,
      lines: ['I’ll strike your name. What’s in your pack is yours, and your own chest goes with you. The rest stays with the land.', 'Plenty of gates on the lane when you’re ready.']
    })
  }

  /** Who could share the deed: everyone else standing at Silas's table. */
  private share(): void {
    if (!this.heroAtTable()) {
      this.say({ speaker: SILAS.name, lines: [homeErrorText('not-at-table')] })
      return
    }
    const here = this.atTable()
    const members = new Set(this.homes.mine?.members.map((m) => m.id) ?? [])
    const candidates = here.filter((p) => !members.has(p.id)).slice(0, 4)
    if (candidates.length === 0) {
      this.say({ speaker: SILAS.name, lines: ['Both names go on together, and both of you sign here at my table. Bring them by. I’ll wait. I’m good at it.'] })
      return
    }
    this.say({
      speaker: SILAS.name,
      lines: ['A joint deed, then. Same land, same say, both names. Who’s it to be?'],
      choices: [...candidates.map((p) => ({ text: short(p.name, 22), note: 'Sign together', action: `home:offer:${p.id}` })), { text: 'Not now' }]
    })
  }

  private async offerDeed(to: string): Promise<void> {
    const r = await this.homes.offerDeed(to)
    if (!this.scene.sys.isActive()) return
    if (!r.ok) {
      this.say({ speaker: SILAS.name, lines: [r.text] })
      return
    }
    this.deedAnswer(r.status)
  }

  private async signDeed(homeId: string): Promise<void> {
    const me = this.homes.myId
    if (!me) return
    const r = await this.homes.sign(homeId, me)
    if (!this.scene.sys.isActive()) return
    if (!r.ok) {
      this.say({ speaker: SILAS.name, lines: [r.text] })
      return
    }
    this.deedAnswer(r.status)
  }

  private deedAnswer(status: 'joined' | 'waiting' | undefined): void {
    if (status === 'joined') {
      sfx('quest')
      this.scheduleRedraw()
      this.say({ speaker: SILAS.name, lines: ['There. Both names, same land, same say. Mind you both keep the lamps lit.'] })
      return
    }
    const window = HOMESTEAD_DATA.jointDeed.confirmWindowSeconds
    this.say({ speaker: SILAS.name, lines: [`Your name’s down. Now the other one signs, here at the table. I’ll hold the ink about ${window >= 60 ? `${Math.round(window / 60)} minute${window >= 120 ? 's' : ''}` : `${window} seconds`}.`] })
  }

  // ------------------------------------------------------------ arranging

  /** Per frame: the way to your gate, and is the hero somewhere they may arrange their own place? */
  update(dt: number): void {
    this.updateGuide()
    this.arrangeTimer -= dt
    if (this.arrangeTimer > 0) return
    this.arrangeTimer = 0.25
    const home = this.here()
    let next: ArrangeView = { available: false, scene: null, tier: home?.tier ?? 0 }
    if (home?.member && !this.placement) {
      if (this.deps.room) next = { available: true, scene: 'indoor', tier: home.tier }
      else if (this.land) next = { available: true, scene: 'outdoor', tier: home.tier }
    }
    if (next.available !== this.arrange.available || next.scene !== this.arrange.scene || next.tier !== this.arrange.tier) this.emitArrange(next)
  }

  private emitArrange(v: ArrangeView): void {
    this.arrange = v
    bus.emit(HOME_EV.arrange, v)
  }

  private ground(): PlacementGround | undefined {
    const h = this.here()
    return this.land && h ? { land: this.land.land, cleared: clearedSet(h.cleared) } : undefined
  }

  private startPlacement(): void {
    if (this.placement || !this.arrange.available || !this.arrange.scene) return
    const scene = this.arrange.scene
    let ox = 0
    let oy = 0
    let cols: number
    let rows: number
    if (scene === 'indoor') {
      ox = ROOM_GRID.tx * TILE
      oy = ROOM_GRID.ty * TILE
      cols = HOMESTEAD_DATA.indoor.width
      rows = HOMESTEAD_DATA.indoor.height
    } else {
      if (!this.land) return
      cols = this.land.width
      rows = this.land.height
    }
    this.placement = {
      scene,
      ox,
      oy,
      cols,
      rows,
      selected: null,
      x: 0,
      y: 0,
      rotation: 0,
      busy: false,
      message: null,
      clearing: null,
      overlay: this.scene.add.graphics().setDepth(5200),
      ghost: null
    }
    this.emitArrange({ available: false, scene: null, tier: this.arrange.tier })
    this.deps.hero().setVelocity(0, 0)
    touchVec.x = 0
    touchVec.y = 0
    const cam = this.scene.cameras.main
    cam.stopFollow()
    // Outdoors the land is big: start framed on the hero.
    const h = this.deps.hero()
    const c = scene === 'indoor' ? this.frame(ox + (cols * TILE) / 2, oy + (rows * TILE) / 2) : this.frame(h.x, h.y)
    cam.pan(c.x, c.y, this.deps.reducedMotion ? 0 : 400, 'Sine.easeInOut')
    this.scene.input.keyboard?.on('keydown', this.onKey, this)
    this.scene.input.on('pointerdown', this.onPointer, this)
    this.scene.scale.on('resize', this.reframe, this)
    sfx('open')
    this.refreshPlacement()
  }

  /** The screen changed shape mid-arrange: frame the piece (or the grid) again. */
  private reframe(): void {
    // After this frame: the camera's own viewport and zoom update on resize too.
    this.scene.time.delayedCall(0, () => this.reframeNow())
  }

  private reframeNow(): void {
    const p = this.placement
    if (!p) return
    const it = p.selected ? this.instance(p.selected) : undefined
    const def = it && homeItem(it.itemDef)
    if (!def && p.scene === 'outdoor') {
      const h = this.deps.hero()
      const c = this.frame(h.x, h.y)
      this.scene.cameras.main.centerOn(c.x, c.y)
      return
    }
    const [w, h] = def ? rotatedFootprint(def, p.rotation) : [p.cols, p.rows]
    const c = this.frame(p.ox + (def ? p.x : 0) * TILE + (w * TILE) / 2, p.oy + (def ? p.y : 0) * TILE + (h * TILE) / 2)
    this.scene.cameras.main.centerOn(c.x, c.y)
  }

  /**
   * Camera centre that shows world point (x, y) in the part of the screen
   * the tray leaves open (it covers the bottom ~40% on a phone).
   */
  private frame(x: number, y: number): { x: number; y: number } {
    const cam = this.scene.cameras.main
    const vh = cam.height / cam.zoom
    const portrait = cam.height > cam.width
    return { x, y: y + vh * (portrait ? 0.24 : 0.14) }
  }

  private endPlacement(animate = true): void {
    const p = this.placement
    if (!p) return
    p.overlay.destroy()
    p.ghost?.destroy()
    this.placement = null
    this.scene.input.keyboard?.off('keydown', this.onKey, this)
    this.scene.input.off('pointerdown', this.onPointer, this)
    this.scene.scale.off('resize', this.reframe, this)
    bus.emit(HOME_EV.placement, null)
    if (animate) {
      const cam = this.scene.cameras.main
      cam.startFollow(this.deps.hero(), true, 0.12, 0.12)
      sfx('close')
      // A short grace so the key that closed the tray doesn't swing a sword.
      uiState.blockedUntil = performance.now() + 220
    }
    this.arrangeTimer = 0
  }

  private onKey(e: KeyboardEvent): void {
    const p = this.placement
    if (!p) return
    // A modal, dialogue or lease gate owns input: placement waits. A key the
    // interface already handled (Escape closing a panel) is not ours too.
    if (uiBlocked() || (e as KeyboardEvent & { fsConsumed?: boolean }).fsConsumed) return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    const k = e.code
    const move: Record<string, [number, number]> = { ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0], ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1] }
    if (move[k]) this.command({ kind: 'nudge', dx: move[k][0], dy: move[k][1] })
    else if (k === 'KeyR') this.command({ kind: 'rotate' })
    else if (k === 'KeyE' || k === 'Enter' || k === 'Space') {
      // A focused tray button handles its own Enter/Space.
      if (k !== 'KeyE' && t && t.tagName === 'BUTTON') return
      this.command({ kind: 'confirm' })
    } else if (k === 'Delete' || k === 'Backspace' || k === 'KeyX') this.command({ kind: 'remove' })
    else if (k === 'Escape') this.command(p.selected || p.clearing ? { kind: 'cancel' } : { kind: 'exit' })
  }

  private onPointer(pointer: Phaser.Input.Pointer): void {
    const p = this.placement
    if (!p || p.busy || uiBlocked()) return
    const gx = Math.floor((pointer.worldX - p.ox) / TILE)
    const gy = Math.floor((pointer.worldY - p.oy) / TILE)
    if (gx < 0 || gy < 0 || gx >= p.cols || gy >= p.rows) return
    const hit = this.instanceAt(p.scene, gx, gy)
    if (!p.selected && hit) {
      this.select(hit.id)
      return
    }
    if (!p.selected) {
      // Outdoors, nothing in hand: a tree, stump or boulder on lit ground can be cleared.
      const g = this.ground()
      const home = this.here()
      if (p.scene === 'outdoor' && g && home && clearable(effectiveKind(g.land, g.cleared, gx, gy)) && isLit(this.lights(home), gx, gy)) {
        p.clearing = { x: gx, y: gy }
        p.message = null
        sfx('click')
        this.refreshPlacement()
      } else if (p.clearing) {
        p.clearing = null
        this.refreshPlacement()
      }
      return
    }
    const it = this.instance(p.selected)
    const def = it && homeItem(it.itemDef)
    if (!def) return
    const [w, h] = rotatedFootprint(def, p.rotation)
    p.x = Phaser.Math.Clamp(gx - Math.floor((w - 1) / 2), 0, p.cols - w)
    p.y = Phaser.Math.Clamp(gy - Math.floor((h - 1) / 2), 0, p.rows - h)
    p.message = null
    this.refreshPlacement()
  }

  private instance(id: string): HomeInstance | undefined {
    return this.here()?.items.find((i) => i.id === id)
  }

  private instanceAt(scene: HomeScene, gx: number, gy: number): HomeInstance | undefined {
    return this.here()?.items.find((i) => {
      if (i.scene !== scene || i.x === null || i.y === null) return false
      const def = homeItem(i.itemDef)
      if (!def) return false
      const [w, h] = rotatedFootprint(def, i.rotation ?? 0)
      return gx >= i.x && gx < i.x + w && gy >= i.y && gy < i.y + h
    })
  }

  private select(id: string): void {
    const p = this.placement
    const it = this.instance(id)
    const def = it && homeItem(it.itemDef)
    if (!p || !it || !def) return
    p.selected = id
    p.clearing = null
    p.message = null
    if (it.scene === p.scene && it.x !== null && it.y !== null) {
      p.x = it.x
      p.y = it.y
      p.rotation = it.rotation ?? 0
    } else {
      // A new piece starts at the nearest free spot to the hero (outdoors) or the room's middle.
      p.rotation = 0
      const [w, h] = rotatedFootprint(def, 0)
      const spot = this.firstFree(it, w, h)
      p.x = spot.x
      p.y = spot.y
    }
    sfx('click')
    this.refreshPlacement()
  }

  /** The free spot nearest the hero (outdoors) or the room's middle-bottom (indoors). */
  private firstFree(it: HomeInstance, w: number, h: number): { x: number; y: number } {
    const p = this.placement!
    const home = this.here()!
    const hero = this.deps.hero()
    const cx = p.scene === 'outdoor' ? (hero.x - p.ox) / TILE - w / 2 : (p.cols - w) / 2
    const cy = p.scene === 'outdoor' ? (hero.y - p.oy) / TILE - h / 2 - 1 : p.rows - h - 2
    let best = { x: Phaser.Math.Clamp(Math.round(cx), 0, p.cols - w), y: Phaser.Math.Clamp(Math.round(cy), 0, p.rows - h) }
    let bestD = Infinity
    const g = this.ground()
    for (let y = 0; y <= p.rows - h; y++)
      for (let x = 0; x <= p.cols - w; x++) {
        if (checkPlacement({ tier: Math.max(1, home.tier), items: home.items }, it, p.scene, x, y, 0, HOMESTEAD_DATA, g)) continue
        const d = Math.hypot(x - cx, (y - cy) * 1.3)
        if (d < bestD) {
          bestD = d
          best = { x, y }
        }
      }
    return best
  }

  private command(c: PlacementCommand): void {
    const p = this.placement
    if (!p) return
    if (uiBlocked() && c.kind !== 'exit') return
    if (c.kind === 'exit') return this.endPlacement()
    if (p.busy) return
    switch (c.kind) {
      case 'select':
        return this.select(c.itemId)
      case 'cancel':
        p.selected = null
        p.clearing = null
        p.message = null
        sfx('close')
        return this.refreshPlacement()
      case 'nudge': {
        const it = p.selected ? this.instance(p.selected) : undefined
        const def = it && homeItem(it.itemDef)
        if (!def) return
        const [w, h] = rotatedFootprint(def, p.rotation)
        p.x = Phaser.Math.Clamp(p.x + c.dx, 0, p.cols - w)
        p.y = Phaser.Math.Clamp(p.y + c.dy, 0, p.rows - h)
        p.message = null
        sfx('blip')
        return this.refreshPlacement()
      }
      case 'rotate': {
        const it = p.selected ? this.instance(p.selected) : undefined
        const def = it && homeItem(it.itemDef)
        if (!def || !canRotate(def)) return
        p.rotation = (((p.rotation + 90) % 360) as Rotation)
        const [w, h] = rotatedFootprint(def, p.rotation)
        p.x = Phaser.Math.Clamp(p.x, 0, p.cols - w)
        p.y = Phaser.Math.Clamp(p.y, 0, p.rows - h)
        sfx('click')
        return this.refreshPlacement()
      }
      case 'confirm':
        return void this.confirm()
      case 'remove':
        return void this.remove()
      case 'clear':
        return void this.clearTile()
    }
  }

  /** Ask the player to name a lantern post (null: they thought better of it). */
  private askName(): Promise<string | null> {
    return new Promise((resolve) => {
      const done = (v: { name: string | null }) => {
        bus.off(HOME_EV.named, done)
        resolve(v?.name ?? null)
      }
      bus.on(HOME_EV.named, done)
      // After this key's own default action: the E that set the post down
      // must not land in the name field.
      setTimeout(() =>
        bus.emit(HOME_EV.namePrompt, {
          title: 'Name the lamp',
          body: 'Land only stays put where a named lamp holds it. What will you call this one?',
          placeholder: 'The Wren, Ada’s Light, Last Post…',
          max: HOMESTEAD_DATA.lanternPosts.nameMax
        })
      )
    })
  }

  private async confirm(): Promise<void> {
    const p = this.placement
    const it = p?.selected ? this.instance(p.selected) : undefined
    if (!p || !it) return
    const placedHere = it.scene === p.scene && it.x !== null
    const op = it.scene !== null ? 'move' : 'place'
    if (placedHere && it.x === p.x && it.y === p.y && (it.rotation ?? 0) === p.rotation) {
      p.selected = null
      return this.refreshPlacement()
    }
    let name: string | undefined
    if (op === 'place' && it.itemDef === POST) {
      const problem = checkPlacement(this.here()!, it, p.scene, p.x, p.y, p.rotation, HOMESTEAD_DATA, this.ground())
      if (problem) {
        p.message = { text: homeErrorText(problem), kind: 'error' }
        return this.refreshPlacement()
      }
      p.busy = true
      this.refreshPlacement()
      const given = await this.askName()
      if (this.placement !== p) return
      p.busy = false
      if (!given) return this.refreshPlacement()
      name = given
    }
    p.busy = true
    this.refreshPlacement()
    const r = await this.homes.act({ op, itemId: it.id, scene: p.scene, x: p.x, y: p.y, rotation: p.rotation, ...(name ? { name } : {}) })
    if (this.placement !== p) return
    p.busy = false
    if (r.ok) {
      sfx(it.itemDef === POST ? 'lantern' : 'pop')
      this.deps.fx.sparkBurst(p.ox + (p.x + 0.5) * TILE, p.oy + (p.y + 0.5) * TILE, it.itemDef === POST ? 18 : 8)
      p.message = { text: it.itemDef === POST && name ? `“${name}” is lit. The ground in its light is yours.` : `${itemName(it.itemDef)}: ${op === 'move' ? 'moved' : 'set out'}.`, kind: 'ok' }
      p.selected = null
      this.nudgeHeroClear()
      if (it.itemDef === POST) this.drawShade()
    } else {
      sfx('fizzle')
      p.message = { text: r.text, kind: 'error' }
    }
    this.refreshPlacement()
  }

  private async remove(): Promise<void> {
    const p = this.placement
    const it = p?.selected ? this.instance(p.selected) : undefined
    if (!p || !it) return
    if (it.scene === null) {
      p.selected = null
      return this.refreshPlacement()
    }
    const problem = checkRemoval(this.here()!, it)
    if (problem) {
      p.message = { text: homeErrorText(problem), kind: 'error' }
      return this.refreshPlacement()
    }
    p.busy = true
    this.refreshPlacement()
    const r = await this.homes.act({ op: 'remove', itemId: it.id })
    if (this.placement !== p) return
    p.busy = false
    p.message = r.ok ? { text: `${itemName(it.itemDef)}: put away.`, kind: 'ok' } : { text: r.text, kind: 'error' }
    if (r.ok) {
      sfx('close')
      p.selected = null
      if (it.itemDef === POST) this.drawShade()
    }
    this.refreshPlacement()
  }

  /** Silas comes by with his saw: the tile's obstacle is gone (the map rebuilds). */
  private async clearTile(): Promise<void> {
    const p = this.placement
    const c = p?.clearing
    if (!p || !c) return
    p.busy = true
    this.refreshPlacement()
    const r = await this.homes.clear(c.x, c.y)
    if (this.placement !== p) return
    p.busy = false
    if (!r.ok) {
      sfx('fizzle')
      p.message = { text: r.text, kind: 'error' }
      return this.refreshPlacement()
    }
    sfx('pop')
    bus.emit(EV.toast, { text: 'Silas comes by with his saw and a bar. That tile’s clear.', icon: 'ember' })
    this.endPlacement()
    this.deps.rebuild()
  }

  /** A piece set down on the hero: step them onto the doorstep instead of trapping them. */
  private nudgeHeroClear(): void {
    const hero = this.deps.hero()
    const p = this.placement
    if (!p) return
    const gx = Math.floor((hero.x - p.ox) / TILE)
    const gy = Math.floor((hero.y - 4 - p.oy) / TILE)
    if (!this.instanceAt(p.scene, gx, gy)) return
    if (p.scene === 'indoor') hero.setPosition((ROOM_GRID.tx + 5.5) * TILE, (ROOM_GRID.ty + 9.5) * TILE)
    else if (this.land) hero.setPosition((this.land.doorstep.tx + 1) * TILE, (this.land.doorstep.ty + 1.5) * TILE)
  }

  private refreshPlacement(): void {
    const p = this.placement
    if (!p) return
    const home = this.here()
    if (!home?.member) return this.endPlacement()
    const g = p.overlay
    g.clear()
    const ground = this.ground()
    const lights = p.scene === 'outdoor' ? this.lights(home) : []
    // The grid: faint cells where you may build (lit, open ground outdoors),
    // reserved tiles and obstacles hatched, placed pieces outlined.
    const cell = (x: number, y: number) => {
      if (p.scene === 'indoor') return 'open'
      if (!isLit(lights, x, y)) return 'dark'
      const k = ground ? effectiveKind(ground.land, ground.cleared, x, y) : LAND.GRASS
      if (clearable(k)) return 'obstacle'
      return buildableKind(k) ? 'open' : 'blocked'
    }
    for (let y = 0; y < p.rows; y++)
      for (let x = 0; x < p.cols; x++) {
        const c = cell(x, y)
        if (c === 'dark') continue
        const px = p.ox + x * TILE
        const py = p.oy + y * TILE
        g.fillStyle(c === 'open' ? 0x1a1420 : 0x2b1d1a, c === 'open' ? 0.16 : 0.3)
        g.fillRect(px, py, TILE, TILE)
        g.lineStyle(1, 0xfff3c4, c === 'open' ? 0.22 : 0.1)
        g.strokeRect(px, py, TILE, TILE)
        if (c === 'obstacle') {
          g.lineStyle(1, 0xffd24a, 0.35)
          g.lineBetween(px + 3, py + TILE - 3, px + TILE - 3, py + 3)
        }
      }
    if (p.scene === 'indoor') {
      g.lineStyle(1, 0xfff3c4, 0.7)
      g.strokeRect(p.ox, p.oy, p.cols * TILE, p.rows * TILE)
    }
    const reserved = p.scene === 'indoor' ? HOMESTEAD_DATA.indoorReserved : HOMESTEAD_DATA.outdoorReserved
    g.fillStyle(0x2b1d1a, 0.35)
    for (const r of reserved) g.fillRect(p.ox + r.x * TILE, p.oy + r.y * TILE, r.w * TILE, r.h * TILE)
    g.lineStyle(1, 0x2b1d1a, 0.45)
    for (const r of reserved)
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) g.lineBetween(p.ox + x * TILE + 2, p.oy + (y + 1) * TILE - 2, p.ox + (x + 1) * TILE - 2, p.oy + y * TILE + 2)
    for (const it of home.items) {
      if (it.scene !== p.scene || it.x === null || it.y === null || it.id === p.selected) continue
      const def = homeItem(it.itemDef)
      if (!def) continue
      const [w, h] = rotatedFootprint(def, it.rotation ?? 0)
      g.lineStyle(1, 0xffd24a, 0.8)
      g.strokeRect(p.ox + it.x * TILE + 1, p.oy + it.y * TILE + 1, w * TILE - 2, h * TILE - 2)
    }
    if (p.clearing) {
      g.lineStyle(2, 0xffd24a, 1)
      g.strokeRect(p.ox + p.clearing.x * TILE + 1, p.oy + p.clearing.y * TILE + 1, TILE - 2, TILE - 2)
    }
    // The piece in hand (a lantern post shows the ground its light would hold).
    let problem: string | null = null
    const it = p.selected ? this.instance(p.selected) : undefined
    const def = it && homeItem(it.itemDef)
    p.ghost?.destroy()
    p.ghost = null
    if (it && def) {
      const [w, h] = rotatedFootprint(def, p.rotation)
      const code = checkPlacement(home, it, p.scene, p.x, p.y, p.rotation, HOMESTEAD_DATA, ground)
      problem = code ? homeErrorText(code) : null
      const key = decoKey(it.itemDef, p.rotation)
      const bx = p.ox + p.x * TILE
      const by = p.oy + (p.y + h) * TILE
      if (it.itemDef === POST && p.scene === 'outdoor') {
        g.lineStyle(1, 0xffd98a, 0.8)
        g.strokeCircle(bx + TILE / 2, by - TILE / 2, (HOMESTEAD_DATA.lanternPosts.radius + 0.5) * TILE)
      }
      // Runtime art when it exists, else the items pass's world sprite (or
      // its commons alias) — the same fallback the placed piece draws.
      const art = this.scene.textures.exists(key) ? null : itemWorldArt(it.itemDef)
      const hasArt = !!art && this.scene.textures.exists(art)
      if (hasArt) {
        const f = itemsFrame(art!.slice('items-art:'.length))
        const fw = f ? f.width : w * TILE
        const fh = f ? f.height : h * TILE
        const scale = Math.min((w * TILE) / fw, (h * TILE) / fh) || 1
        p.ghost = this.scene.add.image(bx + (w * TILE) / 2, by, art!).setOrigin(0.5, 1).setScale(scale).setDepth(5300).setAlpha(0.85)
        if (p.rotation === 180 || p.rotation === 270) p.ghost.setFlipX(true)
      } else if (!art) {
        p.ghost = this.scene.add.image(bx, by, key).setOrigin(0, 1).setDepth(5300).setAlpha(0.85)
        if (p.rotation === 180 || p.rotation === 270) p.ghost.setFlipX(true)
      }
      g.fillStyle(code ? 0xc4523a : 0x5cb07a, 0.35)
      g.fillRect(bx, by - h * TILE, w * TILE, h * TILE)
      g.lineStyle(1, code ? 0xff8a6a : 0xb8f0c0, 1)
      g.strokeRect(bx + 0.5, by - h * TILE + 0.5, w * TILE - 1, h * TILE - 1)
      // Keep the piece in view, above the tray.
      const cam = this.scene.cameras.main
      const vw = cam.width / cam.zoom
      const vh = cam.height / cam.zoom
      const c = this.frame(bx + (w * TILE) / 2, by - (h * TILE) / 2)
      if (Math.abs(c.x - cam.midPoint.x) > vw * 0.25 || Math.abs(c.y - cam.midPoint.y) > vh * 0.12) cam.pan(c.x, c.y, 200, 'Sine.easeOut', true)
    }
    const clearKind = p.clearing && ground ? effectiveKind(ground.land, ground.cleared, p.clearing.x, p.clearing.y) : null
    const view: PlacementView = {
      scene: p.scene,
      tier: home.tier,
      items: home.items.map((i) => ({
        id: i.id,
        itemDef: i.itemDef,
        name: i.itemDef === POST && i.name ? `${itemName(i.itemDef)}: ${i.name}` : itemName(i.itemDef),
        placed: i.scene === p.scene,
        elsewhere: i.scene !== null && i.scene !== p.scene,
        fits: homeItem(i.itemDef)?.where.includes(p.scene) ?? false
      })),
      selected: p.selected,
      problem,
      canRotate: !!def && canRotate(def),
      busy: p.busy,
      message: p.message,
      clearing: p.clearing && clearKind !== null ? { ...p.clearing, what: clearKind === LAND.TREE ? 'tree' : clearKind === LAND.STUMP ? 'stump' : 'boulder', cost: HOMESTEAD_DATA.clearTileEmbers } : null,
      spot: it && def ? { x: p.x, y: p.y, rotation: p.rotation } : null
    }
    this.placementView = view
    bus.emit(HOME_EV.placement, view)
  }
}

/** "30 embers, 20 timber, 10 stone, 8 fiber" */
function workshopPrice(): string {
  return `${WORKSHOP_TIER.embers} embers, ${costPhrase(WORKSHOP_TIER.materials ?? {})}`
}

/** Why the workshop can't be built yet (null: it can). */
export function workshopShort(embers: number, materials: Record<string, number>): string | null {
  if (embers < WORKSHOP_TIER.embers) return `Needs ${WORKSHOP_TIER.embers} embers`
  for (const [m, n] of Object.entries(WORKSHOP_TIER.materials ?? {})) if ((materials[m] ?? 0) < n) return `Needs ${n} ${m}`
  return null
}

function short(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** The rect of a canvas's non-transparent pixels (the whole canvas when empty). */
function opaqueBounds(src: HTMLCanvasElement): { x: number; y: number; w: number; h: number } {
  const data = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, src.width, src.height).data
  let x0 = src.width
  let y0 = src.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++)
      if (data[(y * src.width + x) * 4 + 3] > 0) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
  return x1 < 0 ? { x: 0, y: 0, w: src.width, h: src.height } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}
