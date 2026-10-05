/**
 * Small world touches (docs/hands-on-design.md, section 3): the places where
 * the world is something you handle — smell the flowers, sit on a bench,
 * read the signs. All of it is flavor: no items, no spends, nothing saved.
 *
 * A feature-scoped InteractionProvider (like ./village-life) owning
 * `touch:*` ids: it scans the built WorldData (props, flower beds, exits)
 * for touchable spots and answers for them. The lines are content
 * (src/content/touches.ts); sitting itself lives on the hero
 * (./hero — a still pose at the seat, slow mana, stand on any movement).
 */
import { FLOWER_LINES, SIT_LINES, nextLine, signCopy } from '../../content/touches'
import { bus, EV } from '../events'
import { TILE, TERRAIN } from '../textures'
import { sfx } from '../sfx'
import { uiState } from '../input'
import type { InteractId, PropSpot, WorldData } from '../worlds'
import type { Interactable, InteractionProvider, Interactables } from './interactables'
import type { Hero } from './hero'
import type { Effects } from './fx'/** A touchable spot: what it is, where, and (for signs) what it says. */
interface TouchSpec {
  kind: 'flowers' | 'bench' | 'sign'
  x: number
  y: number
  signKey?: string
}

export interface TouchesDeps {
  world: WorldData
  interactables: Interactables
  hero: () => Hero
  fx: Effects
}

/** Clusters of one ground tile kind, grouping tiles within two of a member. */
function clustersOf(world: WorldData, kind: number): { tx: number; ty: number }[] {
  const tiles: { tx: number; ty: number }[] = []
  for (let y = 0; y < world.height; y++)
    for (let x = 0; x < world.width; x++) if (world.ground[y][x] === kind) tiles.push({ tx: x, ty: y })
  const groups: { tx: number; ty: number }[][] = []
  for (const t of tiles) {
    const near = groups.find((g) => g.some((p) => Math.abs(p.tx - t.tx) <= 2 && Math.abs(p.ty - t.ty) <= 2))
    if (near) near.push(t)
    else groups.push([t])
  }
  return groups.map((g) => ({
    tx: Math.round(g.reduce((s, p) => s + p.tx, 0) / g.length),
    ty: Math.round(g.reduce((s, p) => s + p.ty, 0) / g.length)
  }))
}

export class Touches implements InteractionProvider {
  private points: Interactable[] = []
  private specs = new Map<string, TouchSpec>()
  private counts = new Map<string, number>()

  constructor(private deps: TouchesDeps) {
    this.build(deps.world)
    deps.interactables.setDynamic(this.points, this)
  }

  owns(id: InteractId): boolean {
    return id.startsWith('touch:')
  }

  /** Ambient touches are never marked; the prompt and keycap hint are enough. */
  marker(): null {
    return null
  }

  verb(id: InteractId): string | null {
    const spec = this.specs.get(id)
    if (spec?.kind === 'bench') return this.deps.hero().isSeated ? 'Stand' : 'Sit'
    if (spec?.kind === 'flowers') return 'Smell'
    return 'Read'
  }

  label(id: InteractId): string | null {
    const point = this.points.find((p) => p.id === id)
    const spec = this.specs.get(id)
    if (!point || !spec) return null
    if (spec.kind === 'bench' && this.deps.hero().isSeated) return 'Stand up'
    return point.label
  }

  activate(id: InteractId): void {
    const spec = this.specs.get(id)
    if (!spec) return
    if (spec.kind === 'bench') this.useBench(id, spec)
    else if (spec.kind === 'flowers') this.useFlowers(id, spec)
    else this.useSign(id, spec)
  }

  // ------------------------------------------------------------ the touches

  private useBench(id: InteractId, spec: TouchSpec): void {
    const hero = this.deps.hero()
    if (hero.isSeated) {
      hero.standUp()
      return
    }
    // A small offset onto the bench's front edge + a still frame (hero.sit).
    hero.sit({ x: spec.x, y: spec.y + 4 })
    sfx('settle')
    bus.emit(EV.toast, { text: this.take(id, SIT_LINES), icon: 'sparkle' })
  }

  private useFlowers(id: InteractId, spec: TouchSpec): void {
    sfx('pop')
    this.deps.fx.sparkBurst(spec.x, spec.y - 8, 4)
    bus.emit(EV.toast, { text: this.take(id, FLOWER_LINES), icon: 'sparkle' })
  }

  private useSign(id: InteractId, spec: TouchSpec): void {
    const copy = signCopy(spec.signKey ?? 'sign:generic')
    uiState.dialogueOpen = true
    sfx('open')
    bus.emit(EV.dialogue, { id, speaker: copy.speaker, lines: [this.take(id, copy.lines)] })
  }

  /** The next line in a pool for this spot, so each press varies. */
  private take(id: InteractId, pool: readonly string[]): string {
    const n = this.counts.get(id) ?? 0
    this.counts.set(id, n + 1)
    return nextLine(pool, n)
  }

  // ------------------------------------------------------------ spot finding

  private add(id: InteractId, x: number, y: number, label: string, spec: TouchSpec): void {
    this.points.push({ id, x, y, label })
    this.specs.set(id, { ...spec, x, y })
  }

  private build(w: WorldData): void {
    for (const p of w.props) this.prop(w, p)
    // Flower beds: village ground tiles of flowers, one point per bed.
    if (w.areaId === 'village') {
      for (const bed of clustersOf(w, TERRAIN.flowers)) {
        this.add(
          `touch:flowers:${bed.tx},${bed.ty}` as InteractId,
          bed.tx * TILE + 8,
          bed.ty * TILE + 8,
          'Smell the flowers',
          { kind: 'flowers', x: bed.tx * TILE + 8, y: bed.ty * TILE + 8 }
        )
      }
    }
    // Exit signs, just inside the map edge so reading them doesn't walk you out.
    for (const e of w.exits) {
      if (e.label === null) continue
      const eastWest = e.tw === 1 && e.th > 1
      const x = eastWest ? (e.tx === 0 ? (e.tx + 1) * TILE - 4 : e.tx * TILE + 4) : (e.tx + e.tw / 2) * TILE
      const y = eastWest ? (e.ty + e.th / 2) * TILE : e.ty === 0 ? (e.ty + 1) * TILE - 4 : e.ty * TILE + 4
      this.add(`touch:sign:gate:${e.tx},${e.ty}` as InteractId, x, y, 'Read the sign', {
        kind: 'sign',
        x,
        y,
        signKey: `gate:${w.areaId}:${e.to}`
      })
    }
  }

  /** The props that can be touched: benches, planters, milestones, signs. */
  private prop(w: WorldData, p: PropSpot): void {
    const x = p.tx * TILE + 8
    const y = p.ty * TILE + TILE
    if (p.frame === 'patched-bench') {
      this.add(`touch:bench:${p.tx},${p.ty}` as InteractId, x, y, 'Sit on the bench', { kind: 'bench', x, y })
    } else if (p.frame === 'flower-planter') {
      this.add(`touch:flowers:${p.tx},${p.ty}` as InteractId, x, y, 'Smell the flowers', { kind: 'flowers', x, y })
    } else if (p.frame === 'stone-milestone') {
      this.add(`touch:sign:milestone:${p.tx},${p.ty}` as InteractId, x, y, 'Read the milestone', {
        kind: 'sign',
        x,
        y,
        signKey: 'milestone'
      })
    } else if (p.frame === 'trail-sign') {
      // The village signpost leans on purpose; the road's signs lean with it.
      const post = w.areaId === 'village'
      this.add(`touch:sign:${post ? 'post' : 'route'}:${p.tx},${p.ty}` as InteractId, x, y, post ? 'Read the signpost' : 'Read the route sign', {
        kind: 'sign',
        x,
        y,
        signKey: post ? 'post' : 'route'
      })
    }
  }
}
