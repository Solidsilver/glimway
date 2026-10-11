/**
 * What the open map shows of other players' doing (docs/design/open-map.md
 * 2.10, decisions 20 and 23): a way sign at each end of a named way with
 * its name beside it, and "Found by <name>" over a found place's landmark.
 * It also tells the server when you reach a place (`wilds-discover`, no
 * button): the first in a world this wick gets a small find, and their name
 * sits on that place on everyone's map until the turning.
 *
 * Drawn for the chunks around the hero (the attached 3×3), from the store:
 * a near read or a lay that names a way, a discovery, all redraw it.
 */
import type Phaser from 'phaser'
import { FINDS, WAY_SIGN } from '../../content/open-map.ts'
import { TILE, tileFeet } from '../../lib/tile.ts'
import { loadWilds } from '../../lib/wilds/data.ts'
import { chunkOf } from '../../lib/wilds/coords.ts'
import { foundByText, placeName, waySignText } from '../../lib/wilds/paths.ts'
import type { WildsWay } from '../../lib/gen/glimway/v1/wilds_pb.js'
import { bus, EV } from '../events.ts'
import type { Session } from '../session.ts'
import type { Effects } from '../entities/fx.ts'
import type { Interactables } from '../entities/interactables.ts'
import { wildsPoint } from './sites.ts'
import { knownPlaces, wildsEpoch, wildsLive, wildsView, type PlaceAt } from './store.ts'
import { discoverPlace, mayAsk } from './ops.ts'
import { omArt } from './open-map-art.ts'

export interface MarksDeps {
  session: Session
  interactables: Interactables
  fx: Effects
  reducedMotion: boolean
  hero: () => { x: number; y: number }
  notePosition: () => void
}

/** The way sign's art (the open-map pass). */
export const WAY_SIGN_ART = omArt('way-sign')
/** How tall each landmark stands (world px), so a finder's name floats just over it. */
const LANDMARK_TOP: Record<string, number> = { 'split-oak': 82, 'standing-stone': 58, 'meadow-oak': 66, 'meadow-outcrop': 42 }
/** Names float over the trees and creatures, under the prompts and markers. */
const LABEL_DEPTH = 4500
const TEXT = { fontFamily: '"Pixelify Sans", monospace', fontSize: '7px', color: '#fff3cf', stroke: '#2b1d1a', strokeThickness: 2, resolution: 4 }

export class WildsMarks {
  private images: Phaser.GameObjects.GameObject[] = []
  private drawnFor = ''
  /** Places asked about this wick (`wick|place`), for the playtest hooks. */
  private asked = new Set<string>()
  private greeted = new Set<string>()
  private checkAt = 0
  private signs: WildsWay[] = []

  constructor(private scene: Phaser.Scene, private deps: MarksDeps) {
    scene.events.once('shutdown', () => {
      this.images = []
      deps.interactables.register(this, [])
    })
  }

  update(): void {
    const view = wildsView()
    if (!view) return
    const hero = this.deps.hero()
    const at = chunkOf(Math.floor(hero.x / TILE), Math.floor(hero.y / TILE))
    const key = `${view.version}|${at.cx},${at.cy}`
    if (key !== this.drawnFor) {
      this.drawnFor = key
      this.draw(at.cx, at.cy)
    }
    const now = Date.now()
    if (now < this.checkAt) return
    this.checkAt = now + 250
    this.checkPlaces(at.cx, at.cy)
  }

  // ------------------------------------------------------------ drawing

  private near(cx: number, cy: number, tx: number, ty: number): boolean {
    const c = chunkOf(tx, ty)
    return Math.abs(c.cx - cx) <= 1 && Math.abs(c.cy - cy) <= 1
  }

  private draw(cx: number, cy: number): void {
    for (const o of this.images) o.destroy()
    this.images = []
    const view = wildsView()
    if (!view) return
    const places = knownPlaces()
    const name = (id: string) => placeName(id, places.find((p) => p.id === id)?.kind ?? null)
    // Way signs, each end, with the way's name beside the post.
    this.signs = []
    const points = []
    for (const w of view.ways.values()) {
      for (const [end, sign] of [['a', w.signA], ['b', w.signB]] as const) {
        if (!sign || !this.near(cx, cy, sign.x, sign.y)) continue
        const at = tileFeet(sign.x, sign.y)
        if (this.scene.textures.exists(WAY_SIGN_ART)) this.images.push(this.scene.add.image(at.x, at.y, WAY_SIGN_ART).setOrigin(0.5, 1).setDepth(at.y))
        this.images.push(this.scene.add.text(at.x + 7, at.y - 22, w.name, TEXT).setOrigin(0, 1).setDepth(LABEL_DEPTH))
        this.signs.push(w)
        const from = end === 'a' ? w.a : w.b
        const to = end === 'a' ? w.b : w.a
        // A sign is read, not claimed: anything else in reach comes first.
        points.push({ ...wildsPoint(`way-sign:${w.id}:${end}`, at, 34, () => ({ label: WAY_SIGN.look, verb: WAY_SIGN.verb, claim: () => bus.emit(EV.toast, { text: waySignText(w.name, name(from), name(to)), icon: 'map', kind: 'thought' }) })), rank: 0 })
      }
    }
    this.deps.interactables.register(this, points)
    // "Found by <name>" over each found place's landmark.
    for (const p of places) {
      if (!this.near(cx, cy, p.tx, p.ty)) continue
      const d = view.discoveries.get(p.id)
      if (!d) continue
      const at = tileFeet(p.tx, p.ty)
      const top = LANDMARK_TOP[loadWilds().placeKinds.find((k) => k.id === p.kind)?.landmark ?? ''] ?? 40
      this.images.push(this.scene.add.text(at.x, at.y - top - 2, foundByText(d.displayName), TEXT).setOrigin(0.5, 1).setDepth(LABEL_DEPTH))
    }
  }

  // ------------------------------------------------------------ discovering

  private radius(p: PlaceAt): number {
    return loadWilds().placeKinds.find((k) => k.id === p.kind)?.findRadius ?? 3
  }

  /**
   * Within a place's find radius (Chebyshev from its landmark, as the server
   * measures it), tell the server (./ops.ts discoverPlace: one key a place
   * while it's unresolved; its answer or replay settles it there).
   */
  private checkPlaces(cx: number, cy: number): void {
    const session = this.deps.session
    const view = wildsLive(session)
    const wick = wildsEpoch('wick').id
    if (!view || !wick || !session.link) return
    const hero = this.deps.hero()
    const tx = Math.floor(hero.x / TILE)
    const ty = Math.floor(hero.y / TILE)
    for (const p of knownPlaces()) {
      if (!this.near(cx, cy, p.tx, p.ty) || Math.max(Math.abs(tx - p.tx), Math.abs(ty - p.ty)) > this.radius(p)) continue
      const known = view.discoveries.get(p.id)
      const key = `${wick}|${p.id}`
      if (known) {
        // Someone got here first: say so once, the first time you stand here.
        if (!this.greeted.has(key) && known.discovererId !== session.link.accountId) bus.emit(EV.toast, { text: FINDS.foundBefore.replace('{name}', known.displayName), icon: 'map', kind: 'thought' })
        this.greeted.add(key)
        continue
      }
      if (!mayAsk(p.id)) continue
      // The answer says who found it: no greeting of our own after it.
      this.greeted.add(key)
      this.asked.add(key)
      this.deps.notePosition()
      void discoverPlace(session, { id: p.id, cx: Math.floor(p.tx / 24), cy: Math.floor(p.ty / 24) }, hero)
      return
    }
  }

  // ------------------------------------------------------------ playtests

  debug(): { signs: string[]; asked: string[] } {
    return { signs: this.signs.map((w) => w.id), asked: [...this.asked] }
  }
}
