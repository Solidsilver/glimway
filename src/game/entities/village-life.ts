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
 *    in Brackenwood) is mended with rails, Ada's window is lit for good.
 */
import Phaser from 'phaser'
import { FESTIVAL_NOTES } from '../../lib/village'
import { bus, EV } from '../events'
import { uiState } from '../input'
import { sfx } from '../sfx'
import type { Session } from '../session'
import { TERRAIN, TILE } from '../textures'
import type { InteractId, WorldData } from '../worlds'
import type { CommonsWorld } from '../commons'
import { VILLAGE_EV, villageFor, type Village } from '../village'
import type { Interactable, InteractionProvider, Interactables } from './interactables'

export interface VillageDeps {
  world: WorldData
  session: Session
  reducedMotion: boolean
  interactables: Interactables
}

/** Ada Cooley's house: the east house (its window), per the village layout. */
const ADA_HOUSE_WINDOW = { tx: 35, ty: 6 }

/** Festival greetings already shown (per day and area) this page load. */
const greeted = new Set<string>()
/** When projects were last read (re-read at most once a minute on area entry). */
let projectsReadAt = 0

export class VillageLayer implements InteractionProvider {
  private readonly village: Village
  private drawn: Phaser.GameObjects.GameObject[] = []

  constructor(private scene: Phaser.Scene, private deps: VillageDeps) {
    this.village = villageFor(deps.session)
    const onChange = () => this.redraw()
    bus.on(VILLAGE_EV.changed, onChange)
    scene.events.once('shutdown', () => bus.off(VILLAGE_EV.changed, onChange))
    if (deps.world.board && deps.world.areaId === 'village') {
      const b = deps.world.board
      deps.interactables.setDynamic([{ id: 'village:board', x: b.tx * TILE + 8, y: b.ty * TILE + TILE + 2, label: 'Read the notice board' }], this)
    }
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__fsDevCalendar = (unix: number | null) => this.village.setDevNow(unix)
    }
    ;(window as unknown as { __fsVillage?: () => unknown }).__fsVillage = () => ({
      calendar: this.village.calendar,
      source: this.village.calendarSource,
      worldFlags: this.village.worldFlags,
      projectsStatus: this.village.projectsStatus
    })
    this.village.ensureCalendar()
    if (deps.session.link && Date.now() - projectsReadAt > 60_000) {
      projectsReadAt = Date.now()
      void this.village.loadProjects()
    }
    this.redraw()
  }

  // ------------------------------------------------------------ interactions

  owns(id: InteractId): boolean {
    return id.startsWith('village:')
  }

  markerOffset(): number {
    return 32
  }

  marker(): 'quest' | 'talk' | null {
    return this.village.calendar.notice ? 'talk' : null
  }

  verb(): string {
    return 'Read'
  }

  activate(id: InteractId): void {
    if (id === 'village:board') openBoard()
  }

  // ------------------------------------------------------------ drawing

  private add<T extends Phaser.GameObjects.GameObject>(o: T): T {
    this.drawn.push(o)
    return o
  }

  private redraw(): void {
    for (const o of this.drawn) {
      this.scene.tweens.killTweensOf(o)
      o.destroy()
    }
    this.drawn = []
    const w = this.deps.world
    if (w.areaId === 'village') this.villageChanges()
    if (w.areaId === 'woodland' && this.village.hasWorldFlag('project:north-bridge:complete')) this.mendedBridge()
    const festival = this.village.calendar.festival
    if (festival && (w.areaId === 'village' || w.areaId === 'commons')) {
      this.festival(festival)
      this.greet(festival)
    }
  }

  private glow(x: number, y: number, scale: number, alpha = 0.8): Phaser.GameObjects.Image {
    const g = this.add(this.scene.add.image(x, y, 'glow').setBlendMode(Phaser.BlendModes.ADD).setScale(scale).setAlpha(alpha).setDepth(4001))
    if (!this.deps.reducedMotion) this.scene.tweens.add({ targets: g, alpha: alpha * 0.7, duration: 1000 + Math.random() * 400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    return g
  }

  /** Tiles of one terrain kind (window panes, the pond, the bridge). */
  private tilesOf(kind: number): { tx: number; ty: number }[] {
    const out: { tx: number; ty: number }[] = []
    const w = this.deps.world
    for (let y = 0; y < w.height; y++) for (let x = 0; x < w.width; x++) if (w.ground[y][x] === kind) out.push({ tx: x, ty: y })
    return out
  }

  private villageChanges(): void {
    const w = this.deps.world
    if (this.village.hasWorldFlag('project:well-canopy:complete') && w.well) {
      const x = w.well.tx * TILE + 6
      const y = (w.well.ty + 1) * TILE + 2
      this.add(this.scene.add.image(x, y, 'well-canopy').setOrigin(0.5, 1).setDepth(y + 1))
    }
    if (this.village.hasWorldFlag('project:cooley-window-fund:complete')) {
      // Ada's lamp, paid in full: warm in her window every night, for good.
      const x = ADA_HOUSE_WINDOW.tx * TILE + 8
      const y = ADA_HOUSE_WINDOW.ty * TILE + 6
      this.glow(x, y, 0.9, 0.95)
      this.add(this.scene.add.image(x, y + 4, 'spark').setDepth(4002).setTint(0xffd24a))
    }
  }

  private mendedBridge(): void {
    const tiles = this.tilesOf(TERRAIN.bridge)
    if (tiles.length === 0) return
    const x0 = Math.min(...tiles.map((t) => t.tx))
    const x1 = Math.max(...tiles.map((t) => t.tx))
    const y = tiles[0].ty
    const cx = ((x0 + x1 + 1) / 2) * TILE
    this.add(this.scene.add.image(cx, (y + 1) * TILE + 5, 'mended-bridge').setOrigin(0.5, 1).setDepth(-2))
    this.glow(cx + 20, y * TILE - 2, 0.5)
  }

  private festival(name: string): void {
    const w = this.deps.world
    if (name === 'Carting Day') {
      if (w.areaId === 'commons') {
        const c = w as CommonsWorld
        // Stalls along the cross lane between the gate and the square.
        for (const [key, tx, ty] of [['stall-a', 8, 18], ['stall-b', 13, 18], ['stall-c', 10, 24]] as const) {
          const x = tx * TILE + 8
          const y = (ty + 1) * TILE
          this.add(this.scene.add.image(x, y, key).setOrigin(0.5, 1).setDepth(y))
        }
        this.add(this.scene.add.image(23.5 * TILE, 17 * TILE - 18, 'bunting-96').setOrigin(0.5, 0).setDepth(5000))
        if (c.features) {
          const h = c.features.hame
          this.glow(h.tx * TILE + 8, (h.ty + 1) * TILE - 24, 0.6, 0.9)
        }
      } else if (w.villageLantern) {
        const l = w.villageLantern
        this.add(this.scene.add.image(l.tx * TILE + 24, l.ty * TILE - 14, 'bunting-64').setOrigin(0.5, 0).setDepth(5000))
      }
    }
    if (name === 'Amberwake' || name === 'Closure Night') {
      // A hearth-grade lamp in every window.
      for (const t of this.tilesOf(TERRAIN.window)) this.glow(t.tx * TILE + 8, t.ty * TILE + 6, 0.75, 0.9)
    }
    if (name === 'Closure Night') {
      // Night, and every lantern in the village lit. The road beyond stays dark.
      const shade = this.add(this.scene.add.rectangle(0, 0, w.widthPx, w.heightPx, 0x101428, 0.42).setOrigin(0, 0).setDepth(3990))
      void shade
      for (const p of w.props) if (p.light) this.glow(p.tx * TILE + 8, p.ty * TILE + TILE - p.h * 0.72, 1.1, 0.9)
    }
    if (name === 'The Breaking' && w.areaId === 'village') {
      const water = this.tilesOf(TERRAIN.water_a).concat(this.tilesOf(TERRAIN.water_b))
      if (water.length === 0) return
      const x0 = Math.min(...water.map((t) => t.tx)) * TILE
      const x1 = (Math.max(...water.map((t) => t.tx)) + 1) * TILE
      const y0 = Math.min(...water.map((t) => t.ty)) * TILE
      const y1 = (Math.max(...water.map((t) => t.ty)) + 1) * TILE
      for (let i = 0; i < 6; i++) {
        const x = x0 + 8 + ((i * 37) % Math.max(1, x1 - x0 - 16))
        const y = y0 + 8 + ((i * 23) % Math.max(1, y1 - y0 - 12))
        const hull = this.add(this.scene.add.image(x, y, 'candle-hull').setOrigin(0.5, 1).setDepth(y))
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
    greeted.add(key)
    this.scene.time.delayedCall(1800, () => {
      if (!this.scene.sys.isActive()) return
      bus.emit(EV.toast, { text: `${name}. ${FESTIVAL_NOTES[name] ?? ''}`.trim(), icon: 'lantern' })
    })
  }
}

/** Open the notice board panel (village or Commons). */
export function openBoard(): void {
  uiState.dialogueOpen = false
  sfx('open')
  bus.emit(VILLAGE_EV.open, { panel: 'board' })
}

export type { Interactable }
