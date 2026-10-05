/**
 * Homesteads in the scene: what the Commons shows on top of its map (plots
 * at their tier, decorations, name signs, Silas, the hame on the gate), what
 * a cottage shows inside, the conversations there, and placement mode for
 * arranging your own place.
 *
 * Data comes from src/game/homestead.ts (one per session); this layer only
 * draws it and turns presses into actions. Everything it draws for a plot
 * is rebuilt when that data changes.
 */
import Phaser from 'phaser'
import { HOMESTEAD_DATA, canRotate, checkPlacement, homeItem, rotatedFootprint, type HomeInstance, type HomeScene, type Rotation } from '../../lib/homestead'
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
import type { CommonsWorld, PlotSlot } from '../commons'
import { COTTAGE_H, decoFlat, decoKey } from '../commons-art'
import { commonsAnim, commonsDataUrl } from '../commons-pass'
import { ROOM_BENCH, ROOM_CHEST, ROOM_GRID, ROOM_HEARTH } from '../cottage'
import { grantPaper } from '../papers'
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
  signText,
  itemName,
  type ArrangeView,
  type Homesteads,
  type PlacementCommand,
  type PlacementView,
  type PlotView
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
  /** In a cottage: whose, and the doorstep to come back out to. */
  room: { owner: string } | null
  /** Walk into a cottage (the scene fades and rebuilds). */
  enterRoom: (owner: string, doorstep: { tx: number; ty: number }) => void
  /** The Commons needs more rows than this map has: rebuild it. */
  rebuild: () => void
}

const SILAS_ID = 'home:silas'

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
  overlay: Phaser.GameObjects.Graphics
  ghost: Phaser.GameObjects.Image | null
}

export class HomesteadLayer implements InteractionProvider {
  private readonly homes: Homesteads
  private readonly village: Village
  private readonly commons: CommonsWorld | null
  private plotDrawn = new Map<number, Drawn>()
  private roomDrawn: Drawn = { objects: [], bodies: [] }
  private silas: Phaser.GameObjects.Sprite | null = null
  private placement: Placement | null = null
  private arrange: ArrangeView = { available: false, scene: null, tier: 0 }
  private arrangeTimer = 0
  private idleLine = Math.floor(Math.random() * SILAS.dialogue.idleLines.length)

  constructor(private scene: Phaser.Scene, private deps: HomesteadDeps) {
    this.homes = homesteadsFor(deps.session)
    this.village = villageFor(deps.session)
    this.commons = deps.world.areaId === 'commons' ? (deps.world as CommonsWorld) : null
    if (this.commons) this.buildCommonsFixtures()
    this.emitThumbs()
    const onChange = (p?: { ownerId?: string }) => this.scheduleRedraw(p?.ownerId)
    const onCommand = (c: PlacementCommand) => this.command(c)
    const onArrange = () => this.startPlacement()
    bus.on(HOME_EV.changed, onChange)
    // Mail changes your mailbox flag: just your plot.
    const onVillage = (p: { what: string }) => p?.what === 'mail' && this.scheduleRedraw(this.homes.myId ?? undefined)
    bus.on(VILLAGE_EV.changed, onVillage)
    scene.events.once('shutdown', () => bus.off(VILLAGE_EV.changed, onVillage))
    bus.on(HOME_EV.command, onCommand)
    bus.on('game:home-arrange', onArrange)
    scene.events.once('shutdown', () => {
      bus.off(HOME_EV.changed, onChange)
      bus.off(HOME_EV.command, onCommand)
      bus.off('game:home-arrange', onArrange)
      if (this.placement) this.endPlacement(false)
      this.emitArrange({ available: false, scene: null, tier: 0 })
    })
    // Read-only view of the Commons for playtests: plots by slot.
    ;(window as unknown as { __fsHomes?: () => unknown }).__fsHomes = () => ({
      status: this.homes.status,
      claimed: this.homes.claimed,
      plots: this.homes.plots(),
      mine: this.homes.mine,
      slots: this.commons?.plots.map((p) => ({ index: p.index, tx: p.tx, ty: p.ty, door: p.door, doorstep: p.doorstep, sign: p.sign })) ?? [],
      features: this.commons?.features ?? null,
      placing: !!this.placement,
      stats: {
        plotDraws: this.plotDraws,
        tweens: this.scene.tweens.getTweens().length,
        deadTweens: this.scene.tweens.getTweens().filter((t) => t.targets.some((o) => !(o as Phaser.GameObjects.GameObject).active)).length
      }
    })
    this.redraw()
    if (this.commons) void this.homes.load()
    if (this.commons && this.homes.connected) void this.village.loadMail()
    if (deps.room) this.announceRoom()
  }

  /** Placement mode owns input: the hero waits. */
  get placing(): boolean {
    return this.placement !== null
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
    this.addBody(this.roomDrawn, sx, sy - 4, 12, 8)
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

  /** Owners whose plots need drawing, or 'all'; flushed once per frame. */
  private pending: Set<string> | 'all' | null = null
  /** Plots drawn since the scene started (playtests check redraws stay linear). */
  private plotDraws = 0

  /** Coalesce change events: one redraw a frame, only of the plots that changed. */
  private scheduleRedraw(ownerId?: string): void {
    const first = this.pending === null
    if (!ownerId || this.pending === 'all') this.pending = 'all'
    else {
      const set: Set<string> = this.pending ?? new Set()
      set.add(ownerId)
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

  private redraw(owners?: Set<string>): void {
    if (this.commons) {
      if (this.homes.slotCount() > this.commons.plots.length) {
        this.deps.rebuild()
        return
      }
      this.drawPlots(owners)
    } else if (this.deps.room) {
      this.drawRoom()
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

  private drawPlots(owners?: Set<string>): void {
    const views = new Map<number, PlotView>()
    for (const p of this.homes.plots()) views.set(p.slot, p)
    for (const slot of this.commons!.plots) {
      const view = views.get(slot.index) ?? null
      if (owners && (!view || !owners.has(view.ownerId))) continue
      this.plotDraws++
      const d = this.plotDrawn.get(slot.index) ?? { objects: [], bodies: [] }
      this.clear(d)
      this.plotDrawn.set(slot.index, d)
      this.drawPlot(d, slot, views.get(slot.index) ?? null)
    }
  }

  private drawPlot(d: Drawn, slot: PlotSlot, view: PlotView | null): void {
    const ox = slot.tx * TILE
    const oy = slot.ty * TILE
    const home = view ? this.homes.homes.get(view.ownerId) : undefined
    const settled = view && view.allocated && (!view.mine || this.homes.claimed)
    if (!settled) {
      this.drawStakes(d, ox, oy)
      const text = !view ? (this.homes.status === 'guest' ? 'Open\nground' : 'Unclaimed') : `Reserved for\n${short(view.mine ? 'you' : view.name, 11)}`
      this.drawSign(d, slot, text, true)
      return
    }
    const tier = home?.tier ?? view!.tier
    if (tier >= 1) this.drawCottage(d, ox, oy, tier)
    else this.drawCamp(d, ox, oy)
    this.drawSign(d, slot, signText(short(view!.name, 11)).replace(' Place', '\nPlace'), false)
    this.drawMailbox(d, slot, !!view!.mine && this.village.waitingCount() > 0)
    if (home && tier >= 1) this.drawItems(d, home, 'outdoor', ox, oy)
  }

  private drawStakes(d: Drawn, ox: number, oy: number): void {
    const w = HOMESTEAD_DATA.outdoor.width * TILE
    const h = HOMESTEAD_DATA.outdoor.height * TILE
    const g = this.add(d, this.scene.add.graphics().setDepth(-4))
    g.lineStyle(1, 0xefe2c0, 0.55)
    const corners: [number, number][] = [[ox + 4, oy + 6], [ox + w - 4, oy + 6], [ox + w - 4, oy + h - 4], [ox + 4, oy + h - 4]]
    g.beginPath()
    g.moveTo(corners[0][0], corners[0][1])
    for (const c of [...corners.slice(1), corners[0]]) g.lineTo(c[0], c[1])
    g.strokePath()
    for (const [x, y] of corners) this.add(d, this.scene.add.image(x, y + 3, 'stake').setOrigin(0.5, 1).setDepth(y + 3))
  }

  private drawSign(d: Drawn, slot: PlotSlot, text: string, reserved: boolean): void {
    // Off the fence a little, toward the lane.
    const x = slot.sign.tx * TILE + 8 + (slot.side === 'east' ? 6 : -6)
    const y = slot.sign.ty * TILE + TILE
    this.add(d, this.scene.add.image(x, y, reserved ? 'plot-sign-reserved' : 'plot-sign').setOrigin(0.5, 1).setDepth(y))
    this.add(
      d,
      this.scene.add
        .text(x, y - 15, text, {
          fontFamily: '"Pixelify Sans", monospace',
          fontSize: '5px',
          color: reserved ? '#5c4128' : '#2b1d1a',
          align: 'center',
          lineSpacing: -1,
          resolution: 10
        })
        .setOrigin(0.5, 0.5)
        .setDepth(y + 0.5)
    )
    this.addBody(d, x, y - 3, 6, 6)
  }

  private drawCamp(d: Drawn, ox: number, oy: number): void {
    const S = this.scene
    this.add(d, S.add.image(ox + 128, oy + 50, 'camp-patch').setDepth(-4))
    this.add(d, S.add.image(ox + 98, oy + 30, 'camp-windbreak').setOrigin(0.5, 1).setDepth(oy + 30))
    this.add(d, S.add.image(ox + 96, oy + 48, 'camp-cot').setOrigin(0.5, 1).setDepth(oy + 48))
    this.addBody(d, ox + 96, oy + 43, 30, 8)
    this.add(d, S.add.image(ox + 138, oy + 62, 'camp-ring').setOrigin(0.5, 1).setDepth(oy + 56))
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
    this.addBody(d, ox + 138, oy + 57, 18, 8)
    this.add(d, S.add.image(ox + 162, oy + 70, 'camp-logseat').setOrigin(0.5, 1).setDepth(oy + 70))
    this.add(d, S.add.image(ox + 172, oy + 26, 'woodpile').setOrigin(0.5, 1).setDepth(oy + 26))
    this.addBody(d, ox + 172, oy + 22, 14, 8)
    this.drawLamp(d, ox + 184, oy + 48)
  }

  /** The post box below the gateway, its flag up when a parcel waits for you. */
  private drawMailbox(d: Drawn, slot: PlotSlot, flag: boolean): void {
    const at = this.mailboxSpot(slot)
    this.add(d, this.scene.add.image(at.x, at.y, flag ? 'mailbox-flag' : 'mailbox').setOrigin(0.5, 1).setDepth(at.y))
    this.addBody(d, at.x, at.y - 3, 6, 6)
  }

  private mailboxSpot(slot: PlotSlot): { x: number; y: number } {
    return { x: slot.sign.tx * TILE + 8, y: (slot.ty + 8) * TILE }
  }

  private drawCottage(d: Drawn, ox: number, oy: number, tier = 1): void {
    this.add(d, this.scene.add.image(ox + 128, oy + 80, tier >= 2 ? 'cottage-workshop' : 'cottage').setOrigin(0.5, 1).setDepth(oy + 80))
    this.addBody(d, ox + 128, oy + 80 - (COTTAGE_H - 20) / 2 - 2, 92, COTTAGE_H - 24)
    this.drawLamp(d, ox + 184, oy + 80)
  }

  private drawLamp(d: Drawn, x: number, y: number): void {
    const props = this.scene.textures.get('fingersnap-props')
    if (!props.has('lantern-post')) return
    const f = props.get('lantern-post')!
    this.add(d, this.scene.add.image(x, y, 'fingersnap-props', 'lantern-post').setOrigin(0.5, 1).setScale(26 / f.height).setDepth(y))
    const glow = this.add(d, this.scene.add.image(x + 3, y - 19, 'glow').setBlendMode(Phaser.BlendModes.ADD).setScale(0.7).setDepth(4001))
    if (!this.deps.reducedMotion) this.scene.tweens.add({ targets: glow, alpha: 0.72, duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    this.addBody(d, x, y - 3, 8, 6)
  }

  private drawItems(d: Drawn, home: HomeView, scene: HomeScene, ox: number, oy: number): void {
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
      if (!this.scene.textures.exists(key)) continue
      const img = this.add(d, this.scene.add.image(bx, by, key).setOrigin(0, 1).setDepth(flat ? -3 : by))
      if (rot === 180 || rot === 270) img.setFlipX(true)
      img.setData('instance', it.id)
      if (!flat) this.addBody(d, bx + (fw * TILE) / 2, by - (fh * TILE) / 2 - 1, fw * TILE - 4, fh * TILE - 6)
      // Lamps glow.
      if (it.itemDef === 'iron-lantern' || it.itemDef === 'amber-sconce' || it.itemDef === 'stone-hearth') {
        this.add(d, this.scene.add.image(bx + (fw * TILE) / 2, by - 10, 'glow').setBlendMode(Phaser.BlendModes.ADD).setScale(0.5).setAlpha(0.75).setDepth(4001))
      }
    }
  }

  private drawRoom(): void {
    const d = this.roomDrawn
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
    const home = this.homes.homes.get(this.deps.room!.owner)
    if (home) this.drawItems(d, home, 'indoor', ROOM_GRID.tx * TILE, ROOM_GRID.ty * TILE)
    if (home && home.tier >= 2) {
      // The workshop's chest and bench stand against the back wall, off the floor grid.
      this.add(d, S.add.image(ROOM_CHEST.x, 50, 'workshop-chest').setOrigin(0.5, 1).setDepth(49))
      this.add(d, S.add.image(ROOM_BENCH.x, 52, 'workshop-bench').setOrigin(0.5, 1).setDepth(49))
    }
  }

  private announceRoom(): void {
    const home = this.homes.homes.get(this.deps.room!.owner)
    const mine = this.deps.room!.owner === this.homes.myId
    const name = home?.displayName || 'A neighbour'
    bus.emit(HOME_EV.room, {
      eyebrow: 'Hearthwick Commons',
      title: mine ? 'Your cottage' : signText(name),
      body: mine ? 'Steady as a route stone. She’ll creak come autumn.' : 'Wipe your boots. Look, don’t touch.'
    })
  }

  // ------------------------------------------------------------ interactions

  private interactionList(): Interactable[] {
    const out: Interactable[] = []
    if (this.deps.room) {
      out.push({ id: 'home:hearth', x: ROOM_HEARTH.x + 8, y: ROOM_HEARTH.y + 10, label: 'Sit by the hearth' })
      const home = this.homes.homes.get(this.deps.room.owner)
      if (home && home.tier >= 2) {
        out.push({ id: 'home:chest', x: ROOM_CHEST.x, y: 60, label: this.ownRoom() ? 'Open the storage chest' : 'Look at the chest' })
        out.push({ id: 'home:bench', x: ROOM_BENCH.x, y: 60, label: this.ownRoom() ? 'Work at the bench' : 'Look at the bench' })
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
    for (const p of this.homes.plots()) {
      const slot = this.commons.plots[p.slot]
      if (!slot || !p.allocated || (p.mine && !this.homes.claimed)) continue
      const home = this.homes.homes.get(p.ownerId)
      const tier = home?.tier ?? p.tier
      const door = { x: slot.door.tx * TILE + 16, y: slot.doorstep.ty * TILE + 4 }
      const box = this.mailboxSpot(slot)
      out.push({ id: `home:mail:${p.ownerId}`, x: box.x, y: box.y + 2, label: p.mine ? 'Check your mailbox' : `Leave something for ${short(p.name, 16)}` })
      if (tier >= 1) out.push({ id: `home:door:${p.ownerId}`, ...door, label: p.mine ? 'Go inside' : `Visit ${short(p.name, 16)}’s cottage` })
      else if (p.mine) out.push({ id: 'home:bed', x: slot.tx * TILE + 96, y: slot.ty * TILE + 52, label: 'Your bedroll' })
    }
    return out
  }

  owns(id: InteractId): boolean {
    return id.startsWith('home:')
  }

  marker(id: InteractId): 'quest' | 'talk' | null {
    if (id !== SILAS_ID) return null
    if (this.homes.connected && this.homes.status === 'ready' && this.homes.mine && !this.homes.claimed) return 'quest'
    if (!this.deps.session.state.flags.includes(HOME_FLAGS.met)) return 'talk'
    return null
  }

  markerOffset(id: InteractId): number | null {
    if (id === SILAS_ID) return 24
    if (id === 'home:hame') return 40
    if (id === 'home:board') return 32
    if (id === 'home:well') return 44
    if (id.startsWith('home:door:')) return 30
    return 16
  }

  label(id: InteractId): string | null {
    if (id === 'home:bed') return `Rest at your bedroll · ${checkSpend(this.deps.session.state, { kind: 'home-rest' }).cost} ember`
    if (id === 'home:hearth' && this.ownRoom()) return `Rest by your hearth · ${checkSpend(this.deps.session.state, { kind: 'home-rest' }).cost} ember`
    return null
  }

  verb(id: InteractId): string | null {
    if (id.startsWith('home:door:')) return 'Enter'
    if (id === 'home:bed' || id === 'home:hearth') return 'Rest'
    if (id === SILAS_ID) return 'Talk'
    return 'Look'
  }

  activate(id: InteractId): void {
    if (id === SILAS_ID) return this.talkToSilas()
    if (id === 'home:bed' || (id === 'home:hearth' && this.ownRoom())) return this.offerRest(id === 'home:bed' ? 'Your bedroll' : 'Your hearth')
    if (id.startsWith('home:door:')) return void this.visit(id.slice('home:door:'.length))
    if (id.startsWith('home:mail:')) {
      const owner = id.slice('home:mail:'.length)
      if (!this.homes.connected) return this.say({ speaker: 'Mailbox', lines: ['A carter’s post box. Parcels go between neighbours in a world. Sign in to yours from the Menu.'] })
      sfx('open')
      bus.emit(VILLAGE_EV.open, owner === this.homes.myId ? { panel: 'mail' } : { panel: 'mail', to: owner })
      return
    }
    const say = (speaker: string, lines: string[]) => this.say({ speaker, lines })
    switch (id) {
      case 'home:hearth': {
        const name = this.homes.homes.get(this.deps.room?.owner ?? '')?.displayName || 'Your neighbour'
        return say(`${name}’s hearth`, ['Quarried stone, never drift-stone. It is warm, and it isn’t yours to sit by. Leave one for Ada, and let yourself out.'])
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
        const name = this.homes.homes.get(this.deps.room?.owner ?? '')?.displayName || 'your neighbour'
        return say(id === 'home:chest' ? 'The chest' : 'The bench', [id === 'home:chest' ? `Oak and iron, waxed against the damp. It’s ${name}’s, and shut.` : `A heavy bench, clean tools racked over it. ${name} keeps it tidy.`])
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

  private ownRoom(): boolean {
    return !!this.deps.room && this.deps.room.owner === this.homes.myId
  }

  private say(d: Dialogue): void {
    uiState.dialogueOpen = true
    sfx('open')
    bus.emit(EV.dialogue, { id: 'home', speaker: d.speaker, lines: d.lines, choices: d.choices })
  }

  private talkToSilas(): void {
    const s = this.deps.session
    const lines = SILAS.dialogue
    const first = !s.state.flags.includes(HOME_FLAGS.met)
    s.addFlag(HOME_FLAGS.met)
    if (!this.homes.connected) {
      this.say({
        speaker: SILAS.name,
        lines: [
          ...(first ? lines.firstMeeting.lines : [lines.idleLines[this.nextIdle()]]),
          'Plots out here are for folk with a world, mind. Sign in to your world and I’ll stake you one, right along the lane.'
        ]
      })
      return
    }
    if (this.homes.status !== 'ready' || !this.homes.mine) {
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
      this.say({
        speaker: SILAS.name,
        lines: [...(first ? lines.firstMeeting.lines : ['There you are, neighbour.']), 'There’s a plot along the lane with your name chalked on the stake. Want to walk it?'],
        choices: [
          { text: 'Show me my plot', action: 'home:claim', reply: [...lines.offerCampsite.lines, 'First camp’s on the Compact. Here: I drew you up a deed, same as mine. Read the margin.'] },
          { text: 'Not yet' }
        ]
      })
      return
    }
    const choices: DialogueChoice[] = []
    if (mine.tier === 0) {
      const cost = this.homes.cottagePrice()
      const short = s.state.embers < cost
      choices.push(
        short
          ? { text: 'Raise a cottage', note: `Needs ${cost} embers`, disabled: true }
          : { text: 'Raise a cottage', note: `${cost} embers`, action: 'home:upgrade' }
      )
    }
    if (mine.tier === 1) {
      const why = workshopShort(s.state.embers, this.homes.materials)
      choices.push(why ? { text: 'Build on a workshop', note: why, disabled: true } : { text: 'Build on a workshop', note: workshopPrice(), action: 'home:upgrade' })
    }
    choices.push({ text: 'See what you’ve finished', action: 'home:shop' })
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

  private async visit(owner: string): Promise<void> {
    const p = this.homes.plots().find((v) => v.ownerId === owner)
    const slot = p ? this.commons?.plots[p.slot] : undefined
    if (!slot) return
    sfx('open')
    if (owner !== this.homes.myId) await this.homes.fetchHome(owner)
    this.deps.enterRoom(owner, slot.doorstep)
  }

  /** A choice picked in a homestead conversation. */
  async onAction(action: string): Promise<void> {
    if (action === 'home:claim') {
      if (this.homes.claim()) {
        sfx('quest')
        bus.emit(EV.toast, { text: 'Your plot on the Commons. Silas has set you up a camp.', icon: 'lantern' })
      }
      return
    }
    if (action === 'home:shop') {
      bus.emit(HOME_EV.openShop)
      return
    }
    if (action === 'home:upgrade') {
      const r = await this.homes.upgrade()
      if (!this.scene.sys.isActive()) return
      if (r.ok) {
        sfx('lantern')
        const slot = this.myslot()
        if (slot) this.deps.fx.sparkBurst((slot.tx + 8) * TILE, (slot.ty + 3) * TILE, 18)
        const workshop = (this.homes.mine?.tier ?? 0) >= 2
        this.say({
          speaker: SILAS.name,
          lines: workshop
            ? ['There. Deep eaves, a heavy bench, and a chest that won’t drink the damp. Clean your tools. Rust is just iron forgetting it is a saw.']
            : SILAS.dialogue.afterUpgrade.lines
        })
      } else if (r.code === 'insufficient-embers') {
        this.say({ speaker: SILAS.name, lines: SILAS.dialogue.notEnoughEmbers.lines })
      } else {
        bus.emit(EV.toast, { text: r.text, kind: 'error' })
      }
    }
  }

  private myslot(): PlotSlot | null {
    const p = this.homes.myPlot()
    return p && this.commons ? this.commons.plots[p.slot] ?? null : null
  }

  // ------------------------------------------------------------ arranging

  /** Per frame: is the hero somewhere they may arrange their own place? */
  update(dt: number): void {
    this.arrangeTimer -= dt
    if (this.arrangeTimer > 0) return
    this.arrangeTimer = 0.25
    const mine = this.homes.mine
    let next: ArrangeView = { available: false, scene: null, tier: mine?.tier ?? 0 }
    if (mine && this.homes.claimed && !this.placement) {
      if (this.ownRoom()) next = { available: true, scene: 'indoor', tier: mine.tier }
      else {
        const slot = this.myslot()
        const h = this.deps.hero()
        if (slot) {
          const tx = Math.floor(h.x / TILE)
          const ty = Math.floor(h.y / TILE)
          if (tx >= slot.tx - 1 && tx <= slot.tx + 16 && ty >= slot.ty - 1 && ty <= slot.ty + 12) next = { available: true, scene: 'outdoor', tier: mine.tier }
        }
      }
    }
    if (next.available !== this.arrange.available || next.scene !== this.arrange.scene || next.tier !== this.arrange.tier) this.emitArrange(next)
  }

  private emitArrange(v: ArrangeView): void {
    this.arrange = v
    bus.emit(HOME_EV.arrange, v)
  }

  private startPlacement(): void {
    if (this.placement || !this.arrange.available || !this.arrange.scene) return
    const scene = this.arrange.scene
    let ox: number
    let oy: number
    if (scene === 'indoor') {
      ox = ROOM_GRID.tx * TILE
      oy = ROOM_GRID.ty * TILE
    } else {
      const slot = this.myslot()
      if (!slot) return
      ox = slot.tx * TILE
      oy = slot.ty * TILE
    }
    const grid = scene === 'indoor' ? HOMESTEAD_DATA.indoor : HOMESTEAD_DATA.outdoor
    this.placement = {
      scene,
      ox,
      oy,
      cols: grid.width,
      rows: grid.height,
      selected: null,
      x: 0,
      y: 0,
      rotation: 0,
      busy: false,
      message: null,
      overlay: this.scene.add.graphics().setDepth(5200),
      ghost: null
    }
    this.emitArrange({ available: false, scene: null, tier: this.arrange.tier })
    this.deps.hero().setVelocity(0, 0)
    touchVec.x = 0
    touchVec.y = 0
    const cam = this.scene.cameras.main
    cam.stopFollow()
    const c = this.frame(ox + (grid.width * TILE) / 2, oy + (grid.height * TILE) / 2)
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
    else if (k === 'Escape') this.command(p.selected ? { kind: 'cancel' } : { kind: 'exit' })
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
    if (!p.selected) return
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
    return this.homes.owned().find((i) => i.id === id)
  }

  private instanceAt(scene: HomeScene, gx: number, gy: number): HomeInstance | undefined {
    return this.homes.owned().find((i) => {
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
    p.message = null
    if (it.scene === p.scene && it.x !== null && it.y !== null) {
      p.x = it.x
      p.y = it.y
      p.rotation = it.rotation ?? 0
    } else {
      // A new piece starts near the middle of the free floor, by the hero if they're on it.
      p.rotation = 0
      const [w, h] = rotatedFootprint(def, 0)
      const spot = this.firstFree(it, w, h)
      p.x = spot.x
      p.y = spot.y
    }
    sfx('click')
    this.refreshPlacement()
  }

  /** The free spot nearest the grid's middle-bottom for a new piece. */
  private firstFree(it: HomeInstance, w: number, h: number): { x: number; y: number } {
    const p = this.placement!
    const home = this.homes.mine!
    const cx = (p.cols - w) / 2
    const cy = p.rows - h - 2
    let best = { x: Math.max(0, Math.round(cx)), y: Math.max(0, cy) }
    let bestD = Infinity
    for (let y = 0; y <= p.rows - h; y++)
      for (let x = 0; x <= p.cols - w; x++) {
        if (checkPlacement({ tier: Math.max(1, home.tier), items: home.items }, it, p.scene, x, y, 0)) continue
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
    }
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
    p.busy = true
    this.refreshPlacement()
    const r = await this.homes.act({ op, itemId: it.id, scene: p.scene, x: p.x, y: p.y, rotation: p.rotation })
    if (this.placement !== p) return
    p.busy = false
    if (r.ok) {
      sfx('pop')
      this.deps.fx.sparkBurst(p.ox + (p.x + 0.5) * TILE, p.oy + (p.y + 0.5) * TILE, 8)
      p.message = { text: `${itemName(it.itemDef)}: ${op === 'move' ? 'moved' : 'set out'}.`, kind: 'ok' }
      p.selected = null
      this.nudgeHeroClear()
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
    p.busy = true
    this.refreshPlacement()
    const r = await this.homes.act({ op: 'remove', itemId: it.id })
    if (this.placement !== p) return
    p.busy = false
    p.message = r.ok ? { text: `${itemName(it.itemDef)}: put away.`, kind: 'ok' } : { text: r.text, kind: 'error' }
    if (r.ok) {
      sfx('close')
      p.selected = null
    }
    this.refreshPlacement()
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
    else {
      const slot = this.myslot()
      if (slot) hero.setPosition((slot.doorstep.tx + 1) * TILE, (slot.doorstep.ty + 0.5) * TILE)
    }
  }

  private refreshPlacement(): void {
    const p = this.placement
    if (!p) return
    const home = this.homes.mine
    if (!home) return this.endPlacement()
    const g = p.overlay
    g.clear()
    // The grid: faint cells, reserved tiles hatched, placed pieces outlined.
    g.fillStyle(0x1a1420, 0.18)
    g.fillRect(p.ox, p.oy, p.cols * TILE, p.rows * TILE)
    g.lineStyle(1, 0xfff3c4, 0.22)
    for (let x = 0; x <= p.cols; x++) g.lineBetween(p.ox + x * TILE, p.oy, p.ox + x * TILE, p.oy + p.rows * TILE)
    for (let y = 0; y <= p.rows; y++) g.lineBetween(p.ox, p.oy + y * TILE, p.ox + p.cols * TILE, p.oy + y * TILE)
    g.lineStyle(1, 0xfff3c4, 0.7)
    g.strokeRect(p.ox, p.oy, p.cols * TILE, p.rows * TILE)
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
    // The piece in hand.
    let problem: string | null = null
    const it = p.selected ? this.instance(p.selected) : undefined
    const def = it && homeItem(it.itemDef)
    p.ghost?.destroy()
    p.ghost = null
    if (it && def) {
      const [w, h] = rotatedFootprint(def, p.rotation)
      const code = checkPlacement(home, it, p.scene, p.x, p.y, p.rotation)
      problem = code ? homeErrorText(code) : null
      const key = decoKey(it.itemDef, p.rotation)
      const bx = p.ox + p.x * TILE
      const by = p.oy + (p.y + h) * TILE
      if (this.scene.textures.exists(key)) {
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
    const view: PlacementView = {
      scene: p.scene,
      tier: home.tier,
      items: home.items.map((i) => ({
        id: i.id,
        itemDef: i.itemDef,
        name: itemName(i.itemDef),
        placed: i.scene === p.scene,
        elsewhere: i.scene !== null && i.scene !== p.scene,
        fits: homeItem(i.itemDef)?.where.includes(p.scene) ?? false
      })),
      selected: p.selected,
      problem,
      canRotate: !!def && canRotate(def),
      busy: p.busy,
      message: p.message
    }
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
