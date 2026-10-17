/**
 * Camps on the open map (roadmap 0.13; docs/design/lamps.md §2.5, §2.7): a
 * way-lamp someone set in the Wilds, burning or guttering, with the pieces
 * and plants set out in its light. Look at the lamp for its oil and top it
 * up; its setter takes it down once the camp is empty. Pick up a piece of
 * yours. From the pack (EV.campDo): set a carried way-lamp down beside you,
 * or a piece or a seed at the camp you stand in.
 *
 * Read from GET /api/camps (no socket message carries camps): on walking
 * into another chunk, every half minute, and after each of your own camp
 * operations. Drawn for the chunks around the hero.
 */
import Phaser from 'phaser'
import type { CampView } from '../../lib/gen/glimway/v1/camps_pb.js'
import { CAMP_ERRORS, campAtTile, campFrame, campHasRoom, campLines, campLook, campPieceName, campSpot, campTaken } from '../../lib/camps.ts'
import { HOMESTEAD_DATA, homeItem, rotatedFootprint } from '../../lib/homestead.ts'
import { TILE, tileFeet } from '../../lib/tile.ts'
import { chunkOf } from '../../lib/wilds/coords.ts'
import { homeErrorText } from '../../content/errors.ts'
import { campsKnown as campsUi } from './camps-state.ts'
import { bus, EV } from '../events.ts'
import { openDialogue } from '../dialogue.ts'
import { sfx } from '../sfx.ts'
import type { Session } from '../session.ts'
import type { Interactables } from '../entities/interactables.ts'
import type { DialogueChoice } from '../../content/world.ts'
import { solidBox } from '../area/collision.ts'
import { decoFlat, decoKey } from '../commons-art.ts'
import { drawScale, hw2Art } from '../hearthwick2-art.ts'
import { itemIcon, itemsFrame, itemWorldArt } from '../items-pass.ts'
import { itemsFor } from '../items.ts'
import { homesteadsFor } from '../homestead.ts'
import { groundAt, solidAt } from './ground-view.ts'
import { wildsPoint } from './sites.ts'
import { TERRAIN } from '../../lib/tile.ts'

export interface CampsDeps {
  session: Session
  interactables: Interactables
  solids: Phaser.Physics.Arcade.StaticGroup
  hero: () => { x: number; y: number }
  notePosition: () => void
}

/** How often the camps are read again while you stand still (ms). */
const READ_EVERY_MS = 30_000

export class WildsCamps {
  private images: Phaser.GameObjects.GameObject[] = []
  private bodies: Phaser.Physics.Arcade.Image[] = []
  private drawnFor = ''
  private readAt = 0
  private reading = false
  private version = 0
  private busy = false

  constructor(private scene: Phaser.Scene, private deps: CampsDeps) {
    const onDo = (d: { action: 'set' | 'place' | 'plant'; itemId?: string; itemDef?: string }) => void this.fromPack(d)
    bus.on(EV.campDo, onDo)
    scene.events.once('shutdown', () => {
      bus.off(EV.campDo, onDo)
      this.clear()
      deps.interactables.register(this, [])
    })
  }

  private get me(): string | null {
    return this.deps.session.link?.accountId ?? null
  }

  update(): void {
    const hero = this.deps.hero()
    const at = chunkOf(Math.floor(hero.x / TILE), Math.floor(hero.y / TILE))
    const key = `${this.version}|${at.cx},${at.cy}`
    const now = Date.now()
    if (key !== this.drawnFor) {
      // A new chunk: read again (someone may have set a lamp out here).
      if (!this.drawnFor.endsWith(`|${at.cx},${at.cy}`)) this.readAt = 0
      this.drawnFor = key
      this.draw(at.cx, at.cy)
    }
    if (now >= this.readAt && !this.reading) {
      this.readAt = now + READ_EVERY_MS
      void this.read()
    }
  }

  /** Read the camps again now. */
  async read(): Promise<void> {
    const link = this.deps.session.link
    if (!link) return
    this.reading = true
    try {
      const r = await link.campsRead()
      if (!r.ok) return
      this.adopt(r.value.camps)
    } finally {
      this.reading = false
    }
  }

  private adopt(list: CampView[]): void {
    campsUi.list = list
    campsUi.me = this.me
    this.version++
  }

  // ------------------------------------------------------------ drawing

  private clear(): void {
    for (const o of this.images) o.destroy()
    for (const b of this.bodies) {
      this.deps.solids.remove(b, true, true)
    }
    this.images = []
    this.bodies = []
  }

  private body(cx: number, cy: number, w: number, h: number): void {
    const b = solidBox(this.scene, cx, cy, w, h)
    this.deps.solids.add(b)
    this.bodies.push(b)
  }

  private draw(cx: number, cy: number): void {
    this.clear()
    const points = []
    for (const c of campsUi.list) {
      if (Math.abs(c.cx - cx) > 1 || Math.abs(c.cy - cy) > 1) continue
      for (const p of c.pieces) {
        if (p.id === c.id) continue
        this.drawPiece(p.itemDef, p.x, p.y, p.rotation)
        if (p.ownerId === this.me) {
          const at = tileFeet(p.x, p.y)
          points.push(wildsPoint(`camp-piece:${p.id}`, at, 20, () => ({ label: `Pick up the ${campPieceName(p.itemDef).toLowerCase()}`, verb: 'Pick up', claim: () => void this.act({ action: 'remove', itemId: p.id }) })))
        }
      }
      for (const p of c.plants) {
        const at = tileFeet(p.x, p.y)
        const key = itemIcon(p.itemDef)
        if (this.scene.textures.exists(key)) this.images.push(this.scene.add.image(at.x, at.y, key).setOrigin(0.5, 1).setDepth(at.y))
      }
      // The lamp itself: lit, or guttering in its wick of warning.
      const at = tileFeet(c.x, c.y)
      const key = hw2Art(campFrame(campLook(c)))
      if (this.scene.textures.exists(key)) {
        const img = this.scene.add.image(at.x, at.y, key).setOrigin(0.5, 1).setScale(drawScale(key)).setDepth(at.y)
        img.setData('camp', c.id)
        this.images.push(img)
      }
      const glow = this.scene.add.image(at.x, at.y - 22, 'glow').setBlendMode(Phaser.BlendModes.ADD).setScale(c.dimming ? 0.35 : 0.6).setAlpha(c.dimming ? 0.45 : 0.8).setDepth(4001)
      this.images.push(glow)
      this.body(at.x, at.y - TILE / 2, TILE - 6, TILE - 6)
      points.push({ ...wildsPoint(`camp:${c.id}`, at, 30, () => ({ label: 'Look at the way-lamp', verb: 'Look', claim: () => this.look(c.id) })), rank: 0 })
    }
    this.deps.interactables.register(this, points)
  }

  /** A home piece where it stands (the homestead's own drawing, ../entities/homestead-art.ts). */
  private drawPiece(itemDef: string, x: number, y: number, rot: number): void {
    const def = homeItem(itemDef)
    if (!def) return
    const [fw, fh] = rotatedFootprint(def, rot as 0 | 90 | 180 | 270)
    const bx = x * TILE
    const by = (y + fh) * TILE
    const flat = decoFlat(itemDef)
    const key = decoKey(itemDef, rot)
    const art = this.scene.textures.exists(key) ? null : itemWorldArt(itemDef)
    if (!art && !this.scene.textures.exists(key)) return
    let img: Phaser.GameObjects.Image
    if (art) {
      const f = itemsFrame(art.slice('items-art:'.length))
      const w = f ? f.width : fw * TILE
      const h = f ? f.height : fh * TILE
      img = this.scene.add.image(bx + (fw * TILE) / 2, by, art).setOrigin(0.5, 1).setScale(Math.min((fw * TILE) / w, (fh * TILE) / h) || 1).setDepth(flat ? -3 : by)
    } else {
      img = this.scene.add.image(bx, by, key).setOrigin(0, 1).setDepth(flat ? -3 : by)
    }
    if (rot === 180 || rot === 270) img.setFlipX(true)
    this.images.push(img)
    if (!flat) this.body(bx + (fw * TILE) / 2, by - (fh * TILE) / 2 - 1, fw * TILE - 4, fh * TILE - 6)
  }

  // ------------------------------------------------------------ talking

  private camp(id: string): CampView | null {
    return campsUi.list.find((c) => c.id === id) ?? null
  }

  private oilCarried(): number {
    return itemsFor(this.deps.session).view?.stacks.filter((x) => x.itemDef === HOMESTEAD_DATA.wayLamp.oil).reduce((n, x) => n + x.qty, 0) ?? 0
  }

  /** The lamp: whose it is, its oil, a flask to pour in, and (its setter's, once empty) taking it down. */
  look(id: string): void {
    const c = this.camp(id)
    if (!c) return
    const choices: DialogueChoice[] = []
    if (campHasRoom(c)) {
      const oil = this.oilCarried()
      choices.push({ text: 'Top it up with hearth oil', action: `camp:fill:${c.id}`, disabled: oil < 1, ...(oil < 1 ? { note: 'You need hearth oil (the chandler sells it)' } : {}) })
    }
    if (c.setterId === this.me && c.pieces.length === 1 && c.plants.length === 0) choices.push({ text: 'Take the lamp down', note: 'The camp goes; its oil comes back to you', action: `camp:down:${c.id}` })
    choices.push({ text: 'Leave it' })
    openDialogue({ id: 'camp', speaker: 'Way-lamp', lines: campLines(c, this.me), choices })
  }

  /** A choice picked in the lamp's talk (WorldActions routes `camp:` here). */
  onAction(rest: string): void {
    const [what, id] = rest.split(':')
    if (!id) return
    if (what === 'fill') void this.act({ action: 'fill', camp: id }, (c) => { if (c) openDialogue({ id: 'camp', speaker: 'Way-lamp', lines: campLines(c, this.me) }) })
    else if (what === 'down') void this.act({ action: 'remove', itemId: id }, () => bus.emit(EV.toast, { text: 'You take the way-lamp down. Its oil is back in your pack.', icon: 'glim' }))
  }

  // ------------------------------------------------------------ doing

  /** Open ground beside you, as the client knows it (the server checks again). */
  private open(tx: number, ty: number): boolean {
    const g = groundAt(tx, ty)
    return !solidAt(tx, ty) && g !== null && g !== TERRAIN.water_a && g !== TERRAIN.water_b && g !== TERRAIN.bridge
  }

  /** From the pack: a way-lamp set down beside you, or a piece or seed at the camp you stand in. */
  private async fromPack(d: { action: 'set' | 'place' | 'plant'; itemId?: string; itemDef?: string }): Promise<void> {
    const hero = this.deps.hero()
    const feet = { tx: Math.floor(hero.x / TILE), ty: Math.floor((hero.y - 1) / TILE) }
    const here = campAtTile(campsUi.list, feet.tx, feet.ty)
    const spot = campSpot(feet, (x, y) => this.open(x, y), here ? campTaken(here) : new Set())
    if (!spot) {
      bus.emit(EV.toast, { text: homeErrorText('land-blocked'), icon: 'glim', kind: 'error' })
      return
    }
    const done = d.action === 'set' ? 'The way-lamp is lit. The woods in its light hold through the turning while it has oil.' : d.action === 'plant' ? 'Planted, in the lamp’s light.' : 'Set out at the camp.'
    await this.act({ action: d.action, itemId: d.itemId ?? '', itemDef: d.itemDef ?? '', x: spot.tx, y: spot.ty }, () => bus.emit(EV.toast, { text: done, icon: 'glim' }))
  }

  private async act(fields: { action: string; camp?: string; itemId?: string; itemDef?: string; x?: number; y?: number; rotation?: number }, then?: (c: CampView | null) => void): Promise<void> {
    const link = this.deps.session.link
    if (!link || this.busy) return
    this.busy = true
    this.deps.notePosition()
    try {
      const r = await link.camp({ camp: '', itemId: '', itemDef: '', x: 0, y: 0, rotation: 0, ...fields })
      if (!r.ok) {
        sfx('fizzle')
        bus.emit(EV.toast, { text: CAMP_ERRORS[r.code] ?? homeErrorText(r.code), icon: 'glim', kind: 'error' })
        return
      }
      sfx(fields.action === 'set' || fields.action === 'fill' ? 'lantern' : 'pop')
      void itemsFor(this.deps.session).load()
      void homesteadsFor(this.deps.session).load()
      const c = r.result.camp ?? null
      const list = campsUi.list.filter((x) => x.id !== c?.id && !(fields.action === 'remove' && fields.itemId === x.id))
      this.adopt(c ? [...list, c] : list)
      then?.(c)
    } finally {
      this.busy = false
    }
  }

  // ------------------------------------------------------------ playtests

  debug(): { camps: CampView[]; spot: { tx: number; ty: number } | null } {
    const hero = this.deps.hero()
    const feet = { tx: Math.floor(hero.x / TILE), ty: Math.floor((hero.y - 1) / TILE) }
    const here = campAtTile(campsUi.list, feet.tx, feet.ty)
    return { camps: campsUi.list, spot: campSpot(feet, (x, y) => this.open(x, y), here ? campTaken(here) : new Set()) }
  }
}
