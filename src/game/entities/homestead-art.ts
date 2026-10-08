/**
 * Homesteads, drawn: Silas and the hame on the Commons, every gate's sign
 * and gift shelf, the way to your own gate; on a homestead's land the camp
 * or cottage, the mailbox, every placed piece, the lantern posts and the
 * shade past their light; inside, the room and its furniture. Everything
 * here is redrawn when the homestead data changes (./homesteads.ts).
 */
import Phaser from 'phaser'
import { PEOPLE_KEY, hasPerson, peopleDensity, personAnim } from '../people'
import { solidBox } from '../area/collision'
import { HOMESTEAD_DATA, homeItem, rotatedFootprint, type HomeInstance, type HomeItem, type HomeScene } from '../../lib/homestead'
import { homeLights, isLit, type Light } from '../../lib/homestead-land'
import type { HomeView } from '../../lib/api/types'
import { decoSeat, type ArtBox, type SeatPose } from '../seats'
import { bus, EV } from '../events'
import { TILE, tileBottom, tileFeet, tileMid } from '../../lib/tile'
import type { GateSlot } from '../commons'
import { decoFlat, decoKey } from '../commons-art'
import { itemsFrame, itemWorldArt } from '../items-pass'
import { commonsAnim, commonsDataUrl } from '../commons-pass'
import { artDataUrl, artSource, densityOf, drawArt, opaqueBox } from '../density'
import { ROOM_BENCH, ROOM_CHEST, ROOM_GRID, ROOM_HEARTH } from '../cottage'
import { HOME_FLAGS, SILAS, lotName, signText } from '../homestead'
import type { HomesteadDeps, HomesteadLayer } from './homesteads'

/** The cottage's height on its land (its collision body follows it). */
const COTTAGE_H = 92

export const SILAS_ID = 'home:silas'
export const POST = HOMESTEAD_DATA.lanternPosts.item

/** What one drawing put up: its game objects and its collision bodies. */
export interface Drawn {
  objects: Phaser.GameObjects.GameObject[]
  bodies: Phaser.GameObjects.GameObject[]
}

/** A name cut short to fit a sign or a prompt. */
export function short(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

export class HomesteadArt {
  private readonly scene: Phaser.Scene
  private readonly deps: HomesteadDeps

  private gateDrawn = new Map<number, Drawn>()
  private homeDrawn: Drawn = { objects: [], bodies: [] }
  private fixtures: Drawn = { objects: [], bodies: [] }
  private silas: Phaser.GameObjects.Sprite | null = null
  /** Each seat art's opaque box, by texture and frame (seatPose). */
  private opaque = new Map<string, { l: number; t: number; r: number; b: number }>()
  /** The way to your gate (Commons): a bobbing marker over it and an arrow at the screen's edge. */
  guide: { marker: Phaser.GameObjects.Image; arrow: Phaser.GameObjects.Image; label: Phaser.GameObjects.Text } | null = null
  private shade: Phaser.GameObjects.Graphics | null = null

  constructor(private readonly home: HomesteadLayer) {
    this.scene = home.scene
    this.deps = home.deps
  }

  // ------------------------------------------------------------ fixtures

  buildCommonsFixtures(): void {
    const f = this.home.commons!.features
    // Silas, at his sawhorse (the Commons pass; code-drawn fallback).
    const sx = tileMid(f.silas.tx)
    const sy = tileBottom(f.silas.ty)
    const k = peopleDensity(this.scene)
    if (k && hasPerson(this.scene, 'silas')) {
      // The playtest-1 walking art: he breathes at his post, facing the lane.
      this.silas = this.scene.add.sprite(sx, sy, PEOPLE_KEY, 'resident-silas-down-idle-0').setOrigin(0.5, 1).setScale(1 / k).setDepth(sy)
      this.silas.play(personAnim('silas', 'down', false))
    } else {
      this.silas = this.scene.add.sprite(sx, sy, 'silas-idle-0').setOrigin(0.5, 1).setDepth(sy)
      const breathing = commonsAnim(this.scene, 'silas-breathing') ?? 'silas-breathing'
      if (this.scene.anims.exists(breathing)) this.silas.play(breathing)
    }
    this.addBody(this.fixtures, sx, sy - 4, 12, 8)
    // The hame on the north gatepost, kept polished: a glint now and then.
    const hx = tileMid(f.hame.tx)
    const hy = tileBottom(f.hame.ty) - 34
    this.scene.add.image(hx + 1, hy, 'hame').setOrigin(0.5, 0).setDepth(tileBottom(f.hame.ty) + 1)
    const glint = this.scene.add.image(hx - 4, hy + 4, 'spark').setDepth(tileBottom(f.hame.ty) + 2).setAlpha(0)
    if (!this.deps.reducedMotion) {
      this.scene.tweens.add({ targets: glint, alpha: 1, scale: 1.4, duration: 260, yoyo: true, repeat: -1, repeatDelay: 2600, ease: 'Sine.easeInOut' })
    }
    this.emitSilasPortrait()
  }

  /** The decoration art for the shop and tray, scaled up crisp. */
  emitThumbs(): void {
    const out: Record<string, string> = {}
    for (const it of HOMESTEAD_DATA.items) {
      try {
        const src = artSource(this.scene, decoKey(it.id, 0))
        if (!src) continue
        // Trimmed to the art (a chair stands in the bottom of its two-tile
        // canvas), in whole world px, scaled up as it always was.
        const o = opaqueBox(src)
        const x0 = o ? Math.floor(o.x) : 0
        const y0 = o ? Math.floor(o.y) : 0
        const b = o ? { x: x0, y: y0, w: Math.ceil(o.x + o.w) - x0, h: Math.ceil(o.y + o.h) - y0 } : { x: 0, y: 0, w: src.w, h: src.h }
        const scale = Math.max(1, Math.floor(36 / Math.max(b.w, b.h)))
        out[it.id] = artDataUrl(src, scale, b)
      } catch {
        /* thumbnails are decoration */
      }
    }
    bus.emit(EV.homeThumbs, out)
  }

  private emitSilasPortrait(): void {
    // The delivered dialogue bust, when the Commons pass loaded.
    const bust = commonsDataUrl(this.scene, 'portrait-silas')
    if (bust) {
      bus.emit(EV.portraits, { [SILAS.name]: bust })
      return
    }
    try {
      const src = artSource(this.scene, 'silas-idle-0')
      if (!src) return
      const o = document.createElement('canvas')
      o.width = 14
      o.height = 14
      const ctx = o.getContext('2d')!
      ctx.imageSmoothingEnabled = src.density > 1
      ctx.imageSmoothingQuality = 'high'
      drawArt(ctx, src, 0, 1, 14, 13, 1, 1, 14, 13)
      bus.emit(EV.portraits, { [SILAS.name]: o.toDataURL() })
    } catch {
      /* portraits are decoration */
    }
  }

  /** Gate signs drawn since the scene started (playtests check redraws stay linear). */
  gateDraws = 0

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
    const img = solidBox(this.scene, cx, cy, w, h)
    this.deps.solidGroup.add(img)
    d.bodies.push(img)
  }

  private add<T extends Phaser.GameObjects.GameObject>(d: Drawn, o: T): T {
    d.objects.push(o)
    return o
  }

  // ---- the Commons lane

  drawGates(only?: Set<number>): void {
    for (const slot of this.home.commons!.gates) {
      if (only && !only.has(slot.gate)) continue
      this.gateDraws++
      const d = this.gateDrawn.get(slot.gate) ?? { objects: [], bodies: [] }
      this.clear(d)
      this.gateDrawn.set(slot.gate, d)
      this.drawGateSign(d, slot)
      this.drawGateShelf(d, slot)
    }
  }

  private drawGateShelf(d: Drawn, slot: GateSlot): void {
    const info = this.home.homes.gateInfo(slot.gate)
    if (!info?.shelf) return
    const x = tileMid(slot.shelf.tx)
    const y = tileBottom(slot.shelf.ty)
    const key = info.shelfStocked ? 'gate-shelf-stocked' : 'gate-shelf'
    this.add(d, this.scene.add.image(x, y, key).setOrigin(0.5, 1).setDepth(y))
    this.addBody(d, x, y - 4, 12, 8)
  }

  /** The words on a gate's signpost. */
  private signWords(slot: GateSlot): { text: string; kind: 'held' | 'open' | 'weathered' } {
    const info = this.home.homes.gateInfo(slot.gate)
    if (!info || info.homeId === null) return { text: this.home.homes.status === 'guest' ? `Wild land\n${lotName(slot.gate)}` : `Unclaimed\n${lotName(slot.gate)}`, kind: 'open' }
    const names = info.names.length === 0 ? 'Nobody' : info.names.length === 1 ? short(info.names[0], 11) : `${short(info.names[0], 6)} & ${info.names.length > 2 ? 'co.' : short(info.names[1], 5)}`
    const text = info.names.length === 1 ? signText(names).replace(' Place', '\nPlace') : `${names}\n${lotName(slot.gate)}`
    return { text, kind: info.desolate ? 'weathered' : 'held' }
  }

  private drawGateSign(d: Drawn, slot: GateSlot): void {
    const { text, kind } = this.signWords(slot)
    const x = tileMid(slot.sign.tx)
    const y = tileBottom(slot.sign.ty)
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
  drawGuide(): void {
    const g = this.home.homes.myGate
    const show = g !== null && !this.deps.session.state.flags.includes(HOME_FLAGS.arrived)
    const slot = show ? this.home.commons!.gates.find((s) => s.gate === g) : undefined
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
    const mx = tileMid(slot.tx)
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
  updateGuide(): void {
    if (!this.guide || !this.home.commons) return
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

  drawLand(): void {
    const d = this.homeDrawn
    this.clear(d)
    const L = this.home.land!
    const home = this.home.here()
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
          .text(sx, sy - 15, this.home.homes.status === 'guest' ? `Wild land\n${lotName(L.gate)}` : `Unclaimed\n${lotName(L.gate)}`, { fontFamily: '"Pixelify Sans", monospace', fontSize: '6px', color: '#ffe9a8', stroke: '#2b1d1a', strokeThickness: 2, align: 'center', lineSpacing: -2, resolution: 10 })
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
    this.drawMailbox(d, home.member && this.home.village.waitingCount() > 0)
    this.drawItems(d, home, 'outdoor', 0, 0, desolate)
  }

  /**
   * The ground past the lamplight sits in shadow: the homestead's land is
   * what its lamps hold. Drawn per tile, just over the ground.
   */
  drawShade(): void {
    const L = this.home.land!
    this.shade?.destroy()
    const home = this.home.here()
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

  lights(home: HomeView, except?: string): Light[] {
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

  mailboxSpot(): { x: number; y: number } {
    const m = this.home.land!.mailbox
    return tileFeet(m.tx, m.ty)
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

  drawRoom(): void {
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
    const home = this.home.here()
    if (home) this.drawItems(d, home, 'indoor', ROOM_GRID.tx * TILE, ROOM_GRID.ty * TILE)
    if (home && home.tier >= 2) {
      // The workshop's chest and bench stand against the back wall, off the floor grid.
      this.add(d, S.add.image(ROOM_CHEST.x, 50, 'workshop-chest').setOrigin(0.5, 1).setDepth(49))
      this.add(d, S.add.image(ROOM_BENCH.x, 52, 'workshop-bench').setOrigin(0.5, 1).setDepth(49))
    }
  }

  // ------------------------------------------------------------ interactions

  /** Where a placed piece stands (px, its footprint's bottom-centre). */
  decoSpot(it: HomeInstance, scene: HomeScene): { x: number; y: number } {
    const def = homeItem(it.itemDef)
    const [fw, fh] = rotatedFootprint(def ?? { footprint: [1, 1] } as HomeItem, it.rotation ?? 0)
    const ox = (scene === 'indoor' ? ROOM_GRID.tx * TILE : 0)
    const oy = (scene === 'indoor' ? ROOM_GRID.ty * TILE : 0)
    return { x: ox + (it.x ?? 0) * TILE + (fw * TILE) / 2, y: oy + ((it.y ?? 0) + fh) * TILE - 4 }
  }

  /** Where the hero sits on a placed seat (src/game/seats.ts): on the art drawn for it. */
  seatPose(it: HomeInstance): SeatPose | null {
    const img = this.homeDrawn.objects.find((o): o is Phaser.GameObjects.Image => o instanceof Phaser.GameObjects.Image && o.getData('instance') === it.id)
    return img ? decoSeat(it.itemDef, this.artBox(img), img.depth) : null
  }

  /** The opaque part of a drawn image, in world px (the texture's alpha, read once per frame name). */
  private artBox(img: Phaser.GameObjects.Image): ArtBox {
    const f = img.frame
    const id = `${img.texture.key}:${f.name}`
    let b = this.opaque.get(id)
    if (!b && densityOf(img.texture) !== 1) {
      // A dense texture (../density.ts): its texels' box, in world px.
      const o = opaqueBox(artSource(this.scene, img.texture.key)!)
      b = o ? { l: o.x, t: o.y, r: o.x + o.w, b: o.y + o.h } : { l: 0, t: 0, r: f.width, b: f.height }
      this.opaque.set(id, b)
    }
    if (!b) {
      b = { l: f.width, t: f.height, r: 0, b: 0 }
      for (let y = 0; y < f.height; y++)
        for (let x = 0; x < f.width; x++) {
          if ((this.scene.textures.getPixelAlpha(x, y, img.texture.key, f.name) ?? 0) === 0) continue
          b = { l: Math.min(b.l, x), t: Math.min(b.t, y), r: Math.max(b.r, x + 1), b: Math.max(b.b, y + 1) }
        }
      if (b.r <= b.l) b = { l: 0, t: 0, r: f.width, b: f.height }
      this.opaque.set(id, b)
    }
    const x0 = img.x - img.displayWidth * img.originX
    const y0 = img.y - img.displayHeight * img.originY
    const [l, r] = img.flipX ? [f.width - b.r, f.width - b.l] : [b.l, b.r]
    return { left: x0 + l * img.scaleX, right: x0 + r * img.scaleX, top: y0 + b.t * img.scaleY, bottom: y0 + b.b * img.scaleY }
  }

}
