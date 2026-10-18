/**
 * Camps on the open map (roadmap 0.13; docs/design/lamps.md §2.5, §2.7): a
 * way-lamp someone set in the Wilds, burning or guttering, with the pieces
 * and plants set out in its light. Look at the lamp for its oil and top it
 * up; its setter (the keeper) takes it down once the camp is empty, or packs
 * the whole camp off to Pell's, and says who may build there. Pick up a
 * piece of yours; the keeper may move anyone else's off to Pell's. Anyone may
 * look at a plant; with a trowel in hand, dig one up if you may build there,
 * or if you planted it. From the pack (EV.campDo): set a carried way-lamp
 * down beside you, or a piece or a seed at the camp you stand in.
 *
 * Read from GET /api/camps (no socket message carries camps): on walking
 * into another chunk, every half minute, and after each of your own camp
 * operations. Drawn for the chunks around the hero.
 */
import Phaser from 'phaser'
import type { CampResult, CampView } from '../../lib/gen/glimway/v1/camps_pb.js'
import { CAMP_ERRORS, CAMP_RULES, campAtTile, campFrame, campHasRoom, campLampName, campLines, campLook, campNameable, campPieceName, campPlantLines, campRefusal, ownerName, campRule, campRuleLines, campSpot, campTaken, movedOffLine, moveOffLines, ruleNames, withMember, withoutMember, type CampRule } from '../../lib/camps.ts'
import { dugUpLine, plantOffer } from '../../lib/trowel.ts'
import { heldNow } from '../held.ts'
import { HOMESTEAD_DATA, homeItem, rotatedFootprint } from '../../lib/homestead.ts'
import { TILE, tileFeet } from '../../lib/tile.ts'
import { chunkOf } from '../../lib/wilds/coords.ts'
import { homeErrorText } from '../../content/errors.ts'
import { CAMP_PACK_WORDS, CAMP_PLANT_CHOICES, CAMP_RULE_WORDS, CAMP_WORDS, LAMP_OIL } from '../../content/camps.ts'
import { LAMP_NAMING } from '../../content/lamp-naming.ts'
import { isKeeper } from '../../lib/lamp-naming.ts'
import { adoptCamps, campsKnown, type CampsKnown, type CampsOwner } from './camps-state.ts'
import { bus, EV } from '../events.ts'
import { openDialogue } from '../dialogue.ts'
import { sfx } from '../sfx.ts'
import type { Session } from '../session.ts'
import type { Interactables } from '../entities/interactables.ts'
import type { DialogueChoice } from '../../content/world.ts'
import { solidBox } from '../area/collision.ts'
import { decoFlat, decoKey } from '../commons-art.ts'
import { drawScale } from '../hearthwick2-art.ts'
import { itemIcon, itemsFrame, itemWorldArt } from '../items-pass.ts'
import { omArt } from './open-map-art.ts'
import { itemsFor } from '../items.ts'
import { homesteadsFor } from '../homestead.ts'
import { groundAt, solidAt } from './ground-view.ts'
import { invalidateLand, refreshNear } from './store.ts'
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
/** Camp operations that can change a chunk's hold (a piece picked up is a `remove` too: asking again costs one status read). */
const LAND_ACTIONS = new Set(['set', 'fill', 'pack', 'remove'])

/** Whose camps a read through `link` is: its world and account as it was asked (a move changes the link's world). */
const ownerOf = (link: CampsOwner): CampsOwner => ({ worldId: link.worldId, accountId: link.accountId })

export class WildsCamps {
  private images: Phaser.GameObjects.GameObject[] = []
  private bodies: Phaser.Physics.Arcade.Image[] = []
  private drawnFor = ''
  private readAt = 0
  private reading = false
  private version = 0
  private busy = false
  /** The scene this controller was built for has shut down: an answer arriving later opens no panel and plays no sound (its toast is still told). */
  private gone = false

  constructor(private scene: Phaser.Scene, private deps: CampsDeps) {
    const onDo = (d: { action: 'set' | 'place' | 'plant'; itemId?: string; itemDef?: string }) => void this.fromPack(d)
    // A Keeper's naming of the lamp, from the naming panel (lamps.md 2.8).
    const onNamed = (d: { lamp: string; kind: string; parts: string[] | null }) => {
      if (d.kind === 'camp' && d.parts) void this.act({ action: 'name', camp: d.lamp, parts: d.parts }, () => bus.emit(EV.toast, { text: LAMP_NAMING.named, icon: 'lantern' }))
    }
    bus.on(EV.campDo, onDo)
    bus.on(EV.lampNamed, onNamed)
    scene.events.once('shutdown', () => {
      this.gone = true
      bus.off(EV.campDo, onDo)
      bus.off(EV.lampNamed, onNamed)
      this.clear()
      deps.interactables.register(this, [])
    })
  }

  private get me(): string | null {
    return this.deps.session.link?.accountId ?? null
  }

  /** The camps as read in this session's world (none before its first read). */
  private get known() {
    return campsKnown(this.deps.session.link)
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
    const owner = ownerOf(link)
    this.reading = true
    try {
      const r = await link.campsRead()
      // A departed scene's read could land after the next world's: it keeps nothing.
      if (!r.ok || this.gone) return
      this.adopt(owner, r.value.camps, r.value.people)
    } finally {
      this.reading = false
    }
  }

  /** Keep a list read (or answered) for `owner`'s world; the drawing follows. */
  private adopt(owner: CampsOwner, list: CampView[], people?: CampsKnown['people']): void {
    adoptCamps(owner, { list, me: owner.accountId, ...(people ? { people } : {}) })
    this.version++
  }

  // ------------------------------------------------------------ drawing

  private clear(): void {
    for (const o of this.images) o.destroy()
    for (const b of this.bodies) {
      // Phaser may destroy the static group before the scene's shutdown reaches the camps.
      if (this.deps.solids.children) this.deps.solids.remove(b, true, true)
      else b.destroy()
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
    for (const c of this.known.list) {
      if (Math.abs(c.cx - cx) > 1 || Math.abs(c.cy - cy) > 1) continue
      for (const p of c.pieces) {
        if (p.id === c.id) continue
        this.drawPiece(p.itemDef, p.x, p.y, p.rotation)
        if (p.ownerId === this.me) {
          const at = tileFeet(p.x, p.y)
          points.push(wildsPoint(`camp-piece:${p.id}`, at, 20, () => ({ label: CAMP_WORDS.pickUp(campPieceName(p.itemDef)), verb: 'Pick up', claim: () => void this.act({ action: 'remove', itemId: p.id }) })))
        } else if (c.setterId === this.me) {
          // The keeper may move someone's piece off: it waits at Pell's, still theirs.
          const at = tileFeet(p.x, p.y)
          points.push(wildsPoint(`camp-piece:${p.id}`, at, 20, () => ({ label: CAMP_WORDS.moveOff(ownerName(this.known.people, p), campPieceName(p.itemDef)), verb: 'Move off', claim: () => this.askMoveOff(p.id) })))
        }
      }
      for (const p of c.plants) {
        const at = tileFeet(p.x, p.y)
        const key = itemIcon(p.itemDef)
        if (this.scene.textures.exists(key)) this.images.push(this.scene.add.image(at.x, at.y, key).setOrigin(0.5, 1).setDepth(at.y))
        // Anyone may look at it. Anyone who may build here can dig it up, with a trowel in hand; whoever planted it always can.
        const mayDig = c.builder || p.ownerId === this.me
        points.push(wildsPoint(`camp-plant:${p.id}`, at, 20, () => {
          const offer = plantOffer(campPieceName(p.itemDef), heldNow().kind, mayDig, true)
          return offer && { label: offer.label, verb: offer.verb, claim: () => (offer.dig ? this.uproot(p.id) : this.lookPlant(p.id, mayDig)) }
        }))
      }
      // The lamp itself: lit, or dimming once its oil is gone (on its last wick, then guttering).
      const at = tileFeet(c.x, c.y)
      const key = omArt(campFrame(campLook(c)))
      if (this.scene.textures.exists(key)) {
        const img = this.scene.add.image(at.x, at.y, key).setOrigin(0.5, 1).setScale(drawScale(key)).setDepth(at.y)
        img.setData('camp', c.id)
        this.images.push(img)
      }
      const glow = this.scene.add.image(at.x, at.y - 22, 'glow').setBlendMode(Phaser.BlendModes.ADD).setScale(campLook(c) === 'dimming' ? 0.35 : 0.6).setAlpha(campLook(c) === 'dimming' ? 0.45 : 0.8).setDepth(4001)
      this.images.push(glow)
      this.body(at.x, at.y - TILE / 2, TILE - 6, TILE - 6)
      points.push({ ...wildsPoint(`camp:${c.id}`, at, 30, () => ({ label: CAMP_WORDS.look(c.naming?.shortName ?? ''), verb: 'Look', claim: () => this.look(c.id) })), rank: 0 })
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
    return this.known.list.find((c) => c.id === id) ?? null
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
      choices.push({ text: LAMP_OIL.topUp, action: `camp:fill:${c.id}`, disabled: oil < 1, ...(oil < 1 ? { note: LAMP_OIL.needOil } : {}) })
    }
    if (c.builder && !c.naming && isKeeper(this.deps.session.state.flags)) choices.push({ ...LAMP_NAMING.name, action: `camp:name:${c.id}` })
    if (c.setterId === this.me) choices.push({ text: CAMP_RULE_WORDS.heading, note: CAMP_RULE_WORDS.rules[campRule(c)].pick, action: `camp:rules:${c.id}` })
    if (c.setterId === this.me && c.pieces.length === 1 && c.plants.length === 0) choices.push({ ...CAMP_WORDS.takeDown, action: `camp:down:${c.id}` })
    else if (c.setterId === this.me) choices.push({ ...CAMP_PACK_WORDS.pack, action: `camp:pack:${c.id}` })
    choices.push({ text: CAMP_WORDS.leave })
    openDialogue({ id: 'camp', speaker: campLampName(c), lines: campLines(c, this.me), choices })
  }

  /** The keeper's "pack up the camp", asked once more before everything goes to Pell's. */
  private askPack(id: string): void {
    const c = this.camp(id)
    if (!c || c.setterId !== this.me) return
    openDialogue({ id: 'camp', speaker: campLampName(c), lines: [...CAMP_PACK_WORDS.ask], choices: [{ text: CAMP_PACK_WORDS.confirm, action: `camp:packup:${c.id}` }, { text: CAMP_PACK_WORDS.keep, dismiss: true }] })
  }

  /** A plant at the camp: whose it is (digging it up is the trowel's, never a choice here). */
  private lookPlant(plantId: string, mayDig: boolean): void {
    const c = this.known.list.find((x) => x.plants.some((p) => p.id === plantId))
    const p = c?.plants.find((x) => x.id === plantId)
    if (!c || !p) return
    const name = campPieceName(p.itemDef)
    const owner = p.ownerId === this.me ? null : ownerName(this.known.people, p)
    openDialogue({ id: 'camp', speaker: name, lines: campPlantLines(name, owner, mayDig), choices: [...CAMP_PLANT_CHOICES] })
  }

  /** The trowel at a camp plant: up it comes whole, into your pack to plant again. */
  private uproot(plantId: string): void {
    const p = this.known.list.flatMap((x) => x.plants).find((x) => x.id === plantId)
    const name = p ? campPieceName(p.itemDef) : ''
    void this.act({ action: 'uproot', itemId: plantId }, (_c, res) => { if (name) bus.emit(EV.toast, { text: dugUpLine(name, res.wear), icon: 'glim' }) })
  }

  /** The keeper's "Who may build here": the four rules, and the list when the rule reads it. */
  private rules(id: string): void {
    const c = this.camp(id)
    if (!c || c.setterId !== this.me) return
    const rule = campRule(c)
    const choices: DialogueChoice[] = CAMP_RULES.map((r) =>
      r === rule ? { text: CAMP_RULE_WORDS.rules[r].pick, note: CAMP_RULE_WORDS.now, disabled: true } : { text: CAMP_RULE_WORDS.rules[r].pick, action: `camp:rule:${c.id}:${r}` })
    if (ruleNames(rule)) {
      const more = campNameable(c, this.known.people).length > 0
      choices.push({ text: CAMP_RULE_WORDS.name, action: `camp:pick:${c.id}`, disabled: !more, ...(more ? {} : { note: CAMP_RULE_WORDS.noneToName }) })
      for (const m of c.members) choices.push({ text: CAMP_RULE_WORDS.unname(m.name), action: `camp:unname:${c.id}:${m.accountId}` })
    }
    choices.push({ text: CAMP_RULE_WORDS.done, dismiss: true })
    openDialogue({ id: 'camp-rules', speaker: CAMP_RULE_WORDS.heading, lines: campRuleLines(c), choices })
  }

  /** Whom to put on the list: the world's members not on it yet. */
  private pickWho(id: string): void {
    const c = this.camp(id)
    if (!c) return
    const choices: DialogueChoice[] = campNameable(c, this.known.people).map((p) => ({ text: p.name, action: `camp:add:${c.id}:${p.accountId}` }))
    choices.push({ text: CAMP_WORDS.neverMind, action: `camp:rules:${c.id}` })
    openDialogue({ id: 'camp-rules', speaker: CAMP_RULE_WORDS.heading, lines: [CAMP_RULE_WORDS.pickWho], choices })
  }

  /** Send the rule and the list; the panel opens again on what the server kept. */
  private setRule(id: string, rule: CampRule, members: string[]): void {
    void this.act({ action: 'rule', camp: id, rule, members }, (c) => { if (c && !this.gone) this.rules(c.id) })
  }

  /** Asked before the keeper moves someone's piece off to Pell's. */
  private askMoveOff(pieceId: string): void {
    const c = this.known.list.find((x) => x.pieces.some((p) => p.id === pieceId))
    const p = c?.pieces.find((x) => x.id === pieceId)
    if (!c || !p) return
    const owner = ownerName(this.known.people, p)
    openDialogue({ id: 'camp', speaker: campLampName(c), lines: moveOffLines(owner, campPieceName(p.itemDef)), choices: [{ text: CAMP_WORDS.sendToPell, action: `camp:moveoff:${pieceId}` }, { text: CAMP_WORDS.leave, dismiss: true }] })
  }

  /** A choice picked in the lamp's talk (WorldActions routes `camp:` here). */
  onAction(rest: string): void {
    const [what, id, arg] = rest.split(':')
    if (!id) return
    const c = this.camp(id)
    if (what === 'rules') return this.rules(id)
    if (what === 'pick') return this.pickWho(id)
    if (what === 'rule' && c && arg && (CAMP_RULES as readonly string[]).includes(arg)) return this.setRule(id, arg as CampRule, c.members.map((m) => m.accountId))
    if (what === 'add' && c && arg) return this.setRule(id, campRule(c), withMember(c, arg))
    if (what === 'unname' && c && arg) return this.setRule(id, campRule(c), withoutMember(c, arg))
    if (what === 'moveoff') {
      const camp = this.known.list.find((x) => x.pieces.some((p) => p.id === id))
      const p = camp?.pieces.find((x) => x.id === id)
      const said = p ? movedOffLine(ownerName(this.known.people, p), campPieceName(p.itemDef)) : ''
      return void this.act({ action: 'remove', itemId: id }, () => { if (said) bus.emit(EV.toast, { text: said, icon: 'glim' }) })
    }
    if (what === 'pack') return this.askPack(id)
    if (what === 'packup') return void this.act({ action: 'pack', camp: id }, () => bus.emit(EV.toast, { text: CAMP_PACK_WORDS.done, icon: 'glim' }))
    if (what === 'fill') void this.act({ action: 'fill', camp: id }, (c) => { if (c && !this.gone) openDialogue({ id: 'camp', speaker: campLampName(c), lines: campLines(c, this.me) }) })
    else if (what === 'name') void this.beginNaming(id)
    else if (what === 'down') void this.act({ action: 'remove', itemId: id }, () => bus.emit(EV.toast, { text: CAMP_WORDS.takenDown, icon: 'glim' }))
  }

  /** A Keeper's naming: the landmarks around the lamp, then the panel (answered on EV.lampNamed). */
  private async beginNaming(id: string): Promise<void> {
    const link = this.deps.session.link
    if (!link) return
    const r = await link.lampLandmarksRead(id)
    // Walked off (a door, a world move) while it was read: the panel would be for a lamp left behind.
    if (this.gone || this.deps.session.link !== link) return
    if (!r.ok) {
      bus.emit(EV.toast, { text: CAMP_ERRORS[r.code] ?? homeErrorText(r.code), icon: 'glim', kind: 'error' })
      return
    }
    bus.emit(EV.lampNamingOpen, { lamp: id, kind: 'camp', landmarks: r.value.landmarks.map((m) => ({ id: m.id, phrase: m.phrase })) })
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
    const here = campAtTile(this.known.list, feet.tx, feet.ty)
    const spot = campSpot(feet, (x, y) => this.open(x, y), here ? campTaken(here) : new Set())
    if (!spot) {
      bus.emit(EV.toast, { text: homeErrorText('land-blocked'), icon: 'glim', kind: 'error' })
      return
    }
    const done = d.action === 'set' ? CAMP_WORDS.lit : d.action === 'plant' ? CAMP_WORDS.planted : CAMP_WORDS.setOut
    await this.act({ action: d.action, itemId: d.itemId ?? '', itemDef: d.itemDef ?? '', x: spot.tx, y: spot.ty }, () => bus.emit(EV.toast, { text: done, icon: 'glim' }))
  }

  /** The camp an operation was about: named, holding its piece, or at its tile. */
  private campOf(fields: { camp?: string; itemId?: string; x?: number; y?: number }): CampView | null {
    return (fields.camp ? this.camp(fields.camp) : null)
      ?? this.known.list.find((c) => c.pieces.some((p) => p.id === fields.itemId) || c.plants.some((p) => p.id === fields.itemId))
      ?? (fields.x !== undefined && fields.y !== undefined ? campAtTile(this.known.list, fields.x, fields.y) : null)
  }

  private async act(fields: { action: string; camp?: string; itemId?: string; itemDef?: string; x?: number; y?: number; rotation?: number; parts?: string[]; rule?: string; members?: string[] }, then?: (c: CampView | null, res: CampResult) => void): Promise<void> {
    const link = this.deps.session.link
    if (!link || this.busy) return
    this.busy = true
    this.deps.notePosition()
    try {
      const r = await link.camp({ camp: '', itemId: '', itemDef: '', x: 0, y: 0, rotation: 0, parts: [], rule: '', members: [], ...fields })
      // A refusal, or no answer yet (`pending`), is told even after a door: only the sound stays with the scene.
      if (!r.ok) {
        if (!this.gone) sfx('fizzle')
        const text = r.code === 'not-your-camp' ? campRefusal(this.campOf(fields)) : CAMP_ERRORS[r.code] ?? homeErrorText(r.code)
        bus.emit(EV.toast, { text, icon: 'glim', kind: 'error' })
        return
      }
      void itemsFor(this.deps.session).load()
      void homesteadsFor(this.deps.session).load()
      const c = r.result.camp ?? null
      // Setting, filling, packing or taking down a lamp changes the land around it (the HUD's land chip).
      if (LAND_ACTIONS.has(fields.action)) invalidateLand()
      // A way-lamp set pushes the frontier out (lamps.md 2.2): read it now, not at the next chunk.
      if (fields.action === 'set' && fields.x !== undefined && fields.y !== undefined) {
        const at = chunkOf(fields.x, fields.y)
        void refreshNear(this.deps.session, at.cx, at.cy).catch(() => false)
      }
      // The scene it was asked in has gone: the next scene reads the camps itself; the outcome's toast is still told, its panel isn't (`then` checks).
      if (!this.gone) {
        sfx(fields.action === 'set' || fields.action === 'fill' ? 'lantern' : 'pop')
        const list = this.known.list.filter((x) => x.id !== c?.id && !(fields.action === 'remove' && fields.itemId === x.id) && !(fields.action === 'pack' && fields.camp === x.id))
        this.adopt(ownerOf(link), c ? [...list, c] : list)
      }
      then?.(c, r.result)
    } finally {
      this.busy = false
    }
  }

  // ------------------------------------------------------------ playtests

  debug(): { camps: CampView[]; spot: { tx: number; ty: number } | null } {
    const hero = this.deps.hero()
    const feet = { tx: Math.floor(hero.x / TILE), ty: Math.floor((hero.y - 1) / TILE) }
    const here = campAtTile(this.known.list, feet.tx, feet.ty)
    return { camps: this.known.list, spot: campSpot(feet, (x, y) => this.open(x, y), here ? campTaken(here) : new Set()) }
  }
}
