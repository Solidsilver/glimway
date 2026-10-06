/**
 * Gathering (docs/items/crafting-and-repair.md, "Gathering"): the workable
 * pieces of a wilds chunk, the woods, or a homestead's land — trees to chop
 * with an axe, boulders to break with a pick, stumps and patches to dig with
 * a spade. A prompt/action feature like the Wilds claims (./wilds/entities):
 * the nearest piece within reach proposes the prompt; the action key works
 * it swing by swing, then one /api/items/gather tells the server the tool,
 * the action, the target and where. The server wears the tool, caps the day
 * and the area visit, and rolls the yields — trees are client scenery, so no
 * individual tree is validated.
 *
 * Regrowth follows the drift (docs/items/overview.md): the Tangle and the
 * wild edge rebuild when you leave and come back (the whole map is rebuilt
 * per visit), home land inside lamplight keeps its stumps (the server says
 * so in the gather's `land`; the map then rebuilds from the homestead
 * state). Felled trees leave a stump you can dig; broken boulders leave
 * rubble and open ground.
 */
import type Phaser from 'phaser'
import { GATHERING_DATA, gatheringSwings, gatheringTarget, gatheringToolWord, gatheringVerb, visitIdFor } from '../../lib/gathering'
import { parseHomeArea } from '../../lib/homestead'
import { giftPhrase, itemDef } from '../../lib/items'
import { itemErrorText, itemsFor } from '../items'
import { homesteadsFor } from '../homestead'
import { bus, EV } from '../events'
import { sfx } from '../sfx'
import { TILE } from '../textures'
import type { Session } from '../session'
import type { GatherSpot, WorldData } from '../worlds'
import type { Effects } from './fx'
import type { Hero } from './hero'
import type { PromptAction } from './interactables'
import type { ItemsActionResponse } from '../../lib/api/types'

export interface GatherAction extends PromptAction {
  spot: GatherSpot
  work: () => void
}

export interface GatheringDeps {
  world: WorldData
  session: Session
  fx: Effects
  reducedMotion: boolean
  hero: () => Hero
  /** A broken or dug piece leaves open ground: the scene opens the tile. */
  clearSolid: (tx: number, ty: number) => void
  /** The sprites standing for a tile (the piece's own art). */
  spritesAt: (tx: number, ty: number) => Phaser.GameObjects.Image[]
  /** Destroy the sprites standing for a tile (a felled piece). */
  fell: (tx: number, ty: number) => void
}

/** How close you must stand to work a piece, and how long a swing takes. */
const REACH = 36
const SWING_MS = 300

/** What a worked piece leaves behind, in its own atlas. */
const LEFT_AT: Partial<Record<string, string>> = { chop: 'stump-0', break: 'pebbles-0' }

export class Gathering {
  private spots: GatherSpot[]
  private busy = false
  private current: GatherAction | null = null
  /** Stumps and rubble this visit's work has drawn, by tile. */
  private drawn = new Map<string, Phaser.GameObjects.Image[]>()
  /** The last gather's outcome, as words for the playtest hooks. */
  private last = '-'

  constructor(private scene: Phaser.Scene, private deps: GatheringDeps) {
    this.spots = [...(deps.world.gathering ?? [])]
    const items = itemsFor(deps.session)
    // What's carried, for the tool (a world; guests carry the save's pack).
    if (deps.session.link && !items.view) void items.load()
    scene.events.once('shutdown', () => {
      this.spots = []
      this.current = null
      this.drawn.clear()
    })
  }

  /** Whether an area shows any work right now (guests carry no tools). */
  private live(): boolean {
    return !!this.deps.session.link && this.spots.length > 0
  }

  /**
   * The nearest workable piece within reach, for the scene's prompt. A piece
   * closer than `closerThan` (the nearest thing you could otherwise press E
   * at — a fallen bucket, someone to talk to) outranks it; one further away
   * keeps quiet.
   */
  promptAction(hero: { x: number; y: number }, closerThan = Infinity): GatherAction | null {
    this.current = null
    if (this.busy || !this.live()) return null
    let best: { d: number; spot: GatherSpot } | null = null
    for (const spot of this.spots) {
      const x = spot.tx * TILE + 8
      const y = (spot.ty + 1) * TILE
      const d = Math.hypot(hero.x - x, hero.y - 8 - y)
      if (d <= REACH && d < closerThan && (!best || d < best.d)) best = { d, spot }
    }
    if (!best) return null
    const spot = best.spot
    const action = gatheringTarget(spot.target)?.action ?? 'chop'
    this.current = {
      spot,
      label: spot.label,
      verb: gatheringVerb(action),
      x: spot.tx * TILE + 8,
      y: (spot.ty + 1) * TILE - 6,
      work: () => void this.work(spot)
    }
    return this.current
  }

  /** The action key while a gather prompt is up. True when it was used. */
  handleAction(): boolean {
    if (!this.current) return false
    this.current.work()
    return true
  }

  /** Read-only: what can be worked this visit, and what the prompt is on (playtests). */
  spotsView(): { target: string; tx: number; ty: number }[] {
    return this.spots.map((s) => ({ target: s.target, tx: s.tx, ty: s.ty }))
  }

  /** The spot the prompt is on right now (null: no prompt). */
  prompted(): { target: string; tx: number; ty: number; label: string } | null {
    if (!this.current) return null
    return { target: this.current.spot.target, tx: this.current.spot.tx, ty: this.current.spot.ty, label: this.current.label }
  }

  /** The last gather's outcome (playtests: what the server said). */
  lastOutcome(): string {
    return this.last
  }

  // ------------------------------------------------------------ the work

  private async work(spot: GatherSpot): Promise<void> {
    if (this.busy) return
    const { session } = this.deps
    const target = gatheringTarget(spot.target)
    if (!target) return
    const tool = this.toolFor(target.action)
    if (!tool) {
      this.last = 'no-tool'
      bus.emit(EV.toast, { text: `You’d want your ${gatheringToolWord(target.action)} for this.`, icon: 'bag' })
      return
    }
    this.busy = true
    this.last = 'working'
    const hero = this.deps.hero()
    hero.isGathering = true
    try {
      const swings = gatheringSwings(target.action, tool.bite)
      for (let i = 0; i < swings; i++) {
        this.swing(spot)
        await this.pause(SWING_MS)
        if (!this.scene.sys.isActive()) return
      }
      // The gather reads carried progress: write this frame's spot first.
      session.saveSoon()
      const home = session.state.area.startsWith('home:')
      const r = await itemsFor(session).gather(
        tool.id,
        target.action,
        spot.target,
        session.state.area,
        visitIdFor(session.state.area, session.state.wildsRegion ?? null),
        home ? [spot.tx, spot.ty] : undefined
      )
      if (!this.scene.sys.isActive()) return
      if (!r.ok) {
        this.last = `refused:${r.code}`
        this.refused(r.code, target.action)
        return
      }
      this.last = 'landed'
      this.landed(spot, r.value)
    } catch (err) {
      this.last = `error:${String(err).slice(0, 60)}`
      throw err
    } finally {
      this.busy = false
      hero.isGathering = false
    }
  }

  /** A carried tool with the action, still working (blunt and cracked refuse). */
  private toolFor(action: string): { id: string; bite: boolean } | null {
    const view = itemsFor(this.deps.session).view
    if (!view) return null
    for (const i of view.instances) {
      const d = itemDef(i.itemDef)
      if (!d || d.kind !== 'tool' || !d.actions?.includes(action)) continue
      if (i.state === 'blunt' || i.state === 'cracked') continue
      return { id: i.id, bite: i.fittings.some((f) => f.fitting === 'bite') }
    }
    return null
  }

  /** One swing: the arc, the sound, the piece shivering. */
  private swing(spot: GatherSpot): void {
    const hero = this.deps.hero()
    const hx = hero.sprite.x
    const hy = hero.sprite.y
    const x = spot.tx * TILE + 8
    const y = (spot.ty + 1) * TILE
    sfx('swing')
    const slash = this.scene.add.image(hx + (x - hx) * 0.4, hy - 8 + (y - hy) * 0.3, 'slash')
      .setDepth(hy + 2)
      .setRotation(Math.atan2(y - hy, x - hx))
    this.scene.tweens.add({ targets: slash, alpha: 0, duration: 160, onComplete: () => slash.destroy() })
    const pieces = this.spritesFor(spot)
    if (!this.deps.reducedMotion) {
      for (const p of pieces) {
        this.scene.tweens.add({ targets: p, angle: p.flipX ? -2 : 2, duration: 90, yoyo: true, ease: 'Sine.easeInOut' })
      }
    }
  }

  /** Everything drawn for a spot: the map's own sprites, plus drawn leavings. */
  private spritesFor(spot: GatherSpot): Phaser.GameObjects.Image[] {
    return [...this.deps.spritesAt(spot.tx, spot.ty), ...(this.drawn.get(`${spot.tx},${spot.ty}`) ?? [])]
  }

  /** The visible payoff, and the piece's change. */
  private landed(spot: GatherSpot, result: ItemsActionResponse['result']): void {
    const x = spot.tx * TILE + 8
    const y = (spot.ty + 1) * TILE
    const gathered = result.gathered ?? []
    this.deps.fx.sparkBurst(x, y - 8, gathered.length > 0 ? 10 : 4)
    if (gathered.length > 0) {
      const phrase = gathered.map((g) => giftPhrase(g.itemDef, g.qty)).join(', ').replace(/, ([^,]*)$/, ' and $1')
      bus.emit(EV.toast, { text: `Found: ${phrase}.`, icon: 'sparkle', art: `icon-${gathered[0].itemDef}` })
    }
    // Home land inside lamplight: the server kept the change (a stump stays,
    // open ground stays open) — the map rebuilds from the homestead state.
    if (result.land) {
      const gate = parseHomeArea(this.deps.session.state.area)
      if (gate !== null) {
        void homesteadsFor(this.deps.session)
          .fetchHome(gate)
          .then(() => {
            if (this.scene.sys.isActive()) bus.emit(EV.rebuildWorld, {})
          })
      }
      this.forget(spot)
      return
    }
    // Elsewhere the piece changes here, and comes back when you return.
    const action = gatheringTarget(spot.target)?.action ?? 'chop'
    this.deps.fell(spot.tx, spot.ty)
    const atlas = spot.art
    const leftFrame = LEFT_AT[action]
    if (atlas && leftFrame && this.scene.textures.exists(atlas.key) && this.scene.textures.get(atlas.key).has(leftFrame)) {
      const flat = leftFrame.startsWith('pebbles')
      const left = this.scene.add.image(x, y, atlas.key, leftFrame).setOrigin(0.5, 1).setDepth(flat ? -5 : y)
      this.drawn.set(`${spot.tx},${spot.ty}`, [left])
    }
    if (action === 'chop') {
      // The stump stays solid, and can be dug this visit.
      this.spots.splice(this.spots.indexOf(spot), 1, { target: 'stump', label: 'Dig the stump', tx: spot.tx, ty: spot.ty, art: spot.art })
      return
    }
    if (action === 'dig' || action === 'break') this.deps.clearSolid(spot.tx, spot.ty)
    this.forget(spot)
  }

  /** The soft line, and the pieces nearby shuffling out of reach. */
  private refused(code: string, action: string): void {
    if (code === 'gathered-enough') {
      bus.emit(EV.toast, { text: GATHERING_DATA.softCapLine, icon: 'sparkle' })
      this.spots = this.spots.filter((s) => (gatheringTarget(s.target)?.action ?? 'chop') !== action)
      return
    }
    bus.emit(EV.toast, { text: itemErrorText(code), kind: 'error' })
  }

  private forget(spot: GatherSpot): void {
    const i = this.spots.indexOf(spot)
    if (i >= 0) this.spots.splice(i, 1)
  }

  private pause(ms: number): Promise<void> {
    return new Promise((res) => this.scene.time.delayedCall(ms, res))
  }
}
