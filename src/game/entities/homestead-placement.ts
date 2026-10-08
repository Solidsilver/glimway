/**
 * Homesteads, arranged: placement mode for a member on their own land or in
 * their cottage. The tray (src/ui/HomeBar.svelte) and the keys move, turn,
 * set down and pick up pieces on the grid (lit, open ground outdoors), and
 * a clearable tile can be cleared with Silas's saw.
 */
import Phaser from 'phaser'
import { HOMESTEAD_DATA, canRotate, checkPlacement, checkRemoval, homeItem, rotatedFootprint, type HomeInstance, type HomeScene, type PlacementGround, type Rotation } from '../../lib/homestead'
import { LAND, buildableKind, clearable, clearedSet, effectiveKind, isLit } from '../../lib/homestead-land'
import { bus, EV } from '../events'
import { touchVec, uiBlocked, uiState } from '../input'
import { sfx } from '../sfx'
import { TILE, tileBottom, tileMid } from '../../lib/tile'
import { decoKey } from '../commons-art'
import { itemsFrame, itemWorldArt } from '../items-pass'
import { ROOM_GRID } from '../cottage'
import { itemName, type ArrangeView, type PlacementCommand, type PlacementView } from '../homestead'
import { homeErrorText } from '../../content/errors'
import type { HomesteadDeps, HomesteadLayer } from './homesteads'
import { POST } from './homestead-art'

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


export class HomesteadArranging {
  private readonly scene: Phaser.Scene
  private readonly deps: HomesteadDeps

  placement: Placement | null = null
  private arrange: ArrangeView = { available: false, scene: null, tier: 0 }
  private arrangeTimer = 0
  /** The tray's last view (playtests read the piece's spot from it). */
  placementView: PlacementView | null = null

  constructor(private readonly home: HomesteadLayer) {
    this.scene = home.scene
    this.deps = home.deps
  }

  // ------------------------------------------------------------ arranging

  /** A few times a second: is the hero somewhere they may arrange their own place? */
  update(dt: number): void {
    this.arrangeTimer -= dt
    if (this.arrangeTimer > 0) return
    this.arrangeTimer = 0.25
    const home = this.home.here()
    let next: ArrangeView = { available: false, scene: null, tier: home?.tier ?? 0 }
    if (home?.member && !this.placement) {
      if (this.deps.room) next = { available: true, scene: 'indoor', tier: home.tier }
      else if (this.home.land) next = { available: true, scene: 'outdoor', tier: home.tier }
    }
    if (next.available !== this.arrange.available || next.scene !== this.arrange.scene || next.tier !== this.arrange.tier) this.emitArrange(next)
  }

  emitArrange(v: ArrangeView): void {
    this.arrange = v
    bus.emit(EV.homeArrange, v)
  }

  private ground(): PlacementGround | undefined {
    const h = this.home.here()
    return this.home.land && h ? { land: this.home.land.land, cleared: clearedSet(h.cleared) } : undefined
  }

  startPlacement(): void {
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
      if (!this.home.land) return
      cols = this.home.land.width
      rows = this.home.land.height
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
    // Keys come from the DOM, not Phaser's keyboard queue: that queue is
    // wiped every POST_STEP (a press arriving while the scene can't take
    // input is lost) and a keydown whose key is still down is filtered as a
    // repeat, so one lost keyup turned every later press of that arrow into
    // a silent no-op. An OS auto-repeat is still one nudge per press.
    window.addEventListener('keydown', this.onKey)
    this.scene.input.on('pointerdown', this.onPointer, this)
    this.scene.scale.on('resize', this.reframe, this)
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

  endPlacement(animate = true): void {
    const p = this.placement
    if (!p) return
    p.overlay.destroy()
    p.ghost?.destroy()
    this.placement = null
    window.removeEventListener('keydown', this.onKey)
    this.scene.input.off('pointerdown', this.onPointer, this)
    this.scene.scale.off('resize', this.reframe, this)
    bus.emit(EV.homePlacement, null)
    if (animate) {
      const cam = this.scene.cameras.main
      cam.startFollow(this.deps.hero(), true, 0.12, 0.12)
      // A short grace so the key that closed the tray doesn't swing a sword.
      uiState.blockedUntil = performance.now() + 220
    }
    this.arrangeTimer = 0
  }

  /** The placement's own keys (bound once, so add/removeEventListener match). */
  private readonly onKey = (e: KeyboardEvent): void => {
    const p = this.placement
    if (!p) return
    // A modal, dialogue or lease gate owns input: placement waits. A key the
    // interface already handled (Escape closing a panel) is not ours too.
    if (e.repeat || uiBlocked() || (e as KeyboardEvent & { fsConsumed?: boolean }).fsConsumed) return
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

  onPointer(pointer: Phaser.Input.Pointer): void {
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
      const home = this.home.here()
      if (p.scene === 'outdoor' && g && home && clearable(effectiveKind(g.land, g.cleared, gx, gy)) && isLit(this.home.art.lights(home), gx, gy)) {
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
    return this.home.here()?.items.find((i) => i.id === id)
  }

  private instanceAt(scene: HomeScene, gx: number, gy: number): HomeInstance | undefined {
    return this.home.here()?.items.find((i) => {
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
    const home = this.home.here()!
    const hero = this.deps.hero()
    const cx = p.scene === 'outdoor' ? (hero.x - p.ox) / TILE - w / 2 : (p.cols - w) / 2
    const cy = p.scene === 'outdoor' ? (hero.y - p.oy) / TILE - h / 2 - 1 : p.rows - h - 2
    let best = { x: Phaser.Math.Clamp(Math.round(cx), 0, p.cols - w), y: Phaser.Math.Clamp(Math.round(cy), 0, p.rows - h) }
    let bestD = Infinity
    const g = this.ground()
    for (let y = 0; y <= p.rows - h; y++)
      for (let x = 0; x <= p.cols - w; x++) {
        if (checkPlacement({ tier: Math.max(1, home.tier), items: home.items, plants: home.plants }, it, p.scene, x, y, 0, HOMESTEAD_DATA, g)) continue
        const d = Math.hypot(x - cx, (y - cy) * 1.3)
        if (d < bestD) {
          bestD = d
          best = { x, y }
        }
      }
    return best
  }

  command(c: PlacementCommand): void {
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
        bus.off(EV.homeNamed, done)
        resolve(v?.name ?? null)
      }
      bus.on(EV.homeNamed, done)
      // After this key's own default action: the E that set the post down
      // must not land in the name field.
      setTimeout(() =>
        bus.emit(EV.homeNamePrompt, {
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
      const problem = checkPlacement(this.home.here()!, it, p.scene, p.x, p.y, p.rotation, HOMESTEAD_DATA, this.ground())
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
    const r = await this.home.homes.act({ op, itemId: it.id, scene: p.scene, x: p.x, y: p.y, rotation: p.rotation, ...(name ? { name } : {}) })
    if (this.placement !== p) return
    p.busy = false
    if (r.ok) {
      sfx(it.itemDef === POST ? 'lantern' : 'pop')
      this.deps.fx.sparkBurst(p.ox + tileMid(p.x), p.oy + tileMid(p.y), it.itemDef === POST ? 18 : 8)
      p.message = { text: it.itemDef === POST && name ? `“${name}” is lit. The ground in its light is yours.` : `${itemName(it.itemDef)}: ${op === 'move' ? 'moved' : 'set out'}.`, kind: 'ok' }
      p.selected = null
      this.nudgeHeroClear()
      if (it.itemDef === POST) this.home.art.drawShade()
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
    const problem = checkRemoval(this.home.here()!, it)
    if (problem) {
      p.message = { text: homeErrorText(problem), kind: 'error' }
      return this.refreshPlacement()
    }
    p.busy = true
    this.refreshPlacement()
    const r = await this.home.homes.act({ op: 'remove', itemId: it.id })
    if (this.placement !== p) return
    p.busy = false
    p.message = r.ok ? { text: `${itemName(it.itemDef)}: put away.`, kind: 'ok' } : { text: r.text, kind: 'error' }
    if (r.ok) {
      p.selected = null
      if (it.itemDef === POST) this.home.art.drawShade()
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
    const r = await this.home.homes.clear(c.x, c.y)
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
    else if (this.home.land) hero.setPosition((this.home.land.doorstep.tx + 1) * TILE, (this.home.land.doorstep.ty + 1.5) * TILE)
  }

  refreshPlacement(): void {
    const p = this.placement
    if (!p) return
    const home = this.home.here()
    if (!home?.member) return this.endPlacement()
    const g = p.overlay
    g.clear()
    const ground = this.ground()
    const lights = p.scene === 'outdoor' ? this.home.art.lights(home) : []
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
        for (let x = r.x; x < r.x + r.w; x++) g.lineBetween(p.ox + x * TILE + 2, p.oy + tileBottom(y) - 2, p.ox + (x + 1) * TILE - 2, p.oy + y * TILE + 2)
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
    bus.emit(EV.homePlacement, view)
  }
}
