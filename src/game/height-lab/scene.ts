/**
 * Height lab (dev only): hand-made areas with real levels and caves, to
 * feel climbing and going underground with no loading door. Started
 * instead of the world with `?lab=height` (../scenes/BootScene.ts); the dev
 * panel's Height lab section opens it, leaves it, picks the area and
 * switches the transitions (./look.ts). Nothing here saves, sends or reads
 * the server.
 *
 * Drawing, back to front, in depth bands:
 *   - the surface's ground, one image a level;
 *   - the cave's ground, one image a floor level: just above the surface's
 *     when you're outside (and hidden), above all the surface's things when
 *     you're inside;
 *   - things (faces, props, people), y-sorted within their layer's band.
 *     The layer you're on draws above the other one, so someone just
 *     inside a mouth shows in the arch but behind its lintel;
 *   - the light (./lighting.ts): one image over the view, multiplied over
 *     everything below it, the place's ambient plus every light source,
 *     shadowed by rock (LightView, below); then the crystals themselves
 *     (lights, so not darkened), then the climbing haze.
 *
 * Fog is by level difference, both ways: the level you stand on is clear,
 * levels above and below fade toward the fog (on the surface) or the dark
 * (underground) with their distance from yours. Ground images fade by
 * alpha toward the camera's background (the fog colour); each thing has a
 * fog twin, the same image filled with the fog colour on top of it.
 */
import Phaser from 'phaser'
import { bus, EV } from '../events'
import { touchVec, uiBlocked, heroScreen } from '../input'
import { canvasRatio, canvasZoomFor } from '../viewport'
import { ensureTangleAtlas } from '../wilds/tangle-art'
import { tangleFrame } from '../wilds/tangle-key'
import { perfSpan, perfWatch } from '../perf'
import { onSceneEnd } from '../scene-end'
import { CAVE, SURFACE, areaLighting, type LabArea } from './area'
import { buildArea } from './areas'
import { FACES_KEY, FACE_TINT, drawFaces, drawGrid, drawOverlays, facePart, paintCave, paintSurface } from './art'
import { KIND, TILE_PX, findPath, move, sample, standTile, zAt, type Node, type Walker } from './levels'
import { FRIEND_LIGHT, HERO_LIGHT, LIGHT_RES, caveView } from './light'
import type { Lighting } from './lighting'
import { fogFor, labLook, onLabLook, setLabLook, type LabLook } from './look'

const T = TILE_PX
const DECOR_ATLAS = 'wilds-decor-outer-Carting'

/** Depth bands (y-sorted inside each). */
const BAND = { ground: -1_000_000, caveGroundOut: -900_000, gridOut: -890_000, caveOut: -500_000, caveGroundIn: 500_000, gridIn: 510_000, caveIn: 600_000, dark: 900_000, glow: 910_000, haze: 950_000 }

const FOG_COLOR: Record<LabLook['fog'], number> = { fog: 0xd4dae0, sky: 0x9ccaf0, none: 0x241f31 }
const CAVE_DARK = 0x07060b

type Shown = Phaser.GameObjects.Image | Phaser.GameObjects.Sprite | Phaser.GameObjects.Text

/** Something drawn on a layer: its parts, a fog twin, where its foot is and how high. */
interface Thing {
  parts: { o: Shown; dz: number; a: number }[]
  twin: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite | null
  layer: number
  x: number
  y: number
  z: number
  /** Seen from the surface while it's in the cave (moving things sample the cave's `seen`). */
  seen: number
}

/** Someone who walks the levels: the hero, the remote player, a creature. */
interface Mover {
  thing: Thing
  walker: Walker
  sprite: Phaser.GameObjects.Sprite
  anim: 'demo' | 'slime' | 'mushroom'
  speed: number
  path: Node[] | null
  /** Seconds to stand still before the next walk. */
  wait: number
  stuck: number
  next: () => Node | null
}

export class HeightLabScene extends Phaser.Scene {
  private area!: LabArea
  private look: LabLook = labLook()
  private things: Thing[] = []
  private movers: Mover[] = []
  private hero!: Mover
  private levelImages: { img: Phaser.GameObjects.Image; level: number }[] = []
  private caveImages: { img: Phaser.GameObjects.Image; level: number }[] = []
  private grids: Phaser.GameObjects.Graphics[] = []
  /** The area's light, and the image that shows it over the view. */
  private lighting!: Lighting
  private lightView!: LightView
  private friend!: Mover
  private heroLight: LabLook['cave'] = 'lantern'
  private haze!: Phaser.GameObjects.Image
  private keys!: { up: Phaser.Input.Keyboard.Key[]; down: Phaser.Input.Keyboard.Key[]; left: Phaser.Input.Keyboard.Key[]; right: Phaser.Input.Keyboard.Key[] }
  private hud: HTMLDivElement | null = null
  private hudAt = 0
  private baseZoom = 3
  /** The last look applied to the still things (layer, view, z, look), so they're redone only when it moves. */
  private stillKey = ''
  private updateMs: number[] = []
  private lightMs: number[] = []
  private buildMs = 0
  private paintMs = 0
  private facing = 'down'

  constructor() {
    super('HeightLab')
  }

  create(): void {
    const t0 = performance.now()
    perfWatch(this)
    // A restart (another area, or other daylight) runs create again on this instance.
    this.things = []
    this.movers = []
    this.levelImages = []
    this.caveImages = []
    this.grids = []
    this.stillKey = ''
    this.updateMs = []
    this.lightMs = []
    this.look = labLook()
    const endBuild = perfSpan('lab:build')
    this.area = buildArea(this.look.area, { skyTiles: this.look.skyTiles })
    drawFaces(this)
    drawOverlays(this)
    ensureTangleAtlas(this, DECOR_ATLAS)
    this.buildGround()
    this.buildFaces()
    this.buildProps()
    this.buildCave()
    this.buildMovers()
    this.buildOverlays()
    endBuild()
    this.buildMs = performance.now() - t0

    const cam = this.cameras.main
    cam.setBounds(0, 0, this.area.stack.w * T, this.area.stack.h * T)
    cam.startFollow(this.hero.sprite, true, 0.12, 0.12, 0, 8)
    this.fitZoom()
    cam.setZoom(this.baseZoom)
    const onResize = () => this.fitZoom()
    this.scale.on('resize', onResize)

    const kb = this.input.keyboard!
    const k = (code: number) => kb.addKey(code, false)
    const C = Phaser.Input.Keyboard.KeyCodes
    this.keys = { up: [k(C.UP), k(C.W)], down: [k(C.DOWN), k(C.S)], left: [k(C.LEFT), k(C.A)], right: [k(C.RIGHT), k(C.D)] }

    let restarting = false
    const stopLook = onLabLook((l) => {
      const rebuild = l.area !== this.look.area || l.skyTiles !== this.look.skyTiles
      this.look = l
      this.stillKey = ''
      if (rebuild && !restarting) {
        restarting = true
        this.scene.restart()
      }
    })
    this.buildHud()
    onSceneEnd(this, () => {
      stopLook()
      this.scale.off('resize', onResize)
      this.hud?.remove()
      this.hud = null
      perfWatch(null)
      this.lightView.destroy()
      labHook(null)
    })
    labHook(this)
    cam.fadeIn(400, 12, 12, 20)
    bus.emit(EV.worldShown)
  }

  private fitZoom(): void {
    this.baseZoom = canvasZoomFor(this.scale.width, this.scale.height)
  }

  // ---------------------------------------------------------------- build

  private buildGround(): void {
    const t0 = performance.now()
    const end = perfSpan('lab:paint-surface')
    for (const li of paintSurface(this, this.area)) {
      const img = this.add.image(li.x, li.y, li.key).setOrigin(0).setDepth(BAND.ground + li.level)
      this.levelImages.push({ img, level: li.level })
    }
    end()
    this.paintMs = performance.now() - t0
  }

  private addThing(t: Omit<Thing, 'twin'>, twin: boolean): Thing {
    let tw: Thing['twin'] = null
    const main = t.parts[0]!.o
    if (twin && !(main instanceof Phaser.GameObjects.Text)) {
      tw =
        main instanceof Phaser.GameObjects.Sprite
          ? this.add.sprite(main.x, main.y, main.texture.key, main.frame.name)
          : this.add.image(main.x, main.y, main.texture.key, main.frame.name)
      tw.setOrigin(main.originX, main.originY).setScale(main.scaleX, main.scaleY).setTintFill(0xffffff).setAlpha(0)
    }
    const thing = { ...t, twin: tw }
    this.things.push(thing)
    return thing
  }

  private buildFaces(): void {
    const l = this.area.stack.layers[SURFACE]!
    const isFace = (tx: number, ty: number) => tx >= 0 && tx < l.w && (l.kind[ty * l.w + tx] === KIND.face || l.kind[ty * l.w + tx] === KIND.mouth)
    for (let ty = 0; ty < l.h; ty++)
      for (let tx = 0; tx < l.w; tx++) {
        const i = ty * l.w + tx
        if (l.kind[i] !== KIND.face) continue
        const rows = l.faceRows[i]!
        const row = l.faceRow[i]!
        const mouth = this.area.mouths.find((m) => m.lintel === ty && tx >= m.x0 && tx <= m.x1)
        const end = isFace(tx + 1, ty) ? (isFace(tx - 1, ty) ? '' : '-w') : '-e'
        const v = (tx * 7 + ty * 3) & 3
        const frame = mouth ? (tx === mouth.x0 ? 'lintel-w' : 'lintel-e') : `face-${facePart(row, rows)}-${v}${end}`
        const img = this.add.image(tx * T, ty * T, FACES_KEY, frame).setOrigin(0).setTint(FACE_TINT[l.faceTop[i]!] ?? 0xffffff)
        // Drawn by its own row's foot, so someone on a trail leg below it stands in front.
        const z = l.faceTop[i]! - (row + 0.5) / rows
        this.addThing({ parts: [{ o: img, dz: 0, a: 1 }], layer: SURFACE, x: img.x + 8, y: (ty + 1) * T, z, seen: 1 }, true)
      }
  }

  private buildProps(): void {
    const tex = this.textures.get(DECOR_ATLAS)
    for (const p of this.area.props) {
      const frame = tangleFrame(p.kind, p.variant)
      if (!tex.has(frame)) continue
      const x = p.tx * T + 8
      const y = (p.ty + 1) * T
      const img = this.add.image(x, y, DECOR_ATLAS, frame).setOrigin(0.5, 1)
      this.addThing({ parts: [{ o: img, dz: 0, a: 1 }], layer: SURFACE, x, y, z: this.area.top[p.ty * this.area.stack.w + p.tx]!, seen: 1 }, true)
    }
  }

  private buildCave(): void {
    const end = perfSpan('lab:paint-cave')
    for (const ci of paintCave(this, this.area)) this.caveImages.push({ img: this.add.image(ci.x, ci.y, ci.key).setOrigin(0).setAlpha(0), level: ci.level })
    end()
    for (const g of this.area.glows) {
      const x = g.tx * T + 8
      const y = (g.ty + 1) * T - 2
      const crystal = this.add.image(x, y, 'hl-crystal').setOrigin(0.5, 1).setTint(g.color)
      // The crystal stands above the light: it's a light itself, so it
      // shows from any floor (no fog twin). Its light on the floor round
      // it is the lighting's (./light.ts crystalLight).
      this.addThing({ parts: [{ o: crystal, dz: BAND.glow - BAND.caveIn, a: 1 }], layer: CAVE, x, y, z: g.z, seen: 0 }, false)
    }
    // The level overlays, built once.
    for (const li of [SURFACE, CAVE]) {
      const g = this.add.graphics()
      drawGrid(g, this.area.stack.layers[li]!, this.area)
      this.grids.push(g)
    }
  }

  private mover(node: Node, anim: Mover['anim'], speed: number, tint: number | null, label: string | null, next: () => Node | null): Mover {
    const x = node.tx * T + 8
    const y = node.ty * T + 12
    let sprite: Phaser.GameObjects.Sprite
    if (anim === 'demo') {
      const tex = this.textures.get('fingersnap-demo-walk')
      const f = tex.has('walk-down-0') ? tex.get('walk-down-0') : null
      sprite = this.add.sprite(x, y, f ? 'fingersnap-demo-walk' : 'hero0', f ? 'walk-down-0' : undefined).setOrigin(0.5, 1)
      if (f) sprite.setScale(20 / f.height)
    } else {
      const frame = `${anim}-idle`
      const ok = this.textures.get('fingersnap-enemies').has(frame)
      sprite = this.add.sprite(x, y, ok ? 'fingersnap-enemies' : 'px', ok ? frame : undefined).setOrigin(0.5, 1)
      if (ok) sprite.setScale(14 / sprite.frame.height)
      if (this.anims.exists(frame)) sprite.play(frame)
    }
    if (tint !== null) sprite.setTint(tint)
    const shadow = this.add.image(x, y - 1, 'shadow')
    const parts: Thing['parts'] = [{ o: sprite, dz: 0, a: 1 }, { o: shadow, dz: -1, a: 0.5 }]
    if (label) {
      const text = this.add.text(x, y - 24, label, { fontFamily: '"Pixelify Sans", monospace', fontSize: '8px', color: '#fff6e0', stroke: '#2a2030', strokeThickness: 2 }).setOrigin(0.5, 1).setResolution(4)
      parts.push({ o: text, dz: 3000, a: 1 })
    }
    // A twin on either layer: movers cross between them.
    const thing = this.addThing({ parts, layer: node.layer, x, y, z: 0, seen: 1 }, true)
    const m: Mover = { thing, walker: { x, y, layer: node.layer, hw: 5, fh: 4 }, sprite, anim, speed, path: null, wait: 0, stuck: 0, next }
    this.movers.push(m)
    return m
  }

  private buildMovers(): void {
    const a = this.area
    this.hero = this.mover(a.spawn, 'demo', 110, null, null, () => null)
    // The remote player walks the area's loop (./area.ts, ./mountain.ts).
    let leg = 0
    this.friend = this.mover(a.route[0]!, 'demo', 72, 0xffc6a0, 'Wren', () => {
      leg = (leg + 1) % a.route.length
      return a.route[leg]!
    })
    for (const h of a.homes) {
      const home = h
      this.mover({ layer: home.layer, tx: home.tx, ty: home.ty }, home.art, 26, null, null, () => {
        for (let i = 0; i < 20; i++) {
          const n = { layer: home.layer, tx: home.tx + Math.round((Math.random() - 0.5) * 10), ty: home.ty + Math.round((Math.random() - 0.5) * 8) }
          const l = a.stack.layers[n.layer]!
          if (n.tx < 0 || n.ty < 0 || n.tx >= l.w || n.ty >= l.h) continue
          const k = l.kind[n.ty * l.w + n.tx]
          if (k === KIND.flat || k === KIND.slope) return n
        }
        return null
      })
    }
  }

  private buildOverlays(): void {
    const endLight = perfSpan('lab:light')
    this.lighting = areaLighting(this.area)
    // The two moving lights: the hero's own, and Wren's lantern.
    this.heroLight = this.look.cave
    for (const [id, m, kind] of [['hero', this.hero, HERO_LIGHT[this.look.cave]], ['friend', this.friend, FRIEND_LIGHT]] as const) {
      const w = m.walker
      this.lighting.add({ id, x: w.x, y: w.y - 10, layer: w.layer, z: m.thing.z, ...kind, moving: true })
    }
    endLight()
    this.lightView = new LightView(this, BAND.dark)
    this.haze = this.add.image(0, 0, 'hl-haze').setDepth(BAND.haze).setAlpha(0)
  }

  private buildHud(): void {
    const parent = this.game.canvas.parentElement
    if (!parent) return
    const d = document.createElement('div')
    d.dataset.testid = 'height-lab-hud'
    d.style.cssText =
      'position:absolute;left:50%;top:max(8px, env(safe-area-inset-top));transform:translateX(-50%);z-index:5;pointer-events:none;' +
      'padding:4px 12px;border-radius:999px;background:rgba(20,16,28,.72);color:#fff3d6;font:600 12px/1.35 system-ui,sans-serif;text-align:center;white-space:pre'
    parent.appendChild(d)
    this.hud = d
  }

  // ---------------------------------------------------------------- every frame

  update(_time: number, deltaMs: number): void {
    const t0 = performance.now()
    const dt = Math.min(0.05, deltaMs / 1000)
    this.steerHero(dt)
    for (const m of this.movers) if (m !== this.hero) this.walkOn(m, dt)
    for (const m of this.movers) this.place(m)
    this.applyLook(dt)
    const ms = performance.now() - t0
    this.updateMs.push(ms)
    if (this.updateMs.length > 120) this.updateMs.shift()
    this.updateHud()
  }

  private steerHero(dt: number): void {
    const h = this.hero
    let dx = touchVec.x
    let dy = touchVec.y
    const down = (ks: Phaser.Input.Keyboard.Key[]) => ks.some((k) => k.isDown)
    if (down(this.keys.left)) dx -= 1
    if (down(this.keys.right)) dx += 1
    if (down(this.keys.up)) dy -= 1
    if (down(this.keys.down)) dy += 1
    if (uiBlocked()) dx = dy = 0
    const len = Math.hypot(dx, dy)
    if (len > 0.1) {
      dx /= Math.max(1, len)
      dy /= Math.max(1, len)
      const [tx, ty] = standTile(h.walker)
      const l = this.area.stack.layers[h.walker.layer]!
      // A little slower on a slope.
      const slow = l.kind[ty * l.w + tx] === KIND.slope ? 0.8 : 1
      move(this.area.stack, h.walker, dx * h.speed * slow * dt, dy * h.speed * slow * dt)
      this.facing = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down'
      this.animate(h, true)
    } else this.animate(h, false)
  }

  private animate(m: Mover, walking: boolean, facing = this.facing): void {
    if (m.anim !== 'demo') return
    const key = `demo-walk-${facing}`
    if (walking && this.anims.exists(key)) {
      if (m.sprite.anims.currentAnim?.key !== key || !m.sprite.anims.isPlaying) m.sprite.play(key, true)
    } else m.sprite.anims.stop()
  }

  /** A walker on its path: toward the next tile's middle; a new path when it ends or sticks. */
  private walkOn(m: Mover, dt: number): void {
    if (m.wait > 0) {
      m.wait -= dt
      this.animate(m, false)
      return
    }
    if (!m.path || !m.path.length) {
      const [tx, ty] = standTile(m.walker)
      const goal = m.next()
      m.path = goal ? findPath(this.area.stack, { layer: m.walker.layer, tx, ty }, goal, 12000) : null
      m.path?.shift()
      if (!m.path) m.wait = 1
      return
    }
    const n = m.path[0]!
    const gx = n.tx * T + 8
    const gy = n.ty * T + 10
    const vx = gx - m.walker.x
    const vy = gy - m.walker.y
    const d = Math.hypot(vx, vy)
    if (d < 1.5) {
      m.path.shift()
      if (!m.path.length) m.wait = m.anim === 'demo' ? 1.6 : 1 + Math.random() * 2.5
      return
    }
    const s = Math.min(d, m.speed * dt)
    const before = m.walker.x + m.walker.y
    move(this.area.stack, m.walker, (vx / d) * s, (vy / d) * s)
    if (Math.abs(m.walker.x + m.walker.y - before) < 0.01) m.stuck += dt
    else m.stuck = 0
    if (m.stuck > 0.6) {
      m.path = null
      m.stuck = 0
    }
    this.animate(m, true, Math.abs(vx) >= Math.abs(vy) ? (vx < 0 ? 'left' : 'right') : vy < 0 ? 'up' : 'down')
    if (m.anim !== 'demo' && Math.abs(vx) > 0.2) m.sprite.setFlipX(vx < 0)
  }

  /** A mover's parts follow its walker. */
  private place(m: Mover): void {
    const w = m.walker
    const t = m.thing
    t.x = w.x
    t.y = w.y
    t.layer = w.layer
    const z = zAt(this.area.stack, w)
    if (!Number.isNaN(z)) t.z = z
    t.seen = w.layer === CAVE ? sample(this.area.stack.layers[CAVE]!, this.area.stack.layers[CAVE]!.seen, w.x, w.y - 2) : 1
    m.sprite.setPosition(w.x, w.y)
    t.parts[1]!.o.setPosition(w.x, w.y - 1)
    t.parts[2]?.o.setPosition(w.x, w.y - 23)
    if (t.twin) {
      t.twin.setPosition(w.x, w.y).setFlipX(m.sprite.flipX)
      t.twin.setFrame(m.sprite.frame.name)
    }
  }

  /** What the hero sees from where they stand: their layer and height, the daylight there, and how far into the cave's view they are. */
  private view(): { layer: number; z: number; sky: number; cave: number } {
    const w = this.hero.walker
    const cave = this.area.stack.layers[CAVE]!
    if (w.layer !== CAVE) return { layer: w.layer, z: this.hero.thing.z, sky: 1, cave: 0 }
    const walked = sample(cave, this.area.walk, w.x, w.y - 2)
    return { layer: w.layer, z: this.hero.thing.z, sky: sample(cave, cave.sky, w.x, w.y - 2), cave: caveView(walked, this.look.crossfade) }
  }

  private fogOf(viewZ: number, z: number): number {
    return this.look.fog === 'none' ? 0 : fogFor(z - viewZ, this.look.fogStrength)
  }

  private depthOf(viewZ: number, z: number): number {
    return this.look.depth === 'none' ? 0 : fogFor(z - viewZ, this.look.fogStrength)
  }

  private applyLook(dt: number): void {
    const v = this.view()
    const look = this.look
    const inCave = v.layer === CAVE
    const fogColor = FOG_COLOR[look.fog]
    const cam = this.cameras.main
    // The background is what faded land fades to: fog outside, dark below.
    const bg = Phaser.Display.Color.Interpolate.ColorWithColor(Phaser.Display.Color.ValueToColor(fogColor), Phaser.Display.Color.ValueToColor(CAVE_DARK), 100, Math.round(v.cave * 100))
    cam.setBackgroundColor(Phaser.Display.Color.GetColor(bg.r, bg.g, bg.b))
    // The surface fades as daylight goes (the crossfade the owner liked);
    // the cave's floors come in over the first steps inside.
    // The surface stays drawn: in the cave's view the light decides what
    // of it shows (open air lit, the hill over you dark).
    for (const li of this.levelImages) li.img.setAlpha(inCave ? 1 : 1 - this.fogOf(v.z, li.level))
    for (const ci of this.caveImages)
      ci.img.setDepth((inCave ? BAND.caveGroundIn : BAND.caveGroundOut) + ci.level).setAlpha(inCave ? v.cave * (1 - this.depthOf(v.z, ci.level)) : 0)
    this.grids[0]!.setVisible(look.grid).setDepth(BAND.gridOut)
    this.grids[1]!.setVisible(look.grid && inCave).setDepth(BAND.gridIn)

    // Things: moving ones every frame, still ones when the view has moved.
    const key = `${v.layer}:${v.sky.toFixed(2)}:${v.cave.toFixed(2)}:${v.z.toFixed(2)}:${look.fog}:${look.fogStrength}:${look.depth}`
    const still = key !== this.stillKey
    this.stillKey = key
    const moving = new Set(this.movers.map((m) => m.thing))
    for (const t of this.things) {
      if (!still && !moving.has(t)) continue
      const onCave = t.layer === CAVE
      const band = onCave ? (inCave ? BAND.caveIn : BAND.caveOut) : 0
      const vis = onCave ? (inCave ? 1 : t.seen) : 1
      for (const p of t.parts) p.o.setDepth(band + t.y + p.dz).setAlpha(vis * p.a).setVisible(vis * p.a > 0.01)
      if (t.twin) {
        // Surface things fade toward the fog seen from the surface; cave
        // things toward the dark seen from the cave; across layers, not at all.
        const fog = !onCave && !inCave ? this.fogOf(v.z, t.z) : onCave && inCave ? this.depthOf(v.z, t.z) : 0
        t.twin
          .setDepth(band + t.y + t.parts[0]!.dz + 0.5)
          .setTintFill(onCave ? CAVE_DARK : fogColor)
          .setAlpha(vis * fog)
          .setVisible(vis * fog > 0.01)
      }
    }
    const hx = this.hero.walker.x
    const wv = cam.worldView
    this.drawLight(v.cave, wv)

    // Climbing: haze at the screen's edges, and the camera eases out.
    const high = inCave ? 0 : Math.max(0, Math.min(1, v.z / 2))
    const hazeColor = look.fog === 'none' ? FOG_COLOR.fog : fogColor
    this.haze
      .setVisible(look.haze && high > 0.01)
      .setTint(hazeColor)
      .setAlpha(high * 0.6)
      .setPosition(wv.centerX, wv.centerY)
      .setDisplaySize(wv.width * 1.25, wv.height * 1.25)
    const target = this.baseZoom * (look.zoom && !inCave ? 1 - 0.07 * Math.min(3, Math.max(0, v.z)) : 1)
    if (Math.abs(cam.zoom - target) > 0.001) cam.setZoom(cam.zoom + (target - cam.zoom) * Math.min(1, dt * 3))

    // Where the hero stands on screen, for hold-to-walk (CSS px).
    const r = canvasRatio()
    heroScreen.x = ((hx - wv.x) * cam.zoom) / r
    heroScreen.y = ((this.hero.walker.y - wv.y) * cam.zoom) / r
  }

  /**
   * The light over the view: the moving lights moved, then the cave's
   * light (weight: how far into the cave's view the hero is) over the
   * surface's. On the surface in daylight there's nothing to draw.
   */
  private drawLight(view: number, wv: Phaser.Geom.Rectangle): void {
    const t0 = performance.now()
    if (this.look.cave !== this.heroLight) {
      this.heroLight = this.look.cave
      this.lighting.set('hero', HERO_LIGHT[this.look.cave])
    }
    for (const [id, m] of [['hero', this.hero], ['friend', this.friend]] as const) this.lighting.move(id, m.walker.x, m.walker.y - 10, m.walker.layer, Math.round(m.thing.z))
    if (view <= 0.001) {
      this.lightView.hide()
      return
    }
    this.lightView.draw(this.lighting, wv, [
      { layer: CAVE, weight: view },
      { layer: SURFACE, weight: 1 - view }
    ])
    this.lightMs.push(performance.now() - t0)
    if (this.lightMs.length > 120) this.lightMs.shift()
  }

  /** The light at the hero (0–1), as shown: the cave's over the surface's. */
  lightAtHero(): number {
    const v = this.view()
    const w = this.hero.walker
    return v.cave * this.lighting.level(CAVE, w.x, w.y - 10) + (1 - v.cave) * this.lighting.level(SURFACE, w.x, w.y - 10)
  }

  /** For the screenshot spec (dev only): put the hero on a tile, the camera with them. */
  put(layer: number, tx: number, ty: number): void {
    const w = this.hero.walker
    w.layer = layer
    w.x = tx * T + 8
    w.y = ty * T + 12
    this.place(this.hero)
    this.cameras.main.centerOn(w.x, w.y - 8)
    this.stillKey = ''
  }

  /** The lab's state, for the screenshot spec. */
  state(): { area: string; look: LabLook; layer: number; z: number; sky: number; cave: number; light: number; lightMs: number } {
    const v = this.view()
    const avg = this.lightMs.reduce((a, b) => a + b, 0) / Math.max(1, this.lightMs.length)
    return { area: this.look.area, look: this.look, ...v, light: this.lightAtHero(), lightMs: avg }
  }

  private updateHud(): void {
    const now = performance.now()
    if (!this.hud || now - this.hudAt < 250) return
    this.hudAt = now
    const v = this.view()
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
    const here = this.lightAtHero()
    const where =
      v.layer === CAVE
        ? `In the cave · floor ${Math.round(v.z)} · daylight ${Math.round(v.sky * 100)}% · light here ${Math.round(here * 100)}%`
        : `Surface · level ${v.z.toFixed(2)}`
    const dark = this.lightMs.length ? ` (light ${avg(this.lightMs).toFixed(2)})` : ''
    this.hud.textContent = `Height lab, ${this.area.name} — ${where}\nlab update ${avg(this.updateMs).toFixed(2)} ms${dark} · ${this.children.length} objects · built in ${Math.round(this.buildMs)} ms (ground ${Math.round(this.paintMs)})`
  }
}

/**
 * The light's one image over the view (dev only, like the lab): a canvas
 * texture a texel a LIGHT_RES world px, filled from the lighting each
 * frame, linear-filtered, texel-aligned to the world (so it never swims),
 * drawn once with MULTIPLY over everything below it. No render texture,
 * no shader: the same in WebGL and Canvas.
 */
class LightView {
  private static readonly KEY = 'hl-light'
  private tex: Phaser.Textures.CanvasTexture | null = null
  private img: Phaser.GameObjects.Image
  private data: ImageData | null = null

  constructor(
    private scene: Phaser.Scene,
    depth: number
  ) {
    this.img = scene.add.image(0, 0, '__WHITE').setOrigin(0).setDepth(depth).setBlendMode(Phaser.BlendModes.MULTIPLY).setVisible(false)
  }

  draw(lights: Lighting, wv: Phaser.Geom.Rectangle, views: { layer: number; weight: number }[]): void {
    const R = LIGHT_RES
    const x0 = Math.floor(wv.x / R) - 1
    const y0 = Math.floor(wv.y / R) - 1
    const w = Math.ceil(wv.width / R) + 3
    const h = Math.ceil(wv.height / R) + 3
    if (!this.tex || this.tex.width < w || this.tex.height < h) this.make(Math.max(w, this.tex?.width ?? 0), Math.max(h, this.tex?.height ?? 0))
    const tex = this.tex!
    lights.fill({ x0, y0, w: tex.width, h: tex.height }, this.data!.data, views)
    tex.context.putImageData(this.data!, 0, 0)
    tex.refresh()
    this.img.setPosition(x0 * R, y0 * R).setVisible(true)
  }

  hide(): void {
    this.img.setVisible(false)
  }

  destroy(): void {
    this.img.destroy()
    if (this.scene.textures.exists(LightView.KEY)) this.scene.textures.remove(LightView.KEY)
    this.tex = null
  }

  private make(w: number, h: number): void {
    const textures = this.scene.textures
    if (textures.exists(LightView.KEY)) textures.remove(LightView.KEY)
    this.tex = textures.createCanvas(LightView.KEY, w, h)!
    this.tex.setFilter(Phaser.Textures.FilterMode.LINEAR)
    this.data = this.tex.context.createImageData(w, h)
    this.img.setTexture(LightView.KEY).setScale(LIGHT_RES)
  }
}

/** The lab's hook for the screenshot spec (e2e/height-lab-screens.spec.ts): put the hero somewhere, read the state. */
function labHook(scene: HeightLabScene | null): void {
  const w = window as unknown as { __fsLab?: unknown }
  if (!scene) {
    delete w.__fsLab
    return
  }
  w.__fsLab = {
    put: (layer: number, tx: number, ty: number) => scene.put(layer, tx, ty),
    look: (change: Partial<LabLook>) => setLabLook(change),
    state: () => scene.state()
  }
}
