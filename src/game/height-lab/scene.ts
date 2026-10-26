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
 *   - the cave's ground, one opaque image: just above the surface's when
 *     you're outside (and hidden), above all the surface's things when
 *     you're inside, fading in over the first steps in; under it, the
 *     floor under each mouth's arch, always shown (from outside you see
 *     into the mouth, in the cave's light);
 *   - things (faces, props, people), y-sorted within their layer's band.
 *     The layer you're on draws above the other one, so someone just
 *     inside a mouth shows in the arch but behind its lintel;
 *   - the light (./lighting.ts): one image over the view, multiplied over
 *     everything below it, the place's ambient plus every light source,
 *     shadowed by rock (LightView, below); then the crystals themselves
 *     (lights, so not darkened), then the climbing haze.
 *
 * On the surface, fog is by level difference, both ways: the level you
 * stand on is clear, levels above and below fade toward the fog with their
 * distance from yours. Ground images fade by alpha toward the camera's
 * background (the fog colour); each thing has a fog twin, the same image
 * filled with the fog colour on top of it. Underground, levels above and
 * below are darker, never tinted and never see-through: the light does it
 * (./lighting.ts fill's depth), so people on other levels darken too.
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
import { buildWalkArea, loadWalk, resumeAt, walkHere, walkLoaded, type Strategy, type WalkData } from './walk'
import { type CaveImages, FACES_KEY, FACE_TINT, drawFaces, drawGrid, drawOverlays, facePart, paintCave, paintSurface, type PaintPart } from './art'
import { KIND, TILE_PX, findPath, move, sample, standTile, zAt, type Node, type Walker } from './levels'
import { CRAG_KEY, bandImages, drawCrags, paintJob, paintedChunk, slopeDecorAtlas, type PaintJob } from './slopes-art'
import { chunkKey } from './slopes-paint'
import { slopeGait } from '../terrain/slope-gait'
import { clockSun, sunAt, sunShadow, lightTint, shadowOpacity, type DaySun } from '../terrain/sun'
import { fieldLight, sampleSunMap, sampleVisibility, terrainVisibility } from '../terrain/sun-map'
import { castProxy, dither, overShadow, shadeMultiply, shadowDarkness, shadowRay, type Caster, type CasterKind, type ShadowProxy } from '../terrain/sun-shadow'
import { SunChunk, SilhouetteShadow, MoverShadow, frameProxy } from '../terrain/sun-view'
import { serverNow, setGameNow } from '../clock'
import { coverRects, coveredPixels, fieldGradient, fieldZ, FOG_LEVELS, display, lookName, mapPoint, nearestWalkable, slopeWalk, uphillFactor } from './slopes'
import { FRIEND_LIGHT, HERO_LIGHT, LIGHT_RES, wayIn } from './light'
import { caveTint, clearLitScratch, litPixels, pixelSpans, type FillOptions, type Lighting } from './lighting'
import { edgeKey } from '../terrain/edges'
import { SLOPE_KEYS, SLOPE_PRESETS, edgeSettings, fogFor, labLook, onLabLook, setLabLook, slopePresetOf, slopeSettings, slopesLook, styleOf, type LabLook } from './look'

const T = TILE_PX
const DECOR_ATLAS = 'wilds-decor-outer-Carting'

/** Depth bands (y-sorted inside each). */
const BAND = { ground: -1_000_000, caveGroundOut: -900_000, gridOut: -890_000, caveOut: -500_000, caveGroundIn: 500_000, gridIn: 510_000, caveIn: 600_000, dark: 900_000, glow: 910_000, haze: 950_000 }

const FOG_COLOR: Record<LabLook['fog'], number> = { fog: 0xd4dae0, sky: 0x9ccaf0, none: 0x241f31 }
const CAVE_DARK = 0x07060b

type Shown = Phaser.GameObjects.Image | Phaser.GameObjects.Sprite | Phaser.GameObjects.Text

/** What a scene was built with (the switches that rebuild it). */
type Built = Pick<LabLook, 'area' | 'skyTiles' | 'caveStyle' | 'strategy' | 'walkOverlay' | (typeof SLOPE_KEYS)[number]>

/** Tiles, inclusive. */
interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** One built chunk of the generated area: its ground images and their textures, faces and props, levels overlay. */
interface Part {
  cx: number
  cy: number
  images: Phaser.GameObjects.Image[]
  keys: string[]
  things: Thing[]
  grid: Phaser.GameObjects.Graphics
  sunlight?: SunChunk
}

/** The generated area's window, once fetched (kept across restarts: switching strategy is instant), and where to stand after a switch. */
let walkData: WalkData | null = null
let walkResume: { tx: number; ty: number } | null = null
/** The slopes area: where the hero stood (field px) when the style switched: they stand there again (every style walks the field). */
let slopesResume: { x: number; y: number } | null = null

/** The slopes area paints chunks a step at a time; at most this long per frame (one step is always taken). */
const PAINT_BUDGET_MS = 5

/** The strategies, as the HUD and the panel name them. */
const STRATEGY_NAME: Record<Strategy, string> = { region: 'Region plan', chunk: 'Per-chunk repair' }

/** The generated area in the spec's state. */
interface GeneratedState {
  ready: true
  strategy: Strategy
  tile: [number, number]
  here: ReturnType<typeof walkHere>
  spots: { name: string; x: number; y: number; note?: string }[]
  summary: Record<Strategy, { ramps: number; strandedTiles: number; strandedComponents: number; anchors: string; heldExits: string; solveMs: number }>
  parts: number
  things: number
}

/** The slopes area in the spec's state. */
interface SlopesState {
  /** How it's drawn: the settings, the preset they are (if one), round 1's style they are (if one). */
  look: { facing: string; contours: string; terraces: boolean; lift: number }
  preset: string | null
  style: string | null
  lift: boolean
  /** The uphill slowdown: on or off, and where the hero last walked: the gradient (levels a tile), its uphill part, the speed multiplier. */
  gentle: boolean
  sunlight?: { tint: number; shadow: ReturnType<typeof sunShadow>; gait: ReturnType<typeof slopeGait> | null; direction: readonly number[]; time: number; daylight: number; visibility: number; opacity: number
    /** 2d: the shadow mode, the hero's ray (ground px a unit of height), the still shadow at their feet, their cast's box and footprint, and still casters nearby. */
    mode: string; ray: readonly number[]; under: number; cast: { x0: number; y0: number; w: number; h: number; foot: number[] }
    casters: { x: number; y: number; kind: string; foot: number[]; height: number; v: readonly number[]; visible: number }[] }
  sunMap: { pending: number; revision: string; chunks: number; costs: number[]; albedoPaints: number }
  uphill: { gx: number; gy: number; up: number; k: number } | null
  /** The hero's field tile and px (the same in every style), and where they're drawn. */
  tile: [number, number]
  at: [number, number]
  shown: [number, number]
  silhouette: boolean
  /** 2e: the hero's sprite box (world px), how many of its pixels nearer ground covers (drawn as the outline), and its first covered row from the top (-1: none). */
  cover: { box: [number, number, number, number]; covered: number; total: number; spriteCovered: number; spriteTotal: number; top: number }
  /** 2e: edge shading's settings, and edges found in the chunks built so far. */
  edges: { settings: ReturnType<typeof edgeSettings>; chunks: number; edges: number }
  kind: number
  /** What's drawn, in tiles (the lift's view is taller). */
  size: [number, number]
  /** Chunks still being painted, and the paint and update times per frame (ms). */
  pending: number
  slow: { ms: number; paint: number; upload: number; parts: number }[]
  paint: { frames: number; p50: number; p95: number; max: number }
  upload: { frames: number; p50: number; p95: number; max: number }
  update: { frames: number; p50: number; p95: number; max: number }
  spots: { name: string; x: number; y: number; fx: number; fy: number; note: string; look: [number, number] | null }[]
  parts: number
}

/** A 1×1 clear texture. */
function addBlank(scene: Phaser.Scene, key: string): void {
  const c = document.createElement('canvas')
  c.width = 1
  c.height = 1
  scene.textures.addCanvas(key, c)
}

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
  /** A light itself (a crystal): drawn over the light, never lit. */
  glows?: boolean
  /** Its own tint (Wren's), kept under the light's while it's lit by tint (the crossfade). */
  tint?: number
  tinted?: boolean
  /** The slopes area's lift: behind higher ground (./slopes.ts display). The hero is drawn as a silhouette; others not at all. */
  hidden?: boolean
  silhouette?: boolean
  sun?: { x: number; y: number; height: number; shadow: SilhouetteShadow; kind: CasterKind; cast?: MoverShadow; proxy?: ShadowProxy }
}

/** What each lab prop stands on and casts as (slopes 2d). */
const CASTER_KIND: Record<string, CasterKind> = { oak: 'tree', pine: 'tree', birch: 'tree', boulder: 'rock', crag: 'rock', fern: 'plant' }
/** A still caster's fixed part: its frame's foot (display px), field point and slope. */
interface StillCaster { x: number; y: number; fx: number; fy: number; gx: number; gy: number; z: number; proxy: ShadowProxy }

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
  previous?: [number, number]
  scuffPx?: number
  gait?: ReturnType<typeof slopeGait>
}

export class HeightLabScene extends Phaser.Scene {
  private area!: LabArea
  private look: LabLook = labLook()
  /** What this scene was built with (the switches that rebuild it), for the screenshot spec. */
  private built: Built = { area: 'shoulder', skyTiles: 6, caveStyle: 'mixed', strategy: 'region', walkOverlay: false, ...SLOPE_PRESETS.baseline.look }
  private things: Thing[] = []
  private movers: Mover[] = []
  private hero!: Mover
  private levelImages: { img: Phaser.GameObjects.Image; level: number }[] = []
  private caveImage: Phaser.GameObjects.Image | null = null
  /** The floor under each mouth's arch: always shown, so you see into a mouth from outside. */
  private mouthImages: Phaser.GameObjects.Image[] = []
  private grids: Phaser.GameObjects.Graphics[] = []
  /** The area's light, and the image that shows it over the view. */
  private lighting!: Lighting
  private lightView!: LightView
  /**
   * The ways in: the cave's floors times the cave's own light, as one image
   * drawn over the lit surface at the floors' alpha (or inside the iris's
   * soft circle): a true crossfade, so the cave never shows lit by daylight,
   * nor the hill dark over the cave's shape.
   */
  private caveSpans = new Int32Array(0)
  private caveLightBuf = new Uint8ClampedArray(0)
  private crossfade: Phaser.GameObjects.Image | null = null
  private crossfadeTex: Phaser.Textures.CanvasTexture | null = null
  private crossfadeData: ImageData | null = null
  private cavePixels: CaveImages['pixels'] | null = null
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
  private daySun: DaySun = sunAt(0.5)
  private sunRevision = ''
  private sunCosts: number[] = []
  /** Still casters by chunk ("cx,cy"), and their sun-dependent part for the current revision. */
  private stillCasters: Map<string, StillCaster[]> | null = null
  private castersLit = new Map<StillCaster, Caster>()
  private castersRevision = ''
  private albedoPaints = 0
  private facing = 'down'
  /** 2e partial see-through: the hero's covered pixels as a mask, the outline drawn through it, the body through its inverse. */
  private coverGfx: Phaser.GameObjects.Graphics | null = null
  private coverShow: Phaser.Display.Masks.GeometryMask | null = null
  private coverHide: Phaser.Display.Masks.GeometryMask | null = null
  private ghost: Phaser.GameObjects.Sprite | null = null
  private coverKey = ''
  private cover: SlopesState['cover'] = { box: [0, 0, 0, 0], covered: 0, total: 0, spriteCovered: 0, spriteTotal: 0, top: -1 }
  /** The generated area's built chunks (./walk.ts), by "cx,cy" (the area's own chunks). */
  private parts = new Map<string, Part>()
  private propsByChunk: Map<string, LabArea['props']> | null = null
  /** Waiting for the generated area's window (and what went wrong, if it did). */
  private loading: { error: string | null } | null = null

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
    this.caveImage = null
    this.mouthImages = []
    this.grids = []
    this.stillKey = ''
    this.updateMs = []
    this.lightMs = []
    this.look = labLook()
    this.built = { area: this.look.area, skyTiles: this.look.skyTiles, caveStyle: this.look.caveStyle, strategy: this.look.strategy, walkOverlay: this.look.walkOverlay, ...slopeSettings(this.look) }
    this.parts = new Map()
    this.jobs = []
    this.uploads = []
    this.paintSteps = []
    this.uploadSteps = []
    this.slow = []
    this.sunRevision = ''
    this.sunCosts = []
    this.albedoPaints = 0
    this.propsByChunk = null
    this.stillCasters = null
    this.castersLit.clear()
    this.castersRevision = ''
    this.loading = null
    // The generated area waits for the server's window (a few seconds the first time), the tab never frozen.
    if (this.look.area === 'walk' && !walkData) {
      this.waitForWalk()
      return
    }
    const endBuild = perfSpan('lab:build')
    this.area =
      this.look.area === 'walk'
        ? buildWalkArea(walkData!, this.look.strategy, { skyTiles: this.look.skyTiles })
        : buildArea(this.look.area, { skyTiles: this.look.skyTiles }, slopesLook(this.look))
    if (this.area.generated && walkResume) this.area.spawn = resumeAt(this.area, walkResume.tx, walkResume.ty)
    const resume = this.area.slopes ? slopesResume : null
    walkResume = null
    slopesResume = null
    drawFaces(this)
    drawOverlays(this)
    drawCrags(this)
    ensureTangleAtlas(this, DECOR_ATLAS)
    if (this.streamed()) this.buildWalkCave()
    else {
      this.buildGround()
      this.buildFaces()
      this.buildProps()
      this.buildCave()
    }
    this.buildMovers()
    this.buildCover()
    if (resume) {
      this.hero.walker.x = resume.x
      this.hero.walker.y = resume.y
      this.place(this.hero)
    }
    this.buildOverlays()
    // The generated area streams now; the slopes area once the camera is on the hero (it paints what the camera sees first).
    if (this.area.generated) this.stream(true)
    endBuild()
    this.buildMs = performance.now() - t0

    const cam = this.cameras.main
    const shown = this.area.slopes?.view ?? this.area.stack
    cam.setBounds(0, 0, shown.w * T, shown.h * T)
    cam.startFollow(this.hero.sprite, true, 0.12, 0.12, 0, 8)
    this.fitZoom()
    cam.setZoom(this.baseZoom)
    if (this.area.slopes) {
      cam.centerOn(this.hero.thing.x, this.hero.thing.y - 8)
      this.stream(true)
    }
    const onResize = () => this.fitZoom()
    this.scale.on('resize', onResize)

    const kb = this.input.keyboard!
    const k = (code: number) => kb.addKey(code, false)
    const C = Phaser.Input.Keyboard.KeyCodes
    this.keys = { up: [k(C.UP), k(C.W)], down: [k(C.DOWN), k(C.S)], left: [k(C.LEFT), k(C.A)], right: [k(C.RIGHT), k(C.D)] }

    let restarting = false
    const stopLook = onLabLook((l) => {
      const walk = l.area === 'walk' && this.look.area === 'walk'
      const slopes = l.area === 'slopes' && this.look.area === 'slopes'
      const rebuild =
        l.area !== this.look.area ||
        l.skyTiles !== this.look.skyTiles ||
        l.caveStyle !== this.look.caveStyle ||
        (walk && (l.strategy !== this.look.strategy || l.walkOverlay !== this.look.walkOverlay)) ||
        (slopes && (SLOPE_KEYS.some((k) => l[k] !== this.look[k])))
      this.look = l
      this.stillKey = ''
      if (rebuild && !restarting) {
        restarting = true
        // The other strategy (or the overlay) where the hero stands.
        if (walk) {
          const [tx, ty] = standTile(this.hero.walker)
          walkResume = { tx, ty }
        }
        // Drawn another way where the hero stands: the same ground, wherever the new view shows it.
        if (slopes && this.area.slopes) slopesResume = { x: this.hero.walker.x, y: this.hero.walker.y }
        this.scene.restart()
      }
    })
    this.buildHud()
    onSceneEnd(this, () => {
      stopLook()
      for (const m of this.movers) { m.thing.sun?.shadow.destroy(); m.thing.sun?.cast?.destroy() }
      this.scale.off('resize', onResize)
      this.hud?.remove()
      this.hud = null
      perfWatch(null)
      this.lightView.destroy()
      this.crossfade?.destroy()
      this.crossfade = null
      this.crossfadeTex = null
      this.crossfadeData = null
      this.cavePixels = null
      this.caveLightBuf = new Uint8ClampedArray(0)
      this.caveSpans = new Int32Array(0)
      this.lastIris = null
      clearLitScratch()
      if (this.textures.exists('hl-crossfade')) this.textures.remove('hl-crossfade')
      for (const key of [...this.parts.keys()]) this.dropPart(key)
      labHook(null)
      this.dropCover()
    })
    labHook(this)
    cam.fadeIn(400, 12, 12, 20)
    bus.emit(EV.worldShown)
  }

  /** Built a chunk at a time round the hero (the generated area, the slopes area): too big to draw at once. */
  private streamed(): boolean {
    return !!(this.area.generated || this.area.slopes)
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
    this.stillKey = ''
    return thing
  }

  private buildFaces(part?: Rect): Thing[] {
    // Lifted, the slopes area's faces are painted with the ground (./slopes-paint.ts), pixel by pixel.
    if (this.area.slopes) return []
    const l = this.area.stack.layers[SURFACE]!
    const isFace = (tx: number, ty: number) => tx >= 0 && tx < l.w && (l.kind[ty * l.w + tx] === KIND.face || l.kind[ty * l.w + tx] === KIND.mouth)
    const r = part ?? { x0: 0, y0: 0, x1: l.w - 1, y1: l.h - 1 }
    const made: Thing[] = []
    for (let ty = r.y0; ty <= r.y1; ty++)
      for (let tx = r.x0; tx <= r.x1; tx++) {
        const i = ty * l.w + tx
        if (l.kind[i] !== KIND.face) continue
        const rows = l.faceRows[i]!
        const row = l.faceRow[i]!
        const mouth = this.area.mouths.find((m) => m.lintel === ty && tx >= m.x0 && tx <= m.x1)
        const end = isFace(tx + 1, ty) ? (isFace(tx - 1, ty) ? '' : '-w') : '-e'
        const v = (tx * 7 + ty * 3) & 3
        const frame = mouth ? (tx === mouth.x0 ? 'lintel-w' : 'lintel-e') : `face-${facePart(row, rows)}-${v}${end}`
        const tint = FACE_TINT[l.faceTop[i]!] ?? 0xffffff
        const img = this.add.image(tx * T, ty * T, FACES_KEY, frame).setOrigin(0).setTint(tint)
        // Drawn by its own row's foot, so someone on a trail leg below it stands in front. (Slopes' faces are many levels tall.)
        const z = l.faceTop[i]! - (row + 0.5) / rows
        made.push(this.addThing({ parts: [{ o: img, dz: 0, a: 1 }], layer: SURFACE, x: img.x + 8, y: (ty + 1) * T, z, seen: 1 }, true))
      }
    return made
  }

  private buildProps(props = this.area.props): Thing[] {
    const decor = this.area.slopes ? slopeDecorAtlas(this, DECOR_ATLAS) : DECOR_ATLAS
    const tex = this.textures.get(decor)
    const made: Thing[] = []
    for (const p of props) {
      const crag = p.kind === 'crag'
      const frame = p.kind === 'crag' ? `crag-${p.variant & 3}` : tangleFrame(p.kind, p.variant)
      if (!crag && !tex.has(frame)) continue
      const x = p.tx * T + 8
      const y = (p.ty + 1) * T
      const img = this.add.image(x, y, crag ? CRAG_KEY : decor, frame).setOrigin(0.5, 1)
      const parts: Thing['parts'] = [{ o: img, dz: 0, a: 1 }]
      const casts = this.area.slopes
      const shadow = casts ? new SilhouetteShadow(this, x, y) : null
      if (shadow) parts.push({ o: shadow.image, dz: -1, a: 0 })
      made.push(this.addThing({ parts, layer: SURFACE, x, y, z: p.z ?? this.area.top[p.ty * this.area.stack.w + p.tx]!, seen: 1,
        ...(this.area.slopes ? { sun: { x: p.fieldX ?? x, y: p.fieldY ?? y, height: img.displayHeight * 0.65, shadow: shadow!, kind: CASTER_KIND[p.kind] ?? 'plant' } } : {}) }, true))
    }
    return made
  }

  private sunAtFeet(t: Thing) {
    const sun = t.sun!
    const part = this.parts.get(`${Math.floor(t.x / (24 * T))},${Math.floor(t.y / (24 * T))}`)
    if (part?.sunlight?.map) return sampleSunMap(part.sunlight.map, t.x, t.y)
    const sl = this.area.slopes!
    const tx = Math.max(0, Math.min(sl.field.w - 1, Math.floor(sun.x / T)))
    const ty = Math.max(0, Math.min(sl.field.h - 1, Math.floor(sun.y / T)))
    return fieldLight(sl.field, sun.x, sun.y, fieldZ(sl.field, tx, ty, sun.x / T - tx, sun.y / T - ty), this.daySun, this.look.sunStrength)
  }

  private applySun(t: Thing): number | null {
    const sl = this.area.slopes, sun = t.sun
    if (!sl || !sun) return null
    const part = t.parts[1]!
    if (!this.look.sunlight) { part.a = 0; sun.cast?.hide(); return t.tint ?? 0xffffff }
    const at = this.sunAtFeet(t)
    const [gx, gy] = fieldGradient(sl.field, sun.x, sun.y)
    if (this.look.spriteShadows === 'proxy') {
      part.a = 0
      if (!sun.cast) return lightTint(at.rgb, t.tint ?? 0xffffff)
      // Walkers: their own capsule now, and the still shadows they stand in.
      const under = this.stillDarkAt(t.x, t.y - 1)
      this.castMover(t, gx, gy, at.visible)
      const m = shadeMultiply(under)
      return lightTint([at.rgb[0] * m[0], at.rgb[1] * m[1], at.rgb[2] * m[2]], t.tint ?? 0xffffff)
    }
    sun.cast?.hide()
    const ray = sunShadow(gx, gy, sun.height, this.daySun.direction)
    const dy = ray.dy - sl.k * (gx * ray.dx + gy * ray.dy)
    sun.shadow.project(t.parts[0]!.o as Phaser.GameObjects.Image, ray.dx, dy)
    part.a = shadowOpacity(at.visible, this.look.sunStrength, this.daySun.daylight)
    return lightTint(at.rgb, t.tint ?? 0xffffff)
  }

  /** Still shadow darkness at a display pixel, from its chunk's layer. */
  private stillDarkAt(x: number, y: number): number {
    return this.parts.get(`${Math.floor(x / (24 * T))},${Math.floor(y / (24 * T))}`)?.sunlight?.darkAt(x, y) ?? 0
  }

  /** A walker's capsule shadow. Each pixel is dithered by its own terrain
   * light, and only darkens past the still shadow already there. */
  private castMover(t: Thing, gx: number, gy: number, visible: number): void {
    const sun = t.sun!
    const v = shadowRay(gx, gy, this.daySun.direction, this.area.slopes!.k)
    const cast = castProxy(sun.proxy!, t.x, t.y, v)
    const part = this.parts.get(`${Math.floor(t.x / (24 * T))},${Math.floor(t.y / (24 * T))}`)
    const map = part?.sunlight?.map ?? null
    const stamp = `${cast.x0},${cast.y0},${cast.w},${cast.h},${this.sunRevision},${visible.toFixed(2)},${part?.sunlight?.dark ? 1 : 0}`
    const { sunStrength } = this.look, { daylight } = this.daySun
    sun.cast!.draw(stamp, cast.x0, cast.y0, cast.w, cast.h, (wx, wy) => {
      const j = (wy - cast.y0) * cast.w + (wx - cast.x0)
      if (!cast.dir[j] && !cast.contact[j]) return null
      const vis = map ? (sampleVisibility(map, wx + 0.5, wy + 0.5) >= dither(wx, wy) ? 1 : 0) : 1
      const d = overShadow(this.stillDarkAt(wx, wy), shadowDarkness(cast.dir[j]!, cast.contact[j]!, visible, vis, sunStrength, daylight))
      return d > 0 ? shadeMultiply(d) : null
    })
  }

  /** Still casters that can reach chunk (cx, cy), lit for this revision. */
  private castersNear(cx: number, cy: number, revision: string): Caster[] {
    const sl = this.area.slopes!
    if (!this.stillCasters) {
      this.stillCasters = new Map()
      const decor = slopeDecorAtlas(this, DECOR_ATLAS), tex = this.textures.get(decor)
      for (const p of this.area.props) {
        const frame = p.kind === 'crag' ? `crag-${p.variant & 3}` : tangleFrame(p.kind, p.variant), crag = p.kind === 'crag'
        if (!crag && !tex.has(frame)) continue
        const fx = p.fieldX ?? p.tx * T + 8, fy = (p.fieldY ?? (p.ty + 1) * T) - 2
        const tx = Math.max(0, Math.min(sl.field.w - 1, Math.floor(fx / T))), ty = Math.max(0, Math.min(sl.field.h - 1, Math.floor(fy / T)))
        const [gx, gy] = fieldGradient(sl.field, fx, fy)
        const c: StillCaster = { x: p.tx * T + 8, y: (p.ty + 1) * T, fx, fy, gx, gy, z: fieldZ(sl.field, tx, ty, fx / T - tx, fy / T - ty),
          proxy: frameProxy(this, crag ? CRAG_KEY : decor, frame, CASTER_KIND[p.kind] ?? 'plant') }
        const key = `${Math.floor(p.tx / 24)},${Math.floor(p.ty / 24)}`
        const list = this.stillCasters.get(key)
        if (list) list.push(c); else this.stillCasters.set(key, [c])
      }
    }
    if (revision !== this.castersRevision) { this.castersLit.clear(); this.castersRevision = revision }
    const out: Caster[] = []
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
      for (const c of this.stillCasters.get(`${cx + dx},${cy + dy}`) ?? []) {
        let lit = this.castersLit.get(c)
        if (!lit) {
          const visible = this.daySun.daylight > 0 ? terrainVisibility(sl.field, c.fx, c.fy, c.z, this.daySun.direction) : 0
          lit = { x: c.x, y: c.y, proxy: c.proxy, flip: false, v: shadowRay(c.gx, c.gy, this.daySun.direction, sl.k), visible }
          this.castersLit.set(c, lit)
        }
        out.push(lit)
      }
    return out
  }

  /** Only light is invalidated. New revisions cancel unfinished light work,
   * never albedo jobs. Visible/nearest chunks get the small frame budget first. */
  private pumpSun(): void {
    const sl = this.area.slopes
    if (!sl) return
    const day = this.look.sunClock ? clockSun(serverNow()) : sunAt(this.look.sunTime)
    // Clock lighting updates roughly every 43 seconds; the manual slider has .01 steps.
    const revision = `${this.look.sunlight}:${this.look.sunStrength}:${day.time.toFixed(3)}:${day.daylight.toFixed(2)}:${this.look.slopeFacing}:${this.look.spriteShadows}:${edgeKey(edgeSettings(this.look))}`
    this.daySun = day
    this.sunRevision = revision
    const chunks = [...this.parts.values()].filter(p => !!p.sunlight).sort((a,b) =>
      Math.hypot((a.cx + .5) * 24 * T - this.hero.thing.x, (a.cy + .5) * 24 * T - this.hero.thing.y) -
      Math.hypot((b.cx + .5) * 24 * T - this.hero.thing.x, (b.cy + .5) * 24 * T - this.hero.thing.y))
    const start = performance.now()
    for (const p of chunks) {
      const light = p.sunlight!
      if (light.revision !== revision) light.start(sl, day, this.look.sunStrength, this.look.sunlight && this.look.slopeFacing !== 'off', revision,
        this.look.spriteShadows === 'proxy' ? () => this.castersNear(p.cx, p.cy, revision) : null, edgeSettings(this.look))
      while (light.pending) {
        const cost = light.step()
        if (cost !== null) { this.sunCosts.push(cost); if (this.sunCosts.length > 600) this.sunCosts.shift(); this.stillKey = '' }
        if (performance.now() - start >= 3) return
      }
    }
  }

  // ---------------------------------------------------------------- the generated area

  /** Waiting for the window: a line on the HUD, then the scene again once it's here. */
  private waitForWalk(): void {
    this.cameras.main.setBackgroundColor(FOG_COLOR.fog)
    this.buildHud()
    const started = performance.now()
    const say = (s: string) => {
      if (this.hud) this.hud.textContent = s
    }
    say('Height lab, near home — generating the window on the server…')
    this.loading = { error: null }
    const tick = this.time.addEvent({ delay: 500, loop: true, callback: () => !this.loading?.error && say(`Height lab, near home — generating the window on the server… ${((performance.now() - started) / 1000).toFixed(1)} s`) })
    const pending = walkLoaded() ?? loadWalk()
    let live = true
    pending.then(
      (d) => {
        walkData = d
        if (live) this.scene.restart()
      },
      (e: unknown) => {
        if (!live || !this.loading) return
        this.loading.error = e instanceof Error ? e.message : String(e)
        say(`Height lab, near home — couldn't generate it: ${this.loading.error}`)
      }
    )
    // Another area picked meanwhile: build that one.
    const stopLook = onLabLook((l) => {
      this.look = l
      if (l.area !== 'walk' && live) {
        live = false
        this.scene.restart()
      }
    })
    onSceneEnd(this, () => {
      live = false
      stopLook()
      tick.remove()
      this.hud?.remove()
      this.hud = null
      perfWatch(null)
      labHook(null)
    })
    labHook(this)
    bus.emit(EV.worldShown)
  }

  /** The generated area has no cave: an empty cave image and pixels, so the way-in code has its pieces. */
  private buildWalkCave(): void {
    if (!this.textures.exists('hl-cave-none')) addBlank(this, 'hl-cave-none')
    this.caveImage = this.add.image(0, 0, 'hl-cave-none').setOrigin(0).setAlpha(0).setVisible(false)
    this.cavePixels = { px: new Uint8ClampedArray(4), w: 1, x: 0, y: 0 }
    this.caveSpans = pixelSpans(this.cavePixels.px, 1)
    // Two empty level overlays (each part draws its own).
    for (let i = 0; i < 2; i++) this.grids.push(this.add.graphics())
  }

  /**
   * Keep the generated area's chunks round the hero built (ground, faces,
   * props, the levels overlay) and drop the far ones: it's too big to draw
   * all at once. At most two new chunks a frame, nearest first, unless
   * `all` (the first frame, or a jump).
   */
  private stream(all = false, at?: { x: number; y: number }): void {
    if (!this.streamed()) return
    const C = 24
    const shown = this.area.slopes?.view ?? this.area.stack
    const cw = Math.ceil(shown.w / C)
    const ch = Math.ceil(shown.h / C)
    // Round the hero (where they're drawn), or round what the camera frames.
    const cam = this.cameras.main
    const w = at ?? (this.framed ? { x: cam.midPoint.x, y: cam.midPoint.y } : { x: this.hero.thing.x, y: this.hero.thing.y })
    // Half the view, at the widest the climbing zoom gets, and a chunk more.
    const hx = this.scale.width / (2 * this.baseZoom * 0.75) + C * T
    const hy = this.scale.height / (2 * this.baseZoom * 0.75) + C * T
    const cx0 = Math.max(0, Math.floor((w.x - hx) / (C * T)))
    const cx1 = Math.min(cw - 1, Math.floor((w.x + hx) / (C * T)))
    const cy0 = Math.max(0, Math.floor((w.y - hy) / (C * T)))
    const cy1 = Math.min(ch - 1, Math.floor((w.y + hy) / (C * T)))
    for (const [key, p] of this.parts) if (p.cx < cx0 - 1 || p.cx > cx1 + 1 || p.cy < cy0 - 1 || p.cy > cy1 + 1) this.dropPart(key)
    const want: [number, number][] = []
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) if (!this.parts.has(`${cx},${cy}`)) want.push([cx, cy])
    const mx = w.x / (C * T) - 0.5
    const my = w.y / (C * T) - 0.5
    want.sort((a, b) => Math.hypot(a[0] - mx, a[1] - my) - Math.hypot(b[0] - mx, b[1] - my))
    if (this.area.slopes) this.streamSlopes(want, { cx0, cy0, cx1, cy1 })
    else for (const [cx, cy] of all ? want : want.slice(0, 2)) this.addPart(cx, cy)
    for (const p of this.parts.values()) p.grid.setVisible(this.look.grid)
  }

  /** The slopes area's chunks being painted, nearest first. */
  private jobs: PaintJob[] = []
  /** The slopes area's paint steps, per frame (ms): for the spec and the notes. */
  private paintSteps: number[] = []
  /** The slopes area's chunks going up a piece at a time (a band image, a few rows of faces, the props), by "cx,cy". */
  private uploads: { key: string; it: Generator<void, void> }[] = []
  /** The slopes area's upload steps, per frame (ms). */
  private uploadSteps: number[] = []
  /** The slopes area's slowest frames (update ms over 20), with what took the time: paint steps, chunk uploads (images, faces, props), the rest. */
  private slow: { ms: number; paint: number; upload: number; parts: number }[] = []
  private frameUpload = 0
  private frameParts = 0

  /**
   * The slopes area's chunks: painted ones (these settings, cached) go up a
   * piece at a time (uploads); the rest become jobs, painted a step at a
   * time, then go up the same way, all under PAINT_BUDGET_MS a frame
   * (pumpPaint), including entry, jumps and preset restarts. Never drain a
   * whole visible window synchronously; cold views fill progressively.
   */
  private streamSlopes(want: [number, number][], keep: { cx0: number; cy0: number; cx1: number; cy1: number }): void {
    this.jobs = this.jobs.filter((j) => j.cx >= keep.cx0 - 1 && j.cx <= keep.cx1 + 1 && j.cy >= keep.cy0 - 1 && j.cy <= keep.cy1 + 1 && !this.parts.has(`${j.cx},${j.cy}`))
    const order = new Map(want.map(([cx, cy], i) => [`${cx},${cy}`, i]))
    for (const [cx, cy] of want) {
      const key = chunkKey(this.area, cx, cy)
      const done = paintedChunk(key)
      if (done) {
        this.queueUpload(cx, cy)
        continue
      }
      if (!this.jobs.some((j) => j.key === key)) { this.albedoPaints++; this.jobs.push(paintJob(this.area, this.partRect(cx, cy), key, cx, cy)) }
    }
    this.jobs.sort((a, b) => (order.get(`${a.cx},${a.cy}`) ?? 99) - (order.get(`${b.cx},${b.cy}`) ?? 99))

  }

  /** A painted chunk to put up a piece at a time (pumpPaint), unless it's up or going up. */
  private queueUpload(cx: number, cy: number): void {
    const key = `${cx},${cy}`
    if (this.parts.has(key) || this.uploads.some((u) => u.key === key)) return
    this.uploads.push({ key, it: this.partSteps(cx, cy) })
  }

  /**
   * The slopes area's waiting work within the frame's budget (at least one
   * step): first pieces of chunks going up (a band image, some faces, the
   * props), nearest first, then paint steps; a chunk painted joins the
   * uploads. The paint ms (uploads are counted in frameUpload).
   */
  private pumpPaint(): number {
    if (!this.jobs.length && !this.uploads.length) return 0
    const t0 = performance.now()
    let upload = 0
    let painted = 0
    do {
      if (this.uploads.length) {
        const u0 = performance.now()
        const u = this.uploads[0]!
        if (u.it.next().done) this.uploads.shift()
        const ms = performance.now() - u0
        upload += ms
        this.frameUpload += ms
        continue
      }
      const p0 = performance.now()
      const j = this.jobs[0]!
      if (j.step()) {
        this.jobs.shift()
        this.queueUpload(j.cx, j.cy)
      }
      painted += performance.now() - p0
    } while ((this.jobs.length || this.uploads.length) && performance.now() - t0 < PAINT_BUDGET_MS)
    if (painted > 0) {
      this.paintSteps.push(painted)
      if (this.paintSteps.length > 600) this.paintSteps.shift()
    }
    if (upload > 0) {
      this.uploadSteps.push(upload)
      if (this.uploadSteps.length > 600) this.uploadSteps.shift()
    }
    return painted
  }

  /** A chunk's tiles (in what's drawn: the slopes area's view, else the stack). */
  private partRect(cx: number, cy: number): PaintPart {
    const C = 24
    const shown = this.area.slopes?.view ?? this.area.stack
    return { x0: cx * C, y0: cy * C, x1: Math.min(shown.w - 1, cx * C + C - 1), y1: Math.min(shown.h - 1, cy * C + C - 1), key: `hl-walk-${cx}-${cy}`, overlay: this.look.walkOverlay }
  }

  /** A chunk up at once (the generated area; the slopes area's under the camera on entering or a jump). */
  private addPart(cx: number, cy: number): void {
    const t0 = performance.now()
    const key = `${cx},${cy}`
    this.uploads = this.uploads.filter((u) => u.key !== key)
    if (this.parts.has(key)) this.dropPart(key)
    const it = this.partSteps(cx, cy)
    while (!it.next().done) {
      /* putting it up */
    }
    this.frameUpload += performance.now() - t0
  }

  /**
   * A chunk going up (ground images, faces, props, the levels overlay), a
   * piece a step: the slopes area's a band image at a time, then its faces
   * one row at a time, then eight props or four grid rows. It counts as built from the first
   * step (so it isn't asked for again); dropping it stops it.
   */
  private *partSteps(cx: number, cy: number): Generator<void, void> {
    const part = this.partRect(cx, cy)
    const rect = { x0: part.x0, y0: part.y0, x1: part.x1, y1: part.y1 }
    const p: Part = { cx, cy, images: [], keys: [], things: [], grid: this.add.graphics().setDepth(BAND.gridOut).setVisible(this.look.grid) }
    this.parts.set(`${cx},${cy}`, p)
    this.frameParts++
    if (this.area.slopes) p.sunlight = new SunChunk(this, `${part.key}-sun`, part.x0 * T, part.y0 * T, (part.x1 - part.x0 + 1) * T, (part.y1 - part.y0 + 1) * T)
    const bands = this.area.slopes ? paintedChunk(chunkKey(this.area, cx, cy)) : null
    const add = (li: { key: string; x: number; y: number; level: number }) => {
      const img = this.add.image(li.x, li.y, li.key).setOrigin(0).setDepth(BAND.ground + li.level)
      this.levelImages.push({ img, level: li.level })
      p.images.push(img)
      p.keys.push(li.key)
    }
    if (bands)
      for (const b of bands) {
        for (const li of bandImages(this, part.key, [b])) add(li)
        this.stillKey = ''
        yield
      }
    else for (const li of paintSurface(this, this.area, part)) add(li)
    const faceRows = this.area.slopes ? 1 : 6
    for (let y = rect.y0; y <= rect.y1; y += faceRows) {
      p.things.push(...this.buildFaces({ ...rect, y0: y, y1: Math.min(rect.y1, y + faceRows - 1) }))
      this.stillKey = ''
      if (this.area.slopes && !this.area.slopes.lift) yield
    }
    const props = (this.propsByChunk ??= this.groupProps()).get(`${cx},${cy}`) ?? []
    const batch = this.area.slopes ? 8 : Math.max(1, props.length)
    for (let i = 0; i < props.length; i += batch) {
      p.things.push(...this.buildProps(props.slice(i, i + batch)))
      this.stillKey = ''
      if (this.area.slopes) yield
    }
    const gridRows = this.area.slopes ? 4 : rect.y1 - rect.y0 + 1
    for (let y = rect.y0; y <= rect.y1; y += gridRows) {
      drawGrid(p.grid, this.area.slopes?.view ?? this.area.stack.layers[SURFACE]!, this.area, { ...rect, y0: y, y1: Math.min(rect.y1, y + gridRows - 1) })
      this.stillKey = ''
      if (this.area.slopes) yield
    }
  }

  private dropPart(key: string): void {
    const p = this.parts.get(key)
    if (!p) return
    this.parts.delete(key)
    this.uploads = this.uploads.filter((u) => u.key !== key)
    const gone = new Set(p.things)
    for (const t of p.things) {
      for (const part of t.parts) part.o.destroy()
      t.twin?.destroy()
      t.sun?.shadow.destroy()
    }
    this.things = this.things.filter((t) => !gone.has(t))
    const imgs = new Set(p.images)
    this.levelImages = this.levelImages.filter((li) => !imgs.has(li.img))
    for (const img of p.images) img.destroy()
    p.grid.destroy()
    p.sunlight?.destroy()
    for (const k of p.keys) if (this.textures.exists(k)) this.textures.remove(k)
  }

  private groupProps(): Map<string, LabArea['props']> {
    const out = new Map<string, LabArea['props']>()
    for (const p of this.area.props) {
      const key = `${Math.floor(p.tx / 24)},${Math.floor(p.ty / 24)}`
      const list = out.get(key)
      if (list) list.push(p)
      else out.set(key, [p])
    }
    return out
  }

  private buildCave(): void {
    const end = perfSpan('lab:paint-cave')
    const ci = paintCave(this, this.area, this.look.caveStyle)
    this.caveImage = this.add.image(ci.cave.x, ci.cave.y, ci.cave.key).setOrigin(0).setAlpha(0)
    for (const m of ci.mouths) this.mouthImages.push(this.add.image(m.x, m.y, m.key).setOrigin(0))
    this.cavePixels = ci.pixels
    this.caveSpans = pixelSpans(ci.pixels.px, ci.pixels.w)
    end()
    for (const g of this.area.glows) {
      const x = g.tx * T + 8
      const y = (g.ty + 1) * T - 2
      const crystal = this.add.image(x, y, 'hl-crystal').setOrigin(0.5, 1).setTint(g.color)
      // The crystal stands above the light: it's a light itself, so it
      // shows from any floor (no fog twin). Its light on the floor round
      // it is the lighting's (./light.ts crystalLight).
      this.addThing({ parts: [{ o: crystal, dz: BAND.glow - BAND.caveIn, a: 1 }], layer: CAVE, x, y, z: g.z, seen: 0, glows: true }, false)
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
    const sunShadow = this.area.slopes ? new SilhouetteShadow(this, x, y) : null
    const shadow = sunShadow ? sunShadow.image : this.add.image(x, y - 1, 'shadow')
    const parts: Thing['parts'] = [{ o: sprite, dz: 0, a: 1 }, { o: shadow, dz: -1, a: 0.5 }]
    if (label) {
      const text = this.add.text(x, y - 24, label, { fontFamily: '"Pixelify Sans", monospace', fontSize: '8px', color: '#fff6e0', stroke: '#2a2030', strokeThickness: 2 }).setOrigin(0.5, 1).setResolution(4)
      parts.push({ o: text, dz: 3000, a: 1 })
    }
    // A twin on either layer: movers cross between them.
    const cast = this.area.slopes ? new MoverShadow(this, `hl-mover-shadow-${this.movers.length}`) : undefined
    const proxy = this.area.slopes ? frameProxy(this, sprite.texture.key, sprite.frame.name, 'body', sprite.scaleY) : undefined
    const thing = this.addThing({ parts, layer: node.layer, x, y, z: 0, seen: 1, tint: tint ?? 0xffffff, ...(this.area.slopes ? { sun: { x, y, height: sprite.displayHeight * 0.65, shadow: sunShadow!, kind: 'body' as const, cast, proxy } } : {}) }, true)
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
    this.crossfade = null
    this.crossfadeTex = null
    this.crossfadeData = null
    this.haze = this.add.image(0, 0, 'hl-haze').setDepth(BAND.haze).setAlpha(0)
  }

  private buildHud(): void {
    const parent = this.game.canvas.parentElement
    if (!parent) return
    const d = document.createElement('div')
    d.dataset.testid = 'height-lab-hud'
    // On a phone the game's own panel sits at the top: the lab's line goes just below its top stack
    // (where the game's notice card goes, src/ui/NoticeCard.svelte), smaller.
    const phone = typeof matchMedia !== 'undefined' && matchMedia('(max-width: 700px)').matches
    d.style.cssText =
      `position:absolute;left:50%;top:${phone ? 'calc(env(safe-area-inset-top) + 190px)' : 'max(8px, env(safe-area-inset-top))'};transform:translateX(-50%);z-index:30;pointer-events:none;` +
      `padding:4px 12px;border-radius:${phone ? '10px' : '999px'};background:rgba(20,16,28,.72);color:#fff3d6;font:600 ${phone ? '10px/1.3' : '12px/1.35'} system-ui,sans-serif;text-align:center;white-space:${phone ? 'pre-line;width:max-content;max-width:94vw' : 'pre'}`
    parent.appendChild(d)
    this.hud = d
  }

  // ---------------------------------------------------------------- every frame

  update(_time: number, deltaMs: number): void {
    if (this.loading) return
    const t0 = performance.now()
    const dt = Math.min(0.05, deltaMs / 1000)
    for (const m of this.movers) m.previous = [m.walker.x, m.walker.y]
    this.steerHero(dt)
    for (const m of this.movers) if (m !== this.hero) this.walkOn(m, dt)
    for (const m of this.movers) {
      this.applyGait(m, dt)
      this.place(m)
    }
    this.frameUpload = 0
    this.frameParts = 0
    this.stream()
    const paint = this.pumpPaint()
    this.pumpSun()
    this.applyLook(dt)
    const ms = performance.now() - t0
    if (this.area.slopes && ms > 20) {
      this.slow.push({ ms: Math.round(ms * 10) / 10, paint: Math.round(paint * 10) / 10, upload: Math.round(this.frameUpload * 10) / 10, parts: this.frameParts })
      if (this.slow.length > 40) this.slow.shift()
    }
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
      const sl = this.area.slopes
      if (sl) {
        // Directional speed from the field gradient and the two percentage sliders;
        // a diagonal is as fast as straight.
        this.uphill = slopeWalk(this.area.stack, sl.field, h.walker, dx / len, dy / len, h.speed * Math.min(1, len), dt, this.look.slopeUphill, Infinity, this.look.slopeDownhill).at
      } else {
        dx /= Math.max(1, len)
        dy /= Math.max(1, len)
        const [tx, ty] = standTile(h.walker)
        const l = this.area.stack.layers[h.walker.layer]!
        // A little slower on a slope (the hand-made areas' ramps).
        const slow = l.kind[ty * l.w + tx] === KIND.slope ? 0.8 : 1
        move(this.area.stack, h.walker, dx * h.speed * slow * dt, dy * h.speed * slow * dt)
      }
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
    const before = m.walker.x + m.walker.y
    // In the slopes area, Wren and the rest slow uphill as the hero does.
    const sl = this.area.slopes
    if (sl) slopeWalk(this.area.stack, sl.field, m.walker, vx / d, vy / d, m.speed, dt, this.look.slopeUphill, d, this.look.slopeDownhill)
    else {
      const s = Math.min(d, m.speed * dt)
      move(this.area.stack, m.walker, (vx / d) * s, (vy / d) * s)
    }
    if (Math.abs(m.walker.x + m.walker.y - before) < 0.01) m.stuck += dt
    else m.stuck = 0
    if (m.stuck > 0.6) {
      m.path = null
      m.stuck = 0
    }
    this.animate(m, true, Math.abs(vx) >= Math.abs(vy) ? (vx < 0 ? 'left' : 'right') : vy < 0 ? 'up' : 'down')
    if (m.anim !== 'demo' && Math.abs(vx) > 0.2) m.sprite.setFlipX(vx < 0)
  }

  private applyGait(m: Mover, dt: number): void {
    const sl = this.area.slopes
    m.gait = undefined
    m.sprite.anims.timeScale = 1
    if (!sl || !this.look.slopeGait || !m.previous || dt <= 0) return
    const dx = m.walker.x - m.previous[0]
    const dy = m.walker.y - m.previous[1]
    const [gx, gy] = fieldGradient(sl.field, m.walker.x, m.walker.y - m.walker.fh / 2)
    const gait = m.gait = slopeGait(gx, gy, dx / dt, dy / dt, m.speed)
    m.sprite.anims.timeScale = gait.cadence
    if (gait.cadence < 0.01 && m.anim === 'demo') m.sprite.anims.stop()
    m.scuffPx = (m.scuffPx ?? 0) + Math.hypot(dx, dy)
    if (gait.scuff && m.scuffPx >= 28 && !m.thing.hidden) {
      m.scuffPx = 0
      const z = zAt(this.area.stack, m.walker)
      const foot = display(sl, m.walker.x, m.walker.y - m.walker.fh / 2, z)
      const dust = this.add.rectangle(foot.x - 2, foot.y + 1, 3, 1, 0xc2b68b, 0.45).setDepth(foot.y + 3)
      this.tweens.add({ targets: dust, alpha: 0, y: dust.y - 2, x: dust.x - dx * 0.5, duration: 260, onComplete: () => dust.destroy() })
    }
    if (!gait.scuff) m.scuffPx = 0
  }

  /** 2e: the outline sprite and the mask its covered part is drawn through (the slopes area only). */
  private buildCover(): void {
    this.coverKey = ''
    this.cover = { box: [0, 0, 0, 0], covered: 0, total: 0, spriteCovered: 0, spriteTotal: 0, top: -1 }
    if (!this.area.slopes) return
    this.coverGfx = this.make.graphics({ x: 0, y: 0 }, false)
    this.coverShow = this.coverGfx.createGeometryMask()
    this.coverHide = this.coverGfx.createGeometryMask().setInvertAlpha(true)
    const sp = this.hero.sprite
    this.ghost = this.add.sprite(sp.x, sp.y, sp.texture.key, sp.frame.name).setOrigin(0.5, 1).setVisible(false).setTintFill(0x2c2640).setAlpha(0.7).setDepth(BAND.dark - 10)
    this.ghost.setMask(this.coverShow)
  }

  private dropCover(): void {
    this.ghost?.destroy()
    this.coverShow?.destroy()
    this.coverHide?.destroy()
    this.coverGfx?.destroy()
    this.ghost = null
    this.coverShow = this.coverHide = null
    this.coverGfx = null
  }

  /**
   * Partial see-through (2e): only the hero's pixels that nearer, higher
   * ground covers in the lift (./slopes.ts coveredPixels) show as the grey
   * outline over everything; the rest of the body draws as usual, through
   * the inverse of the same mask. Worked out only when the sprite's pixel
   * box or field row moves.
   */
  private seeThrough(): void {
    const sl = this.area.slopes
    const sp = this.hero.sprite
    if (!sl || !this.ghost || !this.coverGfx) return
    const x0 = Math.floor(sp.x - sp.displayWidth * sp.originX)
    const y0 = Math.floor(sp.y - sp.displayHeight * sp.originY)
    const w = Math.ceil(sp.displayWidth) + 1
    const h = Math.ceil(sp.displayHeight) + 1
    const fy = this.hero.walker.y - this.hero.walker.fh / 2
    const key = `${x0},${y0},${w},${h},${fy.toFixed(1)},${sl.lift},${sp.frame.name}`
    if (key !== this.coverKey) {
      this.coverKey = key
      const mask = sl.lift ? coveredPixels(sl, fy, this.hero.thing.z, x0, y0, w, h) : new Uint8Array(w * h)
      let covered = 0
      let top = -1
      for (let i = 0; i < mask.length; i++) if (mask[i]) { covered++; if (top < 0) top = Math.floor(i / w) }
      // The sprite's own opaque pixels, covered or not (the spec's "legs only" check).
      let spriteCovered = 0
      let spriteTotal = 0
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!this.opaqueAt(sp, x0 + x + 0.5, y0 + y + 0.5)) continue
        spriteTotal++
        if (mask[y * w + x]) spriteCovered++
      }
      this.cover = { box: [x0, y0, w, h], covered, total: w * h, spriteCovered, spriteTotal, top }
      this.coverGfx.clear().fillStyle(0xffffff)
      for (const r of coverRects(mask, x0, y0, w, h)) this.coverGfx.fillRect(r.x, r.y, r.w, r.h)
    }
    if (this.cover.covered === 0) {
      if (sp.mask) sp.clearMask()
      this.ghost.setVisible(false)
      return
    }
    if (sp.mask !== this.coverHide) sp.setMask(this.coverHide!)
    if (this.ghost.texture.key !== sp.texture.key) this.ghost.setTexture(sp.texture.key)
    this.ghost
      .setVisible(sp.visible)
      .setFrame(sp.frame.name)
      .setScale(sp.scaleX, sp.scaleY)
      .setFlipX(sp.flipX)
      .setPosition(sp.x, sp.y)
  }

  /** Whether a sprite's drawn pixel at world (x, y) is opaque (each frame's alpha read once). */
  private opaqueAt(sp: Phaser.GameObjects.Sprite, x: number, y: number): boolean {
    const fw = sp.frame.cutWidth
    const fh = sp.frame.cutHeight
    const fx = (x - (sp.x - sp.displayWidth * sp.originX)) / sp.scaleX
    const fy = (y - (sp.y - sp.displayHeight * sp.originY)) / sp.scaleY
    const px = Math.floor(sp.flipX ? fw - fx : fx)
    const py = Math.floor(fy)
    if (px < 0 || py < 0 || px >= fw || py >= fh) return false
    const key = `${sp.texture.key}:${sp.frame.name}`
    let alpha = this.frameAlpha.get(key)
    if (!alpha) {
      const c = document.createElement('canvas')
      c.width = fw
      c.height = fh
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(sp.frame.source.image as CanvasImageSource, sp.frame.cutX, sp.frame.cutY, fw, fh, 0, 0, fw, fh)
      const d = ctx.getImageData(0, 0, fw, fh).data
      alpha = new Uint8Array(fw * fh)
      for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4 + 3]!
      this.frameAlpha.set(key, alpha)
    }
    return alpha[py * fw + px]! > 0
  }
  private frameAlpha = new Map<string, Uint8Array>()

  /** A mover's parts follow its walker. */
  private place(m: Mover): void {
    const w = m.walker
    const t = m.thing
    t.layer = w.layer
    const z = zAt(this.area.stack, w)
    if (!Number.isNaN(z)) t.z = z
    // Walking is in field px; the slopes area's lift draws them 3 rows a level further north, or hidden behind higher ground.
    const d = this.area.slopes ? display(this.area.slopes, w.x, w.y - w.fh / 2, t.z) : null
    const x = w.x
    const y = d ? d.y + w.fh / 2 : w.y
    t.x = x
    t.y = y
    t.hidden = !!d?.hidden && m !== this.hero
    t.silhouette = !!d?.hidden && m === this.hero
    t.seen = w.layer === CAVE ? sample(this.area.stack.layers[CAVE]!, this.area.stack.layers[CAVE]!.seen, w.x, w.y - 2) : 1
    if (t.sun) { t.sun.x = w.x; t.sun.y = w.y - w.fh / 2 }
    m.sprite.setPosition(x + (m.gait?.x ?? 0), y + (m.gait?.y ?? 0))
    t.parts[1]!.o.setPosition(x, y - 1)
    t.parts[2]?.o.setPosition(x, y - 23)
    if (t.twin) {
      t.twin.setPosition(m.sprite.x, m.sprite.y).setFlipX(m.sprite.flipX)
      t.twin.setFrame(m.sprite.frame.name)
    }
  }

  /**
   * What the hero sees from where they stand: their layer and height, the
   * daylight there, how far they've walked in, and how far into the cave's
   * view they are: its light (over the surface's) and its floors (alpha),
   * by the way in chosen (./light.ts wayIn).
   */
  private view(): { layer: number; z: number; sky: number; walked: number; cave: number; alpha: number } {
    const w = this.hero.walker
    const cave = this.area.stack.layers[CAVE]!
    if (w.layer !== CAVE) return { layer: w.layer, z: this.hero.thing.z, sky: 1, walked: 0, cave: 0, alpha: 0 }
    const walked = sample(cave, this.area.walk, w.x, w.y - 2)
    const way = wayIn(walked, this.look.crossfade, this.look.way)
    return { layer: w.layer, z: this.hero.thing.z, sky: sample(cave, cave.sky, w.x, w.y - 2), walked, cave: way.light, alpha: way.alpha }
  }

  /** The iris way in: a circle from the nearest mouth's arch, opening with how far in the hero is, to past the view's far corner. */
  private iris(v: { layer: number; cave: number }, wv: Phaser.Geom.Rectangle): { x: number; y: number; r: number; soft: number } | null {
    if (this.look.way !== 'iris' || v.layer !== CAVE || v.cave <= 0.001 || v.cave >= 0.999) return null
    const h = this.hero.walker
    let best: { x: number; y: number } | null = null
    for (const m of this.area.mouths) {
      const c = { x: ((m.x0 + m.x1 + 1) / 2) * T, y: ((m.arch[0] + m.arch[1] + 1) / 2) * T }
      if (!best || Math.hypot(c.x - h.x, c.y - h.y) < Math.hypot(best.x - h.x, best.y - h.y)) best = c
    }
    const soft = 2 * T
    const far = Math.max(...[[wv.x, wv.y], [wv.right, wv.y], [wv.x, wv.bottom], [wv.right, wv.bottom]].map(([x, y]) => Math.hypot(x! - best!.x, y! - best!.y)))
    const r0 = 1.5 * T
    return { x: best!.x, y: best!.y, r: r0 + v.cave * (far + soft - r0), soft }
  }

  /** How much of the cave's own things (crystals, people) shows at a point, in the cave's view: its floors' alpha, or inside the iris. */
  private caveShownAt(x: number, y: number, v: { alpha: number }, iris: { x: number; y: number; r: number; soft: number } | null): number {
    if (!iris) return v.alpha
    const d = Math.hypot(x - iris.x, y - iris.y)
    return Math.max(0, Math.min(1, (iris.r + iris.soft - d) / Math.max(1e-6, iris.soft)))
  }

  private fogOf(viewZ: number, z: number): number {
    if (this.look.fog === 'none') return 0
    // The slopes area is 15 levels tall: fog by height difference, a level's worth every FOG_LEVELS levels.
    return fogFor(this.area.slopes ? (z - viewZ) / FOG_LEVELS : z - viewZ, this.look.fogStrength)
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
    // The cave's floors come in over the first steps inside (the
    // crossfade the owner liked). The surface stays drawn: in the cave's
    // view the light decides what of it shows (open air lit, the hill over
    // you dark). The floor under each arch is always there, under the
    // cave's image and under the surface's things (someone standing in
    // front of a mouth stays in front of it), so it doesn't change as you
    // cross.
    // Fog, haze and the climbing zoom go as the cave's view comes in, not
    // all at once at the portal (they flashed there).
    const wv = cam.worldView
    const iris = this.iris(v, wv)
    for (const li of this.levelImages) li.img.setAlpha(1 - this.fogOf(v.z, li.level) * (1 - v.cave))
    const caveBand = inCave ? BAND.caveGroundIn : BAND.caveGroundOut
    const caveAlpha = iris ? (v.cave > 0.001 ? 1 : 0) : v.alpha
    // While the way in lasts, the cave's floors are drawn lit in the crossfade's image (drawLight),
    // and the light pass underneath weights the remaining surface so the hill darkens evenly.
    const fade = inCave && (v.cave > 0.001 || v.alpha > 0.001) && (v.cave < 0.999 || v.alpha < 0.999)
    this.caveImage!.setDepth(caveBand).setAlpha(inCave ? caveAlpha : 0).setVisible(inCave && caveAlpha > 0.001 && !fade)
    for (const m of this.mouthImages) m.setDepth(BAND.caveGroundOut - 1)
    this.grids[0]!.setVisible(look.grid).setDepth(BAND.gridOut)
    this.grids[1]!.setVisible(look.grid && inCave).setDepth(BAND.gridIn)

    // Things: moving ones every frame, still ones when the view has moved.
    const key = `${v.layer}:${v.sky.toFixed(2)}:${v.cave.toFixed(2)}:${v.alpha.toFixed(2)}:${v.z.toFixed(2)}:${look.fog}:${look.fogStrength}:${look.way}:${this.sunRevision}:${iris ? Math.round(iris.r) : ''}`
    const still = key !== this.stillKey
    this.stillKey = key
    const moving = new Set(this.movers.map((m) => m.thing))
    for (const t of this.things) {
      if (!still && !moving.has(t)) continue
      const onCave = t.layer === CAVE
      const band = onCave ? (inCave ? BAND.caveIn : BAND.caveOut) : 0
      // The cave's things come in with its view (crystals popped in at the portal), the hero always shows.
      const vis = t.hidden ? 0 : onCave ? (t === this.hero.thing ? 1 : inCave ? Math.max(t.seen, this.caveShownAt(t.x, t.y, v, iris)) : t.seen) : 1
      // In the crossfade the cave's floors are drawn lit, over the light: its people stand over them, lit by
      // a tint of the light they'd have under it.
      const byTint = fade && onCave && !t.glows
      const sunlight = this.applySun(t)
      const at = byTint ? BAND.dark + 2 : band
      for (const [i, p] of t.parts.entries()) p.o.setDepth((byTint && i > 0 ? band : at) + t.y + p.dz).setAlpha(vis * p.a).setVisible(vis * p.a > 0.01)
      const body = t.parts[0]!.o
      if (byTint && !(body instanceof Phaser.GameObjects.Text)) {
        const c = this.lighting.at(CAVE, t.x, t.y - 8)
        body.setTint(caveTint(c, t.tint ?? 0xffffff, t.z - v.z, look.darkness))
        t.tinted = true
      } else if (sunlight !== null && !(body instanceof Phaser.GameObjects.Text)) {
        body.setTint(sunlight)
        t.tinted = false
      } else if (t.tinted && !(body instanceof Phaser.GameObjects.Text)) {
        if (t.tint !== undefined && t.tint !== 0xffffff) body.setTint(t.tint)
        else body.clearTint()
        t.tinted = false
      }
      if (t.twin) {
        // Surface things fade toward the fog seen from the surface; cave
        // things darken with the light (not here); across layers, not at all.
        const fog = !onCave ? this.fogOf(v.z, t.z) * (1 - v.cave) : 0
        t.twin
          .setDepth(band + t.y + t.parts[0]!.dz + 0.5)
          .setTintFill(onCave ? CAVE_DARK : fogColor)
          .setAlpha(vis * fog)
          .setVisible(vis * fog > 0.01)
      }
      // The hero's feet behind higher ground in the lift: their shadow and fog twin go (what's covered shows as the outline, seeThrough).
      if (t.silhouette) {
        t.parts[1]?.o.setVisible(false)
        t.twin?.setVisible(false)
      }
    }
    this.seeThrough()
    const hx = this.hero.thing.x
    this.drawLight(v, iris, fade, wv)

    // Climbing: haze at the screen's edges, and the camera eases out.
    const high = (1 - v.cave) * Math.max(0, Math.min(1, v.z / (this.area.slopes ? 12 : 2)))
    const hazeColor = look.fog === 'none' ? FOG_COLOR.fog : fogColor
    this.haze
      .setVisible(look.haze && high > 0.01)
      .setTint(hazeColor)
      // Near home, levels 2–3 are ordinary upland, not a summit: a lighter haze, or the Tops are all grey.
      .setAlpha(high * (this.area.generated ? 0.2 : this.area.slopes ? 0.35 : 0.6))
      .setPosition(wv.centerX, wv.centerY)
      .setDisplaySize(wv.width * 1.25, wv.height * 1.25)
    const climb = this.area.slopes ? v.z / 4 : v.z
    const target = this.baseZoom * (look.zoom ? 1 - 0.07 * Math.min(3, Math.max(0, climb)) * (1 - v.cave) : 1)
    if (Math.abs(cam.zoom - target) > 0.001) cam.setZoom(cam.zoom + (target - cam.zoom) * Math.min(1, dt * 3))

    // Where the hero stands on screen, for hold-to-walk (CSS px).
    const r = canvasRatio()
    heroScreen.x = ((hx - wv.x) * cam.zoom) / r
    heroScreen.y = ((this.hero.thing.y - wv.y) * cam.zoom) / r
  }

  /**
   * The light over the view: the moving lights moved, then the cave's
   * light (weight: how far into the cave's view the hero is) over the
   * surface's, darkened by depth from the hero's level, and on the arches
   * the cave's light whatever the view (what you see into a mouth). On the
   * surface in daylight, with no mouth on screen, there's nothing to draw.
   */
  private drawLight(v: { cave: number; alpha: number; z: number }, iris: { x: number; y: number; r: number; soft: number } | null, fade: boolean, wv: Phaser.Geom.Rectangle): void {
    const view = v.cave
    const t0 = performance.now()
    if (this.look.cave !== this.heroLight) {
      this.heroLight = this.look.cave
      this.lighting.set('hero', HERO_LIGHT[this.look.cave])
    }
    for (const [id, m] of [['hero', this.hero], ['friend', this.friend]] as const) this.lighting.move(id, m.walker.x, m.walker.y - 10, m.walker.layer, m.thing.z)
    const archInView = this.area.mouths.some((m) => (m.x1 + 1) * T > wv.x && m.x0 * T < wv.right && (m.arch[1] + 1) * T > wv.y && m.arch[0] * T < wv.bottom)
    this.lastIris = iris
    const showCrossfade = fade && (iris !== null || v.alpha > 0.001)
    if (!showCrossfade) this.crossfade?.setVisible(false)
    if (view <= 0.001 && !archInView) {
      this.lightView.hide()
      this.lighting.stats.uncapped = 0
      return
    }
    this.lightView.draw(
      this.lighting,
      wv,
      [
        { layer: CAVE, weight: view },
        { layer: SURFACE, weight: 1 - view }
      ],
      {
        depth: { layer: CAVE, z: v.z, cap: this.look.darkness, weight: iris ? 1 : view },
        portal: { layer: CAVE, mask: this.area.arches },
        over: fade ? { layer: CAVE, alpha: v.alpha } : undefined,
        iris: iris ? { layer: CAVE, ...iris } : undefined
      }
    )
    if (showCrossfade) this.drawCrossfade(v, iris, wv)
    this.lightMs.push(performance.now() - t0)
    if (this.lightMs.length > 120) this.lightMs.shift()
  }

  private lastIris: { x: number; y: number; r: number; soft: number } | null = null

  /** The crossfade's image: the cave's floors times the cave's own light, over the view, at the floors' alpha (or inside the iris). */
  private drawCrossfade(v: { alpha: number; z: number }, iris: { x: number; y: number; r: number; soft: number } | null, wv: Phaser.Geom.Rectangle): void {
    const R = LIGHT_RES
    const lx0 = Math.floor(wv.x / R) - 1
    const ly0 = Math.floor(wv.y / R) - 1
    const lw = Math.ceil(wv.width / R) + 3
    const lh = Math.ceil(wv.height / R) + 3
    if (this.caveLightBuf.length < lw * lh * 4) this.caveLightBuf = new Uint8ClampedArray(lw * lh * 4)
    this.lighting.fill({ x0: lx0, y0: ly0, w: lw, h: lh }, this.caveLightBuf, [{ layer: CAVE, weight: 1 }], {
      depth: { layer: CAVE, z: v.z, cap: this.look.darkness, weight: 1 },
      portal: { layer: CAVE, mask: this.area.arches }
    })
    const cp = this.cavePixels!
    const rx = Math.max(Math.floor(wv.x), cp.x)
    const ry = Math.max(Math.floor(wv.y), cp.y)
    const w = Math.min(Math.ceil(wv.right) + 2, cp.x + cp.w) - rx
    const h = Math.min(Math.ceil(wv.bottom) + 2, cp.y + cp.px.length / 4 / cp.w) - ry
    if (w <= 0 || h <= 0) {
      this.crossfade?.setVisible(false)
      return
    }
    // Lit on the CPU, only while the crossfade lasts (a few steps): the same everywhere, WebGL or Canvas.
    // (A render texture multiplying the floors by the light came out empty on the GPU.)
    const key = 'hl-crossfade'
    if (!this.crossfadeTex || this.crossfadeTex.width < w || this.crossfadeTex.height < h) {
      const bw = Math.max(w, this.crossfadeTex?.width ?? 0)
      const bh = Math.max(h, this.crossfadeTex?.height ?? 0)
      this.crossfade?.destroy()
      this.crossfade = null
      if (this.textures.exists(key)) this.textures.remove(key)
      this.crossfadeTex = this.textures.createCanvas(key, bw, bh)!
      this.crossfadeData = this.crossfadeTex.context.createImageData(bw, bh)
      this.crossfade = this.add.image(0, 0, key).setOrigin(0).setDepth(BAND.dark + 1)
    }
    const tex = this.crossfadeTex
    const data = this.crossfadeData!
    litPixels(cp.px, cp.w, cp.x, cp.y, this.caveLightBuf, lw, lh, lx0, ly0, R, rx, ry, tex.width, tex.height, data.data, iris, { w, h, spans: this.caveSpans })
    tex.context.putImageData(data, 0, 0)
    tex.refresh()
    this.crossfade!.setCrop(0, 0, w, h).setPosition(rx, ry).setAlpha(iris ? 1 : v.alpha).setVisible(true)
  }

  /** The light at the hero (0–1), as shown: the cave's over the surface's. */
  lightAtHero(): number {
    const v = this.view()
    const w = this.hero.walker
    const i = this.lastIris
    const k = i ? Math.max(0, Math.min(1, (i.r + i.soft - Math.hypot(w.x - i.x, w.y - 10 - i.y)) / i.soft)) : v.cave
    return k * this.lighting.level(CAVE, w.x, w.y - 10) + (1 - k) * this.lighting.level(SURFACE, w.x, w.y - 10)
  }

  /** The view's corners (a tile in from each), for the spec: the light as drawn there, and the cave's own light there. */
  private corners(): { shown: number[]; own: number[] } {
    const wv = this.cameras.main.worldView
    const pts = [[wv.x + T, wv.y + T], [wv.right - T, wv.y + T], [wv.x + T, wv.bottom - T], [wv.right - T, wv.bottom - T]] as const
    return { shown: pts.map(([x, y]) => this.lightView.at(x, y)), own: pts.map(([x, y]) => this.lighting.level(CAVE, x, y)) }
  }

  /** For the screenshot spec (dev only): put the hero on a tile, the camera with them, or framing another tile (a feature) until the next step. */
  put(layer: number, tx: number, ty: number, look?: [number, number]): void {
    const w = this.hero.walker
    w.layer = layer
    w.x = tx * T + 8
    w.y = ty * T + 12
    this.place(this.hero)
    const cam = this.cameras.main
    if (look) {
      cam.stopFollow()
      cam.centerOn(look[0] * T + 8, look[1] * T + 8)
      this.framed = true
    } else {
      this.follow()
      cam.centerOn(this.hero.thing.x, this.hero.thing.y - 8)
    }
    this.stream(true, look ? { x: look[0] * T + 8, y: look[1] * T + 8 } : undefined)
    this.stillKey = ''
  }

  /** The camera back on the hero after framing a feature. */
  private framed = false
  private follow(): void {
    if (!this.framed) return
    this.framed = false
    this.cameras.main.startFollow(this.hero.sprite, true, 0.12, 0.12, 0, 8)
  }

  /** The slopes area: the uphill slowdown where the hero last walked (gradient, uphill part, speed multiplier). */
  private uphill: ReturnType<typeof uphillFactor> | null = null

  /**
   * For the spec (dev only): walk the hero (dx, dy) for `px` field px as
   * steering does, a frame of `dt` at a time (field time, not the page's),
   * so a run's time is the same whatever the frame rate or drawing. How long
   * it took, how far it got, and the speed multipliers on the way.
   */
  runHero(dx: number, dy: number, px: number, dt = 1 / 60): { seconds: number; px: number; kMin: number; kMax: number; blocked: boolean; from: [number, number]; to: [number, number] } {
    const sl = this.area.slopes
    const h = this.hero
    const w = h.walker
    const len = Math.hypot(dx, dy)
    const from: [number, number] = [w.x, w.y]
    let seconds = 0
    let walked = 0
    let kMin = 1
    let kMax = 0
    let blocked = false
    while (sl && len > 0 && walked < px - 1e-6 && seconds < 60) {
      const x0 = w.x
      const y0 = w.y
      const r = slopeWalk(this.area.stack, sl.field, w, dx / len, dy / len, h.speed, dt, this.look.slopeUphill, px - walked, this.look.slopeDownhill)
      const moved = Math.hypot(w.x - x0, w.y - y0)
      seconds += r.used
      walked += moved
      kMin = Math.min(kMin, r.at.k)
      kMax = Math.max(kMax, r.at.k)
      this.uphill = r.at
      if (moved < r.px * 0.5) {
        blocked = true
        break
      }
    }
    this.follow()
    this.place(h)
    this.cameras.main.centerOn(h.thing.x, h.thing.y - 8)
    this.stillKey = ''
    return { seconds, px: walked, kMin, kMax, blocked, from, to: [w.x, w.y] }
  }

  /** Collision-respecting small steps for the wall-hugging screenshot walk. */
  stepHero(dx: number, dy: number): void {
    this.follow()
    move(this.area.stack, this.hero.walker, dx, dy)
    this.place(this.hero)
    this.cameras.main.centerOn(this.hero.thing.x, this.hero.thing.y - 8)
    this.stillKey = ''
  }

  /** The lab's state, for the screenshot spec. */
  state(): {
    area: string
    look: LabLook
    built: Built
    layer: number
    z: number
    sky: number
    walked: number
    cave: number
    alpha: number
    light: number
    lightMs: number
    corners: { shown: number[]; own: number[] }
    uncapped: number
    iris: number
    crossfade: boolean
    generated?: GeneratedState
    slopes?: SlopesState
  } {
    const v = this.view()
    const avg = this.lightMs.reduce((a, b) => a + b, 0) / Math.max(1, this.lightMs.length)
    const generated = this.generatedState()
    const slopes = this.slopesState()
    return { area: this.built.area, look: this.look, built: this.built, ...v, light: this.lightAtHero(), lightMs: avg, corners: this.corners(), uncapped: this.lighting.stats.uncapped, iris: this.lastIris?.r ?? 0, crossfade: !!this.crossfade?.visible, ...(generated ? { generated } : {}), ...(slopes ? { slopes } : {}) }
  }

  /** The generated area, for the spec: the strategy, where the hero is, the named spots, both strategies' numbers. */
  private generatedState(): GeneratedState | undefined {
    const g = this.area.generated
    if (!g) return undefined
    const [tx, ty] = standTile(this.hero.walker)
    return { ready: true, strategy: g.strategy, tile: [tx, ty], here: walkHere(this.area, tx, ty), spots: g.spots, summary: g.summary, parts: this.parts.size, things: this.things.length }
  }

  /** The slopes area, for the spec: the style, where the hero is (map and field tile), the spots in this map's tiles. */
  private slopesState(): SlopesState | undefined {
    const s = this.area.slopes
    if (!s) return undefined
    const [tx, ty] = standTile(this.hero.walker)
    const l = this.area.stack.layers[SURFACE]!
    const pct = (xs: number[]) => {
      const v = [...xs].sort((a, b) => a - b)
      return { frames: v.length, p50: v[Math.floor(v.length / 2)] ?? 0, p95: v[Math.floor(v.length * 0.95)] ?? 0, max: v.at(-1) ?? 0 }
    }
    const u = this.uphill
    return {
      look: { ...s.look },
      preset: slopePresetOf(this.look),
      style: styleOf(this.look),
      lift: s.lift,
      gentle: this.look.slopeUphill > 0,
      sunlight: (() => {
        const t = this.hero.thing, [gx, gy] = fieldGradient(s.field, t.sun!.x, t.sun!.y)
        const at = this.sunAtFeet(t)
        const v = shadowRay(gx, gy, this.daySun.direction, s.k), cast = castProxy(t.sun!.proxy!, t.x, t.y, v)
        const casters = this.castersRevision === this.sunRevision ? [...this.castersLit.values()].filter(c => Math.hypot(c.x - t.x, c.y - t.y) < 160).map(c => ({ x: c.x, y: c.y, kind: c.proxy.kind, foot: [c.x + c.proxy.foot.x, c.y + c.proxy.foot.y], height: c.proxy.height, v: c.v, visible: c.visible })) : []
        return { tint: lightTint(at.rgb), shadow: sunShadow(gx, gy, t.sun!.height, this.daySun.direction), gait: this.hero.gait ?? null,
          direction: this.daySun.direction, time: this.daySun.time, daylight: this.daySun.daylight, visibility: at.visible, opacity: shadowOpacity(at.visible, this.look.sunStrength, this.daySun.daylight),
          mode: this.look.spriteShadows, ray: v, under: this.stillDarkAt(t.x, t.y - 1), cast: { x0: cast.x0, y0: cast.y0, w: cast.w, h: cast.h, foot: [t.x + t.sun!.proxy!.foot.x, t.y + t.sun!.proxy!.foot.y] }, casters }
      })(),
      sunMap: { pending: [...this.parts.values()].filter(p => p.sunlight && (p.sunlight.pending || p.sunlight.revision !== this.sunRevision)).length,
        revision: this.sunRevision, chunks: this.parts.size, costs: this.sunCosts, albedoPaints: this.albedoPaints },
      uphill: u ? { gx: u.gx, gy: u.gy, up: u.up, k: u.k } : null,
      tile: [tx, ty],
      at: [this.hero.walker.x, this.hero.walker.y],
      shown: [this.hero.thing.x, this.hero.thing.y],
      silhouette: !!this.hero.thing.silhouette,
      cover: this.cover,
      edges: (() => {
        const chunks = [...this.parts.values()].map(p => p.sunlight?.edges).filter(e => !!e)
        return { settings: edgeSettings(this.look), chunks: chunks.length, edges: chunks.reduce((a, e) => a + e!.edges, 0) }
      })(),
      kind: l.kind[ty * l.w + tx] ?? 0,
      size: [s.view.w, s.view.h],
      pending: this.jobs.length + this.uploads.length,
      slow: this.slow,
      paint: pct(this.paintSteps),
      upload: pct(this.uploadSteps),
      update: pct(this.updateMs),
      spots: s.spots.map((p) => {
        const n = nearestWalkable(this.area.stack, p.tx, p.ty)
        const look = p.look ? mapPoint(s, p.look[0], p.look[1]) : null
        return { name: p.name, x: n.tx, y: n.ty, fx: p.tx, fy: p.ty, note: p.note, look: look ? ([look.tx, look.ty] as [number, number]) : null }
      }),
      parts: this.parts.size
    }
  }

  /** Still fetching the generated area's window (the spec waits on this). */
  loadingState(): { area: string; built: Built; look: LabLook; generated: { ready: false; error: string | null } } | null {
    return this.loading ? { area: this.built.area, built: this.built, look: this.look, generated: { ready: false, error: this.loading.error } } : null
  }

  private updateHud(): void {
    const now = performance.now()
    if (!this.hud || now - this.hudAt < 250) return
    this.hudAt = now
    const v = this.view()
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
    const dark = this.lightMs.length ? ` (light ${avg(this.lightMs).toFixed(2)})` : ''
    const perf = `lab update ${avg(this.updateMs).toFixed(2)} ms${dark} · ${this.children.length} objects · built in ${Math.round(this.buildMs)} ms (ground ${Math.round(this.paintMs)})`
    const g = this.area.generated
    if (g) {
      // One line, as short as the others: the strategy, the biome@version, the region, the level.
      const [tx, ty] = standTile(this.hero.walker)
      const h = walkHere(this.area, tx, ty)
      const where = h ? `${h.biome} · ${h.region} · level ${v.z.toFixed(2)}${h.stranded ? ' · stranded' : ''}` : `level ${v.z.toFixed(2)}`
      this.hud.textContent = `Near home — ${STRATEGY_NAME[g.strategy]} · ${where}\n${perf}`
      return
    }
    const sl = this.area.slopes
    if (sl) {
      const [tx, ty] = standTile(this.hero.walker)
      const steep = sl.field.slope[ty * sl.field.w + tx] ?? 0
      const preset = slopePresetOf(this.look)
      const u = this.uphill
      const up = this.look.slopeUphill > 0 && u && u.k < 0.999 ? ` · uphill ${u.up.toFixed(2)} ×${u.k.toFixed(2)}` : ''
      this.hud.textContent = `Slopes, hills and passes — ${preset ? SLOPE_PRESETS[preset].name : lookName(sl.look)} · level ${v.z.toFixed(2)} · slope ${steep.toFixed(2)}${up}\n${perf}`
      return
    }
    const here = v.layer === CAVE ? this.lightAtHero() : 1
    const where =
      v.layer === CAVE
        ? `In the cave · level ${v.z.toFixed(2)} · daylight ${Math.round(v.sky * 100)}% · light here ${Math.round(here * 100)}%`
        : `Surface · level ${v.z.toFixed(2)}`
    this.hud.textContent = `Height lab, ${this.area.name} — ${where}\n${perf}`
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
  private tex: Phaser.Textures.CanvasTexture | null = null
  /** The image (MULTIPLY): drawn over the view, or (hidden) into the way in's crossfade. */
  readonly img: Phaser.GameObjects.Image
  private data: ImageData | null = null
  private x0 = 0
  private y0 = 0

  constructor(
    private scene: Phaser.Scene,
    depth: number,
    private readonly key = 'hl-light'
  ) {
    this.img = scene.add.image(0, 0, '__WHITE').setOrigin(0).setDepth(depth).setBlendMode(Phaser.BlendModes.MULTIPLY).setVisible(false)
  }

  draw(lights: Lighting, wv: Phaser.Geom.Rectangle, views: { layer: number; weight: number }[], opts: FillOptions): void {
    const R = LIGHT_RES
    const x0 = Math.floor(wv.x / R) - 1
    const y0 = Math.floor(wv.y / R) - 1
    const w = Math.ceil(wv.width / R) + 3
    const h = Math.ceil(wv.height / R) + 3
    if (!this.tex || this.tex.width < w || this.tex.height < h) this.make(Math.max(w, this.tex?.width ?? 0), Math.max(h, this.tex?.height ?? 0))
    const tex = this.tex!
    lights.fill({ x0, y0, w: tex.width, h: tex.height }, this.data!.data, views, opts)
    tex.context.putImageData(this.data!, 0, 0)
    tex.refresh()
    // An upload resets the filter to the game's (pixel art: nearest).
    tex.setFilter(Phaser.Textures.FilterMode.LINEAR)
    this.img.setPosition(x0 * R, y0 * R).setVisible(true)
    this.x0 = x0
    this.y0 = y0
  }

  hide(): void {
    this.img.setVisible(false)
  }

  /** The last fill's texels (RGBA) and where the first one is (texels), or null before any. */
  texels(): { data: Uint8ClampedArray; w: number; h: number; x0: number; y0: number } | null {
    if (!this.data || !this.tex) return null
    return { data: this.data.data, w: this.tex.width, h: this.tex.height, x0: this.x0, y0: this.y0 }
  }

  /** The light as drawn at a world point (its brightest channel, 0–1; 1 where none is drawn). */
  at(x: number, y: number): number {
    if (!this.img.visible || !this.data || !this.tex) return 1
    const tx = Math.floor(x / LIGHT_RES) - this.x0
    const ty = Math.floor(y / LIGHT_RES) - this.y0
    if (tx < 0 || ty < 0 || tx >= this.tex.width || ty >= this.tex.height) return 1
    const i = (ty * this.tex.width + tx) * 4
    return Math.max(this.data.data[i]!, this.data.data[i + 1]!, this.data.data[i + 2]!) / 255
  }

  destroy(): void {
    this.img.destroy()
    if (this.scene.textures.exists(this.key)) this.scene.textures.remove(this.key)
    this.tex = null
    this.data = null
  }

  private make(w: number, h: number): void {
    const textures = this.scene.textures
    if (textures.exists(this.key)) textures.remove(this.key)
    this.tex = textures.createCanvas(this.key, w, h)!
    this.tex.setFilter(Phaser.Textures.FilterMode.LINEAR)
    this.data = this.tex.context.createImageData(w, h)
    this.img.setTexture(this.key).setScale(LIGHT_RES)
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
    put: (layer: number, tx: number, ty: number, look?: [number, number]) => {
      if (!scene.loadingState()) scene.put(layer, tx, ty, look)
    },
    step: (dx: number, dy: number) => {
      if (!scene.loadingState()) scene.stepHero(dx, dy)
    },
    run: (dx: number, dy: number, px: number, dt?: number) => (scene.loadingState() ? null : scene.runHero(dx, dy, px, dt)),
    look: (change: Partial<LabLook>) => setLabLook(change),
    clock: (unix: number | null) => setGameNow(unix),
    state: () => scene.loadingState() ?? scene.state()
  }
}
