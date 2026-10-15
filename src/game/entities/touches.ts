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
import { tileBottom, tileMid } from '../../lib/tile'
import { sfx } from '../sfx'
import type { ExitDef, InteractId, PropSpot, WorldData } from '../worlds'
import type { Interactable, Interactables } from './interactables'
import type { Hero } from './hero'
import type { Effects } from './fx'
import { benchSeat } from '../seats'
import { gateSignAt } from '../area/exits'
import type { FixedObject } from '../wilds/fixed.ts'
import { openDialogue } from '../dialogue'

/** A touchable spot: what it is, where, and (for signs) what it says. */
interface TouchSpec {
  kind: 'flowers' | 'bench' | 'sign'
  x: number
  y: number
  signKey?: string
  text?: string
}

export interface TouchesDeps {
  world: WorldData
  interactables: Interactables
  hero: () => Hero
  fx: Effects
}

/** Small world touches: never marked; the prompt and keycap hint are enough. */
export class Touches {
  private points: Interactable[] = []
  private counts = new Map<string, number>()

  constructor(private deps: TouchesDeps) {
    this.build(deps.world)
    deps.interactables.register(this, this.points)
  }

  /** A fixed exit's read belongs to its source chunk, even when the post leans across its edge. */
  attachChunk(owner: object, exits: readonly ExitDef[], height: number, place: string, objects: readonly FixedObject[] = []): void {
    const points = this.points
    this.points = []
    for (const e of exits) this.exit(e, height, place)
    for (const o of objects) {
      if (o.art && (o.variant === 'wildflowers' || (o.variant === 'tangle-decor' && o.frame?.startsWith('flowers-')))) {
        this.flower(o.tx * 16 + o.art.ox, o.ty * 16 + o.art.oy)
      }
      if (o.prop) this.prop({ areaId: place } as WorldData, { tx: o.tx, ty: o.ty, frame: o.variant, h: o.prop.h, body: [o.prop.bodyW, o.prop.bodyH] })
      if (o.id.startsWith('boundary:') && o.label) {
        const x = tileMid(o.tx), y = tileBottom(o.ty)
        this.add(`touch:sign:${o.id}` as InteractId, x, y, 'Read the sign', { kind: 'sign', x, y, text: o.label })
      }
    }
    this.deps.interactables.register(owner, this.points)
    this.points = points
  }

  /** Visible generated flower art follows its chunk's ownership and teardown. */
  attachFlowers(owner: object, flowers: readonly { x: number; y: number }[]): void {
    const points = this.points
    this.points = []
    for (const flower of flowers) this.flower(flower.x, flower.y)
    this.deps.interactables.register(owner, this.points)
    this.points = points
  }

  private flower(x: number, y: number): void {
    this.add(`touch:flowers:${x},${y}` as InteractId, x, y, 'Smell the flowers', { kind: 'flowers', x, y })
  }

  detachChunk(owner: object): void {
    this.deps.interactables.register(owner, [])
  }

  private exit(e: ExitDef, height: number, place: string): void {
    const at = gateSignAt({ height }, e)
    if (!at) return
    const { x, y } = at
    this.add(`touch:sign:gate:${e.tx},${e.ty}` as InteractId, x, y, 'Read the sign', { kind: 'sign', x, y, signKey: gateSignKey(place, String(e.to)) })
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
    const copy = spec.text ? { speaker: 'Sign', lines: [spec.text] } : signCopy(spec.signKey ?? 'sign:generic')
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
    // Exit signs: the post each named edge exit's label stands on (../area/exits.ts),
    // inside the map edge so reading one doesn't walk you out (a room's doorway
    // and stairs have no sign to read).
    for (const e of w.exits) this.exit(e, w.height, w.areaId)
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
      const post = (w.areaId === 'village' || w.areaId === 'hearthwick')
      this.add(`touch:sign:${post ? 'post' : 'route'}:${p.tx},${p.ty}` as InteractId, x, y, post ? 'Read the signpost' : 'Read the route sign', {
        kind: 'sign',
        x,
        y,
        signKey: post ? 'post' : 'route'
      })
    }
  }
}

/** Historical lore keys remain stable while the outdoor place names change. */
export function gateSignKey(place: string, to: string): string {
  const origin = place === 'hearthwick' ? 'village' : place
  const destination = origin === 'woodland' && (to === 'outdoors' || to === 'hearthwick') ? 'village' : to
  return `gate:${origin}:${destination}`
}
