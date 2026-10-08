/**
 * Small world touches (docs/hands-on-design.md, section 3): the places where
 * the world is something you handle — smell the flowers, sit on a bench,
 * read the signs. All of it is flavor: no items, no spends, nothing saved.
 *
 * It registers `touch:*` points (./interactables): it scans the built
 * WorldData (props, flower beds, exits) for touchable spots, each carrying
 * its own prompt and what it does. The lines are content
 * (src/content/touches.ts); sitting itself lives on the hero
 * (./hero — the seated pose on the seat, slow mana, stand on any movement;
 * the bench's geometry is ../seats).
 */
import { FLOWER_LINES, SIT_LINES, nextLine, signCopy } from '../../content/touches'
import { bus, EV } from '../events'
import { TERRAIN, TILE, tileBottom, tileMid } from '../../lib/tile'
import { sfx } from '../sfx'
import type { InteractId, PropSpot, WorldData } from '../worlds'
import type { Interactable, Interactables } from './interactables'
import type { Hero } from './hero'
import type { Effects } from './fx'
import { benchSeat } from '../seats'
import { openDialogue } from '../dialogue'

/** A touchable spot: what it is, where, and (for signs) what it says. */
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

/** Small world touches: never marked; the prompt and keycap hint are enough. */
export class Touches {
  private points: Interactable[] = []
  private counts = new Map<string, number>()

  constructor(private deps: TouchesDeps) {
    this.build(deps.world)
    deps.interactables.register(this, this.points)
  }

  // ------------------------------------------------------------ the touches

  private useBench(id: InteractId, spec: TouchSpec): void {
    const hero = this.deps.hero()
    if (hero.isSeated) {
      hero.standUp()
      return
    }
    // On the seat, facing the square, the backrest behind you (hero.sit).
    hero.sit(benchSeat(spec.x, spec.y))
    sfx('settle')
    bus.emit(EV.toast, { text: this.take(id, SIT_LINES), icon: 'sparkle', kind: 'thought' })
  }

  private useFlowers(id: InteractId, spec: TouchSpec): void {
    sfx('pop')
    this.deps.fx.sparkBurst(spec.x, spec.y - 8, 4)
    bus.emit(EV.toast, { text: this.take(id, FLOWER_LINES), icon: 'sparkle', kind: 'thought' })
  }

  private useSign(id: InteractId, spec: TouchSpec): void {
    const copy = signCopy(spec.signKey ?? 'sign:generic')
    openDialogue({ id, speaker: copy.speaker, lines: [this.take(id, copy.lines)] })
  }

  /** The next line in a pool for this spot, so each press varies. */
  private take(id: InteractId, pool: readonly string[]): string {
    const n = this.counts.get(id) ?? 0
    this.counts.set(id, n + 1)
    return nextLine(pool, n)
  }

  // ------------------------------------------------------------ spot finding

  private add(id: InteractId, x: number, y: number, label: string, spec: TouchSpec): void {
    const seated = () => this.deps.hero().isSeated
    if (spec.kind === 'bench') {
      this.points.push({ id, x, y, label: () => (seated() ? 'Stand up' : label), verb: () => (seated() ? 'Stand' : 'Sit'), activate: () => this.useBench(id, spec) })
    } else if (spec.kind === 'flowers') {
      this.points.push({ id, x, y, label, verb: 'Smell', activate: () => this.useFlowers(id, spec) })
    } else {
      this.points.push({ id, x, y, label, verb: 'Read', activate: () => this.useSign(id, spec) })
    }
  }

  private build(w: WorldData): void {
    for (const p of w.props) this.prop(w, p)
    // Flower beds: village ground tiles of flowers, one point per bed.
    if (w.areaId === 'village') {
      for (const bed of clustersOf(w, TERRAIN.flowers)) {
        this.add(
          `touch:flowers:${bed.tx},${bed.ty}` as InteractId,
          tileMid(bed.tx),
          tileMid(bed.ty),
          'Smell the flowers',
          { kind: 'flowers', x: tileMid(bed.tx), y: tileMid(bed.ty) }
        )
      }
    }
    // Exit signs, just inside the map edge so reading them doesn't walk you out.
    for (const e of w.exits) {
      if (e.label === null) continue
      const eastWest = e.tw === 1 && e.th > 1
      const x = eastWest ? (e.tx === 0 ? (e.tx + 1) * TILE - 4 : e.tx * TILE + 4) : (e.tx + e.tw / 2) * TILE
      const y = eastWest ? (e.ty + e.th / 2) * TILE : e.ty === 0 ? tileBottom(e.ty) - 4 : e.ty * TILE + 4
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
    const x = tileMid(p.tx)
    const y = tileBottom(p.ty)
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
