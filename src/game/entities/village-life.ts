import { onSceneEnd } from '../scene-end.ts'
/**
 * Village life in the scene: the notice boards, festival touches on their
 * days, and the village changing when the world finishes a project. Light
 * touches, not new systems: everything here is decoration over the map,
 * redrawn when the calendar or the world's projects change.
 *
 *  - The Breaking: candle hulls drifting on the village pond.
 *  - Carting Day: stalls and bunting at the Commons, bunting in the square.
 *  - Amberwake: a lamp in every window.
 *  - Closure Night: night falls; every lantern in the village is lit.
 *  - Projects: the well gets its canopy, the north bridge (the stream bridge
 *    in Brackenwood, worn until then) is mended, Ada's window is lit for good,
 *    and the Tolley mill's groaning wheel is mended and turns smooth.
 */
import Phaser from 'phaser'
import { FESTIVAL_NOTES } from '../../lib/village'
import { bus, EV } from '../events'
import { uiState } from '../input'
import { commonsArt } from '../commons-pass'
import { buildingKey } from '../buildings'
import { millWheelKeys, MILL_WHEEL_SIZE } from '../items-pass'
import { millHopperLines } from '../../content/residents'
import type { Session } from '../session'
import { TERRAIN, TILE, tileBottom, tileMid } from '../../lib/tile'
import type { WorldData } from '../worlds'
import { chunkOfTile, footprintAt, footprint, commonsLane } from '../wilds/fixed'
import { CHUNK_TILES } from '../wilds/coords'
import type { Buildable } from '../wilds/window-chunk'
import { FixedScope } from '../wilds/fixed-scope'
import { contentPosition } from '../../lib/location'
import { villageFor, type Village } from '../village'
import { calendarFind } from '../../lib/wilds/stories'
import { sellerFor } from '../../lib/items'
import { sellerChoices } from '../../lib/purse'
import { grantPaper } from '../papers'
import type { Interactable, Interactables } from './interactables'
import { expose } from '../dev-hooks'
import { openDialogue } from '../dialogue'
import { roadStep } from '../../lib/quests'

export interface VillageDeps {
  world: WorldData
  session: Session
  reducedMotion: boolean
  interactables: Interactables
  schedule?: (job: Buildable) => void
  unschedule?: (job: Buildable) => void
}

/** Ada Cooley's house: the east house (its window), per the village layout. */
const ADA_HOUSE_WINDOW = { tx: 35, ty: 6 }

/** Festival greetings already shown (per day and area) this page load. */
const greeted = new Set<string>()
/** When projects were last read (re-read at most once a minute on area entry). */
let projectsReadAt = 0

export class VillageLayer {
  private readonly village: Village
  private drawn: Phaser.GameObjects.GameObject[] = []
  private scope: FixedScope
  private chunks = new Map<string, { drawn: Phaser.GameObjects.GameObject[]; job: Buildable | null; timers: Phaser.Time.TimerEvent[] }>()
  private drawingChunk: string | null = null
  private greetingTimer: Phaser.Time.TimerEvent | null = null
  private drawing: Phaser.GameObjects.GameObject[] | null = null

  private festivalDrawn: string | null | undefined
  private shade: Phaser.GameObjects.Rectangle | null = null
  private stopped = false

  /** One camera-wide shade, including the fog and Tangle beyond fixed ground. */
  private syncShade = (): void => {
    const night = !this.stopped && this.chunks.size > 0 && this.village.calendar.festival === 'Closure Night'
    if (!night) {
      this.shade?.destroy()
      this.shade = null
      return
    }
    const camera = this.scene.cameras.main
    this.shade ??= this.scene.add.rectangle(0, 0, 1, 1, 0x101428, 0.42).setScrollFactor(0).setDepth(3990)
    this.shade.setPosition(camera.width / 2, camera.height / 2).setDisplaySize(camera.width / camera.zoom, camera.height / camera.zoom)
  }

  attachChunk(key: string): (() => void)[] {
    this.detachChunk(key)
    this.scope.keys.add(key)
    const chunk = { drawn: [] as Phaser.GameObjects.GameObject[], job: null as Buildable | null, timers: [] as Phaser.Time.TimerEvent[] }
    this.chunks.set(key, chunk)
    this.syncShade()
    const [cx, cy] = key.split(',').map(Number)
    const festival = this.village.calendar.festival
    if (festival && footprintAt(cx!, cy!)?.place.id === 'hearthwick') this.greet(festival)
    const steps = this.festivalSteps(key).map((step) => () => {
      if (this.chunks.get(key) !== chunk) return
      this.drawingChunk = key
      this.drawing = chunk.drawn
      try { step() } finally { this.drawing = null; this.drawingChunk = null }
    })
    this.syncInteractions()
    return steps
  }

  detachChunk(key: string): void {
    const chunk = this.chunks.get(key)
    if (chunk?.job) this.deps.unschedule?.(chunk.job)
    if (chunk) for (const timer of chunk.timers) timer.remove()
    if (key === this.millOwner) { this.millView = null; this.millOwner = null; this.millTimer = null }
    if (chunk) for (const o of chunk.drawn) {
      this.scene.tweens.killTweensOf(o)
      o.destroy()
    }
    this.chunks.delete(key)
    if (!this.chunks.size) { this.greetingTimer?.remove(); this.greetingTimer = null }
    this.syncShade()
    this.scope.keys.delete(key)
    this.syncInteractions()
  }

  /** Dressing changes use the same window budget as initial attachment. */
  private refreshChunks(): void {
    for (const key of [...this.chunks.keys()]) {
      const steps = [...this.attachChunk(key)]
      const chunk = this.chunks.get(key)!
      const job: Buildable = { build: (deadline) => {
        while (steps.length && performance.now() < deadline) steps.shift()!()
        if (!steps.length) chunk.job = null
        return !steps.length
      } }
      chunk.job = job
      this.deps.schedule?.(job)
    }
  }

  private festivalSteps(key: string): (() => void)[] {
    const [cx, cy] = key.split(',').map(Number) as [number, number]
    const fp = footprintAt(cx, cy)
    const name = this.village.calendar.festival
    if (!fp) return []
    const steps: (() => void)[] = []
    const at = (tx: number, ty: number, draw: () => void) => {
      if (chunkOfTile(tx, ty) === key) steps.push(draw)
    }
    const town = this.townFeatures()
    if (fp.place.id === 'hearthwick' && town) {
      at(town.mill.wheel.tx, town.mill.wheel.ty, () => this.millWheel())
      if (this.village.hasWorldFlag('project:well-canopy:complete')) at(town.well.tx, town.well.ty, () => {
        const x = (town.well.tx + 1) * TILE, y = tileBottom(town.well.ty) + 2
        this.add(this.scene.add.image(x, y, 'well-canopy').setOrigin(0.5, 1).setDepth(y + 1))
      })
      if (this.village.hasWorldFlag('project:cooley-window-fund:complete')) at(town.window.tx, town.window.ty, () => {
        const x = tileMid(town.window.tx), y = town.window.ty * TILE + 6
        this.glow(x, y, 0.9, 0.95)
        this.add(this.scene.add.image(x, y + 4, 'spark').setDepth(4002).setTint(0xffd24a))
      })
    }
    if (name === 'Carting Day') {
      const h = commonsLane()?.features.hame
      if (h) at(h.tx, h.ty, () => this.glow(tileMid(h.tx), tileBottom(h.ty) - 24, 0.6, 0.9))
    }
    for (const o of fp.objects.get(key) ?? []) {
      if (name === 'Closure Night' && o.prop?.light) steps.push(() => this.glow(tileMid(o.tx), tileBottom(o.ty) - o.prop!.h * 0.72, 1.1, 0.9))
    }
    for (let ty = cy * CHUNK_TILES; ty < (cy + 1) * CHUNK_TILES; ty++) for (let tx = cx * CHUNK_TILES; tx < (cx + 1) * CHUNK_TILES; tx++) {
      const terrain = fp.ground[ty - fp.ty]![tx - fp.tx]
      if ((name === 'Amberwake' || name === 'Closure Night') && terrain === TERRAIN.window) steps.push(() => this.windowGlow(tileMid(tx), ty * TILE + 6))
      if (name === 'The Breaking' && (terrain === TERRAIN.water_a || terrain === TERRAIN.water_b) && (tx + ty) % 7 === 0) steps.push(() => this.candle(tileMid(tx), tileMid(ty), Math.abs(tx + ty) % 6))
    }
    return steps
  }

  private candle(x: number, y: number, i: number): void {
    const hull = this.add(this.scene.add.image(x, y, commonsArt(this.scene, `candle-hull-${i % 3}`) ?? 'candle-hull').setOrigin(0.5, 1).setDepth(y))
    const flame = this.glow(x, y - 9, 0.25, 0.9)
    if (!this.deps.reducedMotion) {
      this.scene.tweens.add({ targets: [hull, flame], x: `+=${10 + (i % 3) * 6}`, duration: 5000 + i * 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
      this.scene.tweens.add({ targets: hull, y: y - 1, duration: 900 + i * 90, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    }
  }

  constructor(private scene: Phaser.Scene, private deps: VillageDeps) {
    this.scope = new FixedScope(!!deps.world.open)
    if (deps.world.open) {
      scene.events.on('prerender', this.syncShade)
      const cleanup = () => {
        if (this.stopped) return
        this.stopped = true
        this.greetingTimer?.remove()
        this.greetingTimer = null
        scene.events.off('prerender', this.syncShade)
        for (const key of [...this.chunks.keys()]) this.detachChunk(key)
      }
      onSceneEnd(scene, cleanup)
    }
    this.village = villageFor(deps.session)
    // A destroyed game (a session swap) never shuts its scene down: drop the
    // listener either way, and never draw into a scene that is gone.
    const onChange = () => {
      if (this.scene.sys?.isActive()) this.redraw()
    }
    bus.on(EV.villageChanged, onChange)
    onSceneEnd(scene, () => bus.off(EV.villageChanged, onChange))
    this.syncInteractions()
    expose('__fsDevCalendar', (unix) => this.village.setDevNow(unix), scene)
    // Pretend the world has finished something (a project's flag): the village redraws.
    expose('__fsDevWorldFlag', (flag) => {
      if (!this.village.worldFlags.includes(flag)) this.village.worldFlags = [...this.village.worldFlags, flag]
      bus.emit(EV.villageChanged, { what: 'projects' })
    }, scene)
    // Read-only: the mill wheel (playtests).
    expose('__fsMill', () => this.millView && { ...this.millView }, scene)
    expose('__fsVillage', () => ({
      calendar: this.village.calendar,
      source: this.village.calendarSource,
      worldFlags: this.village.worldFlags,
      projectsStatus: this.village.projectsStatus,
      loadProjects: () => this.village.loadProjects()
    }), scene)
    this.village.ensureCalendar()
    if (deps.session.link && Date.now() - projectsReadAt > 60_000) {
      projectsReadAt = Date.now()
      void this.village.loadProjects()
    }
    this.redraw()
  }

  // ------------------------------------------------------------ interactions

  /** The madder stall on Carting Day: what the dyers' scrap baskets hold. */
  private visitStall(): void {
    const stall = sellerFor('madder-stall')
    if (!stall) return
    const connected = !!this.deps.session.link
    openDialogue({
      id: 'village:stall',
      speaker: stall.npc,
      lines: stall.goods.map((g) => g.line),
      choices: connected
        ? [...sellerChoices(stall), { text: 'Not yet' }]
        : undefined
    })
  }

  /** The Tolley mill's hopper, with the tally scratched in its side. */
  private lookAtHopper(): void {
    const s = this.deps.session.state
    openDialogue({ id: 'village', speaker: 'Mill Hopper', lines: millHopperLines(s.flags) })
  }

  /**
   * What can be used here: the village notice board, and on Carting Day the
   * polishers' roll tacked inside the Commons gate (until you have read it).
   */
  private syncInteractions(): void {
    const w = this.deps.world
    const list: Interactable[] = []
    // The notices: "…" while the calendar has something posted.
    const notice = () => (this.village.calendar.notice ? 'talk' : null)
    const town = w.open ? this.townFeatures() : null
    const board = town?.board ?? w.board
    const mill = town?.mill ?? w.mill
    if (board && (w.open || w.areaId === 'village')) {
      list.push({ id: 'village:board', x: tileMid(board.tx), y: tileBottom(board.ty) + 2, label: 'Read the notice board', verb: 'Read', marker: notice, markerOffset: 32, activate: openBoard })
    }
    if (mill && (w.open || w.areaId === 'village')) {
      const h = mill.hopper
      list.push({ id: 'village:hopper', x: tileMid(h.tx), y: tileBottom(h.ty) + 2, label: 'Look at the hopper', verb: 'Look', markerOffset: 24, activate: () => this.lookAtHopper() })
    }
    const lane = this.lane()
    const ctx = { flags: this.deps.session.state.flags, late: roadStep(this.deps.session.state) === 'complete', mark: null }
    if (lane && this.village.calendar.festival === 'Carting Day' && calendarFind('hame', ctx)) {
      const h = lane.features.hame
      list.push({ id: 'village:hame', x: tileMid(h.tx), y: tileBottom(h.ty) + 6, label: 'Read the polishers’ roll', verb: 'Read', marker: notice, markerOffset: 32, activate: () => this.readHameRoll() })
    }
    // The Carting Day market: the madder stall stands between the gate and
    // the square on the day, and not otherwise.
    if (lane && this.village.calendar.festival === 'Carting Day' && sellerFor('madder-stall')) {
      const stall = sellerFor('madder-stall')!
      const at = contentPosition(stall.area, stall.tx, stall.ty)
      list.push({ id: 'village:stall', x: tileMid(at.tx), y: tileBottom(at.ty) + 2, label: stall.goods[0]?.label ?? 'Visit the madder stall', verb: 'Buy', marker: notice, markerOffset: 32, activate: () => this.visitStall() })
    }
    // Only when it changed: replacing the list rebuilds its markers.
    const here = list.filter((i) => this.scope.has(Math.floor(i.x / TILE), Math.floor((i.y - 8) / TILE)))
    const key = here.map((i) => i.id).join(',')
    if (key === this.interactionKey) return
    this.interactionKey = key
    this.deps.interactables.register(this, here)
  }

  private interactionKey: string | null = null

  /** On the open map, the Commons lane (its fixtures in world tiles), once its chunks are here. */
  private lane(): ReturnType<typeof commonsLane> {
    return this.deps.world.open ? commonsLane() : null
  }

  /** The Hame-Polishers' List: thirty years of names, stitched inside the gate. */
  private readHameRoll(): void {
    const ctx = { flags: this.deps.session.state.flags, late: roadStep(this.deps.session.state) === 'complete', mark: null }
    const paper = calendarFind('hame', ctx)
    if (paper) grantPaper(this.deps.session, paper)
    this.syncInteractions()
  }

  // ------------------------------------------------------------ drawing

  private add<T extends Phaser.GameObjects.GameObject>(o: T): T {
    const drawn = this.drawing ?? this.drawn
    drawn.push(o)
    return o
  }

  private redraw(): void {
    if (this.deps.world.open) {
      this.syncInteractions()
      const festival = this.village.calendar.festival
      const signature = JSON.stringify([festival, [...this.village.worldFlags].sort()])
      if (signature !== this.festivalDrawn) {
        this.festivalDrawn = signature
        this.refreshChunks()
        this.syncShade()
      }
      if (festival && this.lane() && this.chunks.size) this.greet(festival)
      return
    }
    for (const o of this.drawn) {
      this.scene.tweens.killTweensOf(o)
      o.destroy()
    }
    this.drawn = []
    this.millTimer?.remove()
    this.millTimer = null
    this.syncInteractions()
    const w = this.deps.world
    if (w.areaId === 'village') this.villageChanges()
    if (w.areaId === 'woodland') this.footbridge(this.village.hasWorldFlag('project:north-bridge:complete'))
    const festival = this.village.calendar.festival
    if (festival && (w.areaId === 'village' || this.lane())) {
      this.festival(festival)
      this.greet(festival)
    }
  }

  private glow(x: number, y: number, scale: number, alpha = 0.8): Phaser.GameObjects.Image {
    const g = this.add(this.scene.add.image(x, y, 'glow').setBlendMode(Phaser.BlendModes.ADD).setScale(scale).setAlpha(alpha).setDepth(4001))
    if (!this.deps.reducedMotion) this.scene.tweens.add({ targets: g, alpha: alpha * 0.7, duration: 1000 + Math.random() * 400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    return g
  }

  /** A window's lamp: the delivered glow overlay (Commons pass), else the soft glow. */
  private windowGlow(x: number, y: number): void {
    const key = commonsArt(this.scene, 'window-lamp-glow')
    if (!key) {
      this.glow(x, y, 0.75, 0.9)
      return
    }
    const g = this.add(this.scene.add.image(x, y, key).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.85).setDepth(4001))
    if (!this.deps.reducedMotion) this.scene.tweens.add({ targets: g, alpha: 0.6, duration: 1000 + Math.random() * 400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
  }

  /** Tiles of one terrain kind (window panes, the pond, the bridge). */
  private tilesOf(kind: number): { tx: number; ty: number }[] {
    const out: { tx: number; ty: number }[] = []
    const w = this.deps.world
    for (let y = 0; y < w.height; y++) for (let x = 0; x < w.width; x++) if (w.ground[y][x] === kind) out.push({ tx: x, ty: y })
    return out
  }

  private townFeatures() {
    const fp = footprint('hearthwick')
    if (!fp) return null
    const objects = [...fp.objects.values()].flat()
    const find = (id: string) => objects.find((o) => o.id === id)!
    const mill = find('mill'), ada = find('house-ada')
    if (!mill || !ada) return null
    const wheel = { tx: mill.tx + mill.tw, ty: mill.ty }
    let window = { tx: ada.tx, ty: ada.ty - ada.th + 1 }
    for (let ty = ada.ty - ada.th + 1; ty <= ada.ty; ty++) for (let tx = ada.tx; tx < ada.tx + ada.tw; tx++) if (fp.ground[ty - fp.ty]?.[tx - fp.tx] === TERRAIN.window) window = { tx, ty }
    return { board: find('town-board'), well: find('town-well'), window, mill: { hopper: find('mill-hopper'), wheel: { ...wheel, x: wheel.tx * TILE + 7, y: wheel.ty * TILE + 4 } } }
  }

  private millOwner: string | null = null
  private millTimer: Phaser.Time.TimerEvent | null = null
  private millView: { mended: boolean; frame: number; turns: number; x: number; y: number } | null = null

  /**
   * The Tolley mill's waterwheel, turning on the pond's edge. The old wheel
   * groans: it turns in fits, catching every few paddles with a jolt. Once
   * the mill-wheel project is done it is mended (new paddles, rope
   * lashings, an iron band) and turns smooth and a little quicker.
   */
  private millWheel(): void {
    const m = this.deps.world.open ? this.townFeatures()?.mill : this.deps.world.mill
    if (!m) return
    const mended = this.village.hasWorldFlag('project:mill-wheel:complete')
    const keys = millWheelKeys(mended)
    const depth = m.wheel.y + MILL_WHEEL_SIZE / 2
    const wheel = this.add(this.scene.add.image(m.wheel.x, m.wheel.y, keys[0]).setDepth(depth))
    const froth = this.add(this.scene.add.image(m.wheel.x + 6, m.wheel.y + 12, 'mill-froth-0').setDepth(depth + 1).setAlpha(0.85))
    const view = { mended, frame: 0, turns: 0, x: m.wheel.x, y: m.wheel.y }
    this.millView = view
    this.millOwner = this.drawingChunk
    if (this.deps.reducedMotion) return
    let step = 0
    let hold = 0
    this.millTimer = this.scene.time.addEvent({
      delay: mended ? 140 : 190,
      loop: true,
      callback: () => {
        if (!wheel.active) return
        if (hold > 0) {
          hold--
          if (!hold) wheel.setY(m.wheel.y)
          return
        }
        step++
        view.frame = step % keys.length
        if (view.frame === 0) view.turns++
        wheel.setTexture(keys[view.frame])
        froth.setTexture(`mill-froth-${step % 2}`)
        // The old wheel catches on its split paddle: a pause, then a jolt.
        if (!mended && step % 6 === 0) {
          hold = 3
          wheel.setY(m.wheel.y + 1)
        }
      }
    })
    this.trackTimer(this.millTimer)
  }

  private trackTimer(timer: Phaser.Time.TimerEvent): void {
    if (this.drawingChunk) this.chunks.get(this.drawingChunk)?.timers.push(timer)
  }

  private villageChanges(): void {
    this.millWheel()
    const w = this.deps.world
    if (this.village.hasWorldFlag('project:well-canopy:complete') && w.well) {
      const x = w.well.tx * TILE + 6
      const y = tileBottom(w.well.ty) + 2
      this.add(this.scene.add.image(x, y, 'well-canopy').setOrigin(0.5, 1).setDepth(y + 1))
    }
    if (this.village.hasWorldFlag('project:cooley-window-fund:complete')) {
      // Ada's lamp, paid in full: warm in her window every night, for good.
      const x = tileMid(ADA_HOUSE_WINDOW.tx)
      const y = ADA_HOUSE_WINDOW.ty * TILE + 6
      this.glow(x, y, 0.9, 0.95)
      this.add(this.scene.add.image(x, y + 4, 'spark').setDepth(4002).setTint(0xffd24a))
    }
  }

  /**
   * The Brackenwood footbridge over the stream: worn (a plank gone, a
   * sagging rail) until the village repairs it (the north-bridge project),
   * then mended. The deck lies on the ground layer, under everyone crossing.
   * Without the delivered footbridge, the plank tiles stay and the mended
   * bridge is the Commons pass's old one.
   */
  private footbridge(mended: boolean): void {
    const tiles = this.tilesOf(TERRAIN.bridge)
    if (tiles.length === 0) return
    const x0 = Math.min(...tiles.map((t) => t.tx))
    const x1 = Math.max(...tiles.map((t) => t.tx))
    const y = tiles[0].ty
    const cx = ((x0 + x1 + 1) / 2) * TILE
    const key = buildingKey(mended ? 'brackenwood-bridge-mended' : 'brackenwood-bridge-worn')
    if (this.scene.textures.exists(key)) {
      // The deck's foot point (bottom centre) on the bridge row's base.
      this.add(this.scene.add.image(cx, tileBottom(y), key).setOrigin(0.5, 0.75).setDepth(-2))
    } else if (mended) {
      this.add(this.scene.add.image(cx, tileBottom(y) + 5, 'mended-bridge').setOrigin(0.5, 1).setDepth(-2))
    }
    if (mended) this.glow(cx + 20, y * TILE - 2, 0.5)
  }

  private festival(name: string): void {
    const w = this.deps.world
    if (name === 'Carting Day') {
      if (w.villageLantern) {
        const l = w.villageLantern
        this.add(this.scene.add.image(l.tx * TILE + 24, l.ty * TILE - 14, 'bunting-64').setOrigin(0.5, 0).setDepth(5000))
      }
    }
    if (name === 'Amberwake' || name === 'Closure Night') {
      // A hearth-grade lamp in every window.
      for (const t of this.tilesOf(TERRAIN.window)) this.windowGlow(tileMid(t.tx), t.ty * TILE + 6)
    }
    if (name === 'Closure Night') {
      // Night, and every lantern in the village lit. The road beyond stays dark.
      const shade = this.add(this.scene.add.rectangle(0, 0, w.widthPx, w.heightPx, 0x101428, 0.42).setOrigin(0, 0).setDepth(3990))
      void shade
      for (const p of w.props) if (p.light) this.glow(tileMid(p.tx), tileBottom(p.ty) - p.h * 0.72, 1.1, 0.9)
    }
    if (name === 'The Breaking' && w.areaId === 'village') {
      // The pond, not the mill-race under the wheel.
      const race = w.mill ? w.mill.tx + w.mill.tw : -1
      const water = this.tilesOf(TERRAIN.water_a).concat(this.tilesOf(TERRAIN.water_b)).filter((t) => t.tx !== race)
      if (water.length === 0) return
      const x0 = Math.min(...water.map((t) => t.tx)) * TILE
      const x1 = (Math.max(...water.map((t) => t.tx)) + 1) * TILE
      const y0 = Math.min(...water.map((t) => t.ty)) * TILE
      const y1 = (Math.max(...water.map((t) => t.ty)) + 1) * TILE
      for (let i = 0; i < 6; i++) {
        const x = x0 + 8 + ((i * 37) % Math.max(1, x1 - x0 - 16))
        const y = y0 + 8 + ((i * 23) % Math.max(1, y1 - y0 - 12))
        // Three delivered hulls (Commons pass), taken in turn; else the placeholder.
        const hull = this.add(this.scene.add.image(x, y, commonsArt(this.scene, `candle-hull-${i % 3}`) ?? 'candle-hull').setOrigin(0.5, 1).setDepth(y))
        const flame = this.glow(x, y - 9, 0.25, 0.9)
        if (!this.deps.reducedMotion) {
          this.scene.tweens.add({ targets: [hull, flame], x: `+=${10 + (i % 3) * 6}`, duration: 5000 + i * 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
          this.scene.tweens.add({ targets: hull, y: y - 1, duration: 900 + i * 90, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
        }
      }
    }
  }

  /** Once per festival day and area: say what the day is. */
  private greet(name: string): void {
    const d = this.village.calendar
    const key = `${d.wickNumber}:${d.day}:${this.deps.world.areaId}`
    if (greeted.has(key)) return
    this.greetingTimer?.remove()
    this.greetingTimer = this.scene.time.delayedCall(1800, () => {
      this.greetingTimer = null
      if (!this.scene.sys.isActive() || greeted.has(key)) return
      greeted.add(key)
      bus.emit(EV.toast, { text: `${name}. ${FESTIVAL_NOTES[name] ?? ''}`.trim(), icon: 'lantern' })
    })
  }
}

/** Open the notice board panel (village or Commons). */
export function openBoard(): void {
  uiState.dialogueOpen = false
  bus.emit(EV.villageOpen, { panel: 'board' })
}
