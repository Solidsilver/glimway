/**
 * Communal lamps on the open map (roadmap 0.13; docs/design/lamps.md §1.3,
 * §2.4): Lantern Road stones someone relit, their relit frames drawn over
 * the chunk's dark stone, and way-lamps set as communal posts. The Keeper's-
 * hand quest stone is drawn as the route stone, dark or relit. Look at a dark stone (./sites.ts
 * sends EV.lampStoneLook) to light it with a lamp wick; look at a lit lamp
 * to tend it (the visit counts this wick), and at your own post to take it
 * down. From the pack (EV.communalPost): set a carried way-lamp beside you
 * as a communal post.
 *
 * The Keeper's hand (lamps.md 2.8): the quest's stone (the read's cut_stone)
 * shows its cut, and once Mara asks, you copy it. A Keeper names a lamp
 * from parts (EV.lampNamingOpen, answered on EV.lampNamed) or reads one
 * someone else named; any of those, or tending, finishes the quest.
 *
 * Read from GET /api/communal-lamps (no socket message carries them): on
 * walking into another chunk, every half minute, and after each of your own
 * lamp operations. Drawn for the chunks around the hero.
 */
import Phaser from 'phaser'
import type { CommunalLampView } from '../../lib/gen/glimway/v1/lamps_pb.js'
import { COMMUNAL_LAMP_DONE, COMMUNAL_LAMP_ERRORS, COMMUNAL_POST_FRAME, ROUTE_STONE_ORIGIN_X, canLift, canRelight, communalLampLines, communalLampName, darkStoneLines, lampTiles, lampsNear, litStone, relightCost, roadStoneArt } from '../../lib/communal-lamps.ts'
import { campSpot } from '../../lib/camps.ts'
import { HOMESTEAD_DATA } from '../../lib/homestead.ts'
import { TERRAIN, TILE, tileFeet } from '../../lib/tile.ts'
import { chunkOf } from '../../lib/wilds/coords.ts'
import { loadWilds } from '../../lib/wilds/data.ts'
import { homeErrorText } from '../../content/errors.ts'
import { LAMP_NAMING } from '../../content/lamp-naming.ts'
import { isKeeper } from '../../lib/lamp-naming.ts'
import { bus, EV } from '../events.ts'
import { openDialogue } from '../dialogue.ts'
import { sfx } from '../sfx.ts'
import type { Session } from '../session.ts'
import type { Interactables } from '../entities/interactables.ts'
import type { DialogueChoice } from '../../content/world.ts'
import { solidBox } from '../area/collision.ts'
import { drawScale } from '../hearthwick2-art.ts'
import { omArt } from './open-map-art.ts'
import { itemsFor } from '../items.ts'
import { homesteadsFor } from '../homestead.ts'
import { groundAt, solidAt } from './ground-view.ts'
import { chunkTerrain } from './store.ts'
import { chunkOrigin } from './terrain.ts'
import { wildsPoint } from './sites.ts'

export interface CommunalLampsDeps {
  session: Session
  interactables: Interactables
  solids: Phaser.Physics.Arcade.StaticGroup
  hero: () => { x: number; y: number }
  notePosition: () => void
  reducedMotion: boolean
}

/** How often the lamps are read again while you stand still (ms). */
const READ_EVERY_MS = 30_000
/** The warm light of a lit lamp. */
const LAMPLIGHT = 0xffb054
/** A lamp stone's niche, world px above its foot (the relit wick fills texel rows 44..63 of 128). */
const STONE_NICHE_Y = 19

export class WildsCommunalLamps {
  private lamps: CommunalLampView[] = []
  private images: Phaser.GameObjects.GameObject[] = []
  private tweens: Phaser.Tweens.Tween[] = []
  private bodies: Phaser.Physics.Arcade.Image[] = []
  private drawnFor = ''
  private readAt = 0
  private reading = false
  private version = 0
  private busy = false
  /** The Keeper's-hand quest's stone (the read's cut_stone). */
  private cutStone = ''
  /** The road stones drawn over the chunks' dark ones, for playtests. */
  private stones: { site: string; frame: string }[] = []

  constructor(private scene: Phaser.Scene, private deps: CommunalLampsDeps) {
    const onPost = (d: { itemId: string }) => void this.post(d.itemId)
    const onStone = (d: { site: string }) => this.lookStone(d.site)
    const onNamed = (d: { lamp: string; kind: string; parts: string[] | null }) => {
      if (d.kind === 'communal' && d.parts) void this.act({ action: 'name', lamp: d.lamp, parts: d.parts }, () => bus.emit(EV.toast, { text: LAMP_NAMING.named, icon: 'lantern' }))
    }
    bus.on(EV.communalPost, onPost)
    bus.on(EV.lampStoneLook, onStone)
    bus.on(EV.lampNamed, onNamed)
    scene.events.once('shutdown', () => {
      bus.off(EV.communalPost, onPost)
      bus.off(EV.lampStoneLook, onStone)
      bus.off(EV.lampNamed, onNamed)
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
      // A new chunk: read again (someone may have lit a lamp out here).
      if (!this.drawnFor.endsWith(`|${at.cx},${at.cy}`)) this.readAt = 0
      this.drawnFor = key
      this.draw(at.cx, at.cy)
    }
    if (now >= this.readAt && !this.reading) {
      this.readAt = now + READ_EVERY_MS
      void this.read()
    }
  }

  /** Read the lamps again now. */
  async read(): Promise<void> {
    const link = this.deps.session.link
    if (!link) return
    this.reading = true
    try {
      const r = await link.communalLampsRead()
      if (r.ok) {
        this.cutStone = r.value.cutStone
        this.adopt(r.value.lamps)
      }
    } finally {
      this.reading = false
    }
  }

  private adopt(list: CommunalLampView[]): void {
    this.lamps = list
    this.version++
  }

  // ------------------------------------------------------------ drawing

  private clear(): void {
    for (const t of this.tweens) t.stop()
    for (const o of this.images) o.destroy()
    for (const b of this.bodies) {
      // Phaser may destroy the static group before the scene's shutdown reaches the lamps.
      if (this.deps.solids.children) this.deps.solids.remove(b, true, true)
      else b.destroy()
    }
    this.tweens = []
    this.images = []
    this.bodies = []
    this.stones = []
  }

  /**
   * A road stone's art over the dark stone its chunk draws (./sites.ts), at
   * the same foot point: relit, or the quest stone's route stone. A plain
   * dark stone needs nothing more.
   */
  private drawStone(site: string, at: { x: number; y: number }, lit: boolean): void {
    const art = roadStoneArt(site, this.cutStone, lit)
    if (!art.route && !lit) return
    const key = omArt(art.frame)
    if (!this.scene.textures.exists(key)) return
    const loop = art.loop ? omArt(art.loop) : null
    const img = loop && !this.deps.reducedMotion && this.scene.anims.exists(loop) ? this.scene.add.sprite(at.x, at.y, key).play(loop) : this.scene.add.image(at.x, at.y, key)
    img.setOrigin(art.route ? ROUTE_STONE_ORIGIN_X : 0.5, 1).setDepth(at.y - 1)
    this.images.push(img)
    this.stones.push({ site, frame: art.frame })
  }

  /** The quest stone's tile, when its chunk is one of those drawn around the hero. */
  private cutStoneAt(cx: number, cy: number): { x: number; y: number } | null {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const t = chunkTerrain(cx + dx, cy + dy)
        const s = t?.sites.find((x) => x.id === this.cutStone && x.kind === 'lamp-stone')
        if (!t || !s) continue
        const o = chunkOrigin(t)
        return tileFeet(o.tx + s.tx, o.ty + s.ty)
      }
    }
    return null
  }

  private draw(cx: number, cy: number): void {
    this.clear()
    const points = []
    // The quest stone while it's dark (lit, it's drawn with the lamps below).
    const cut = this.cutStone && !litStone(this.lamps, this.cutStone) ? this.cutStoneAt(cx, cy) : null
    if (cut) this.drawStone(this.cutStone, cut, false)
    for (const l of lampsNear(this.lamps, cx, cy)) {
      const at = tileFeet(l.x, l.y)
      if (l.kind === 'post') {
        // The post itself (the stone is the road's, drawn with its chunk's sites).
        const key = omArt(COMMUNAL_POST_FRAME)
        if (this.scene.textures.exists(key)) {
          const img = this.scene.add.image(at.x, at.y, key).setOrigin(0.5, 1).setScale(drawScale(key)).setDepth(at.y)
          img.setData('communal-lamp', l.id)
          this.images.push(img)
        }
        const body = solidBox(this.scene, at.x, at.y - TILE / 2, TILE - 6, TILE - 6)
        this.deps.solids.add(body)
        this.bodies.push(body)
        points.push({ ...wildsPoint(`communal-lamp:${l.id}`, at, 30, () => ({ label: l.naming?.shortName ? `Look at ${l.naming.shortName}` : `Look at the ${communalLampName(l).toLowerCase()}`, verb: 'Look', claim: () => this.look(l.id) })), rank: 0 })
      } else this.drawStone(l.id, at, true)
      // Its light, over the stone's small wick or the post's lamp: the relit
      // flame is a few texels, so the glow is what reads at play zoom.
      const glow = this.scene.add.image(at.x, at.y - (l.kind === 'stone' ? STONE_NICHE_Y : 22), 'glow').setBlendMode(Phaser.BlendModes.ADD).setTint(LAMPLIGHT).setScale(0.55).setAlpha(0.8).setDepth(4001)
      this.images.push(glow)
      if (!this.deps.reducedMotion) this.tweens.push(this.scene.tweens.add({ targets: glow, alpha: { from: 0.8, to: 0.55 }, duration: 1400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' }))
    }
    this.deps.interactables.register(this, points)
  }

  // ------------------------------------------------------------ talking

  private wicksCarried(): number {
    const def = HOMESTEAD_DATA.communalLamp.relight
    return itemsFor(this.deps.session).view?.stacks.filter((x) => x.itemDef === def).reduce((n, x) => n + x.qty, 0) ?? 0
  }

  private get keeper(): boolean {
    return isKeeper(this.deps.session.state.flags)
  }

  /** Mara has asked for this stone's cut, and it isn't copied yet. */
  private wantsCut(site: string): boolean {
    return site === this.cutStone && this.deps.session.quests['keepers-hand'] === 'hear-mara'
  }

  /** The cut, on the quest's stone; nothing on any other. */
  private cutLines(site: string): string[] {
    return site === this.cutStone ? [...LAMP_NAMING.cutLines] : []
  }

  /** A road stone: lit (tend it), or dark (light it). */
  lookStone(site: string): void {
    const lit = litStone(this.lamps, site)
    if (lit) return this.look(lit.id)
    const cost = relightCost()
    const ok = canRelight(this.wicksCarried())
    const choices: DialogueChoice[] = [
      { text: cost ? `Light it with ${cost}` : 'Light it', action: `communal-lamp:relight:${site}`, disabled: !ok, ...(ok ? {} : { note: 'You need a lamp wick' }) },
      ...(this.wantsCut(site) ? [{ ...LAMP_NAMING.copy, action: `communal-lamp:copy:${site}` }] : []),
      { text: 'Leave it' }
    ]
    openDialogue({ id: 'communal-lamp', speaker: 'Lamp stone', lines: [...darkStoneLines(loadWilds().words.lampStone), ...this.cutLines(site)], choices })
  }

  /** A lit lamp: its naming or label, who lit it, the coming turning; tend it, or take your post down. */
  look(id: string): void {
    const l = this.lamps.find((x) => x.id === id)
    if (!l) return
    const choices: DialogueChoice[] = [{ text: 'Tend it', note: 'Trim the wick: your visit counts this wick', action: `communal-lamp:tend:${l.id}` }]
    if (this.wantsCut(l.id)) choices.push({ ...LAMP_NAMING.copy, action: `communal-lamp:copy:${l.id}` })
    if (this.keeper && !l.naming) choices.push({ ...LAMP_NAMING.name, action: `communal-lamp:name:${l.id}` })
    if (this.keeper && l.naming) choices.push({ ...LAMP_NAMING.read, action: `communal-lamp:read:${l.id}` })
    if (canLift(l, this.me)) choices.push({ text: 'Take your lamp down', note: 'It goes back in your pack', action: `communal-lamp:lift:${l.id}` })
    choices.push({ text: 'Leave it' })
    // A named stone shows its naming; the quest's stone shows Wenna's cut beside it.
    openDialogue({ id: 'communal-lamp', speaker: communalLampName(l), lines: [...communalLampLines(l, this.me), ...this.cutLines(l.id)], choices })
  }

  /** A choice picked in a lamp's talk (WorldActions routes `communal-lamp:` here). */
  onAction(rest: string): void {
    const i = rest.indexOf(':')
    const what = rest.slice(0, i), id = rest.slice(i + 1)
    if (!id) return
    if (what === 'name') return void this.beginNaming(id)
    if (what === 'copy') return void this.act({ action: 'copy', lamp: id }, () => bus.emit(EV.toast, { text: LAMP_NAMING.copied, icon: 'bag' }))
    if (what === 'read') return void this.act({ action: 'read', lamp: id }, () => bus.emit(EV.toast, { text: LAMP_NAMING.readDone, icon: 'lantern' }))
    if (what !== 'relight' && what !== 'tend' && what !== 'lift') return
    void this.act({ action: what, lamp: id }, () => bus.emit(EV.toast, { text: COMMUNAL_LAMP_DONE[what], icon: 'lantern' }))
  }

  /** A Keeper's naming: the landmarks around this lamp, then the panel (answered on EV.lampNamed). */
  private async beginNaming(id: string): Promise<void> {
    const link = this.deps.session.link
    if (!link) return
    const r = await link.lampLandmarksRead(id)
    if (!r.ok) {
      bus.emit(EV.toast, { text: COMMUNAL_LAMP_ERRORS[r.code] ?? homeErrorText(r.code), icon: 'glim', kind: 'error' })
      return
    }
    bus.emit(EV.lampNamingOpen, { lamp: id, kind: 'communal', landmarks: r.value.landmarks.map((m) => ({ id: m.id, phrase: m.phrase })) })
  }

  // ------------------------------------------------------------ doing

  /** Open ground beside you, as the client knows it (the server checks again). */
  private open(tx: number, ty: number): boolean {
    const g = groundAt(tx, ty)
    return !solidAt(tx, ty) && g !== null && g !== TERRAIN.water_a && g !== TERRAIN.water_b && g !== TERRAIN.bridge
  }

  /** From the pack: a carried way-lamp set down beside you as a communal post. */
  private async post(itemId: string): Promise<void> {
    const hero = this.deps.hero()
    const feet = { tx: Math.floor(hero.x / TILE), ty: Math.floor((hero.y - 1) / TILE) }
    const spot = campSpot(feet, (x, y) => this.open(x, y), lampTiles(this.lamps))
    if (!spot) {
      bus.emit(EV.toast, { text: COMMUNAL_LAMP_ERRORS['land-blocked']!, icon: 'glim', kind: 'error' })
      return
    }
    await this.act({ action: 'post', itemId, x: spot.tx, y: spot.ty }, () => bus.emit(EV.toast, { text: COMMUNAL_LAMP_DONE.post, icon: 'lantern' }))
  }

  private async act(fields: { action: string; lamp?: string; itemId?: string; x?: number; y?: number; parts?: string[] }, then?: () => void): Promise<void> {
    const link = this.deps.session.link
    if (!link || this.busy) return
    this.busy = true
    this.deps.notePosition()
    try {
      const r = await link.communalLamp({ lamp: '', itemId: '', x: 0, y: 0, parts: [], ...fields })
      if (!r.ok) {
        sfx('fizzle')
        bus.emit(EV.toast, { text: COMMUNAL_LAMP_ERRORS[r.code] ?? homeErrorText(r.code), icon: 'glim', kind: 'error' })
        return
      }
      sfx(fields.action === 'lift' || fields.action === 'copy' ? 'pop' : 'lantern')
      void itemsFor(this.deps.session).load()
      if (fields.action === 'post' || fields.action === 'lift') void homesteadsFor(this.deps.session).load()
      const l = r.result.lamp ?? null
      const gone = fields.action === 'lift' ? fields.lamp : undefined
      this.adopt([...this.lamps.filter((x) => x.id !== l?.id && x.id !== gone), ...(l ? [l] : [])])
      then?.()
    } finally {
      this.busy = false
    }
  }

  // ------------------------------------------------------------ playtests

  debug(): { lamps: { id: string; kind: string; x: number; y: number; visited: boolean; name: string }[]; stones: { site: string; frame: string }[] } {
    return { lamps: this.lamps.map((l) => ({ id: l.id, kind: l.kind, x: l.x, y: l.y, visited: l.visited, name: communalLampName(l) })), stones: [...this.stones] }
  }
}
