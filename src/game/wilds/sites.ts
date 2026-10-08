/**
 * Story sites in a Wilds chunk scene (the served chunk places them; the
 * region read says which Echo waits where for this player; src/lib/wilds/
 * stories.ts predicts which find a site holds):
 *
 *  - Echo camps: the woods replaying a waiting moment of one of the Six — a
 *    kettle that won't boil, a tune cut off. Phantom until settled: light
 *    the owed lamp (no cost) and the moment finishes kindly (a short text,
 *    the `echo:<member>` story flag, and for the twins a found text).
 *  - Given-back places: the crossing, the Amberwash cairn, a jackdaw's nest
 *    in a dead iron-oak, a reed backwater of the Wend, and a plank where the
 *    bridge tore. Each gives its found text back when its moment is due.
 *
 * Settling an Echo is the `settle-echo` operation (./remote.ts): predicted
 * here, refused and rolled back if the server's assignment disagrees.
 * The outer Wilds also drift with pale motes of the white quiet.
 */
import type Phaser from 'phaser'
import { ECHOES, SITE_TEXT, echoCampSpeaker, echoFlag, echoSoftenedFlag, type EchoDef, type EchoProp } from '../../content/echoes.ts'
import { paperFlag } from '../../content/papers.ts'
import { HEIRLOOMS, HEIRLOOM_GUEST_LINES } from '../../content/heirlooms.ts'
import { itemsFor } from '../items'
import { heirloomBeat } from '../heirloom-beats'
import { echoKeepsakeOffer, type EchoKeepsakeOffer } from '../keepsakes'
import { echoSettled, siteFind, type StoryContext } from '../../lib/wilds/stories.ts'
import { seasonMark, type SiteKind, type StorySite } from '../../lib/wilds/outer.ts'
import { bus, EV } from '../events'
import { grantPaper } from '../papers'
import { sfx } from '../sfx'
import { TILE, tileFeet } from '../../lib/tile'
import { commonsArt } from '../commons-pass'
import type { Session } from '../session'
import type { DialogueChoice } from '../event-names'
import type { Effects } from '../entities/fx'
import type { Interactable, Interactables } from '../entities/interactables'
import { openDialogue } from '../dialogue.ts'
import { applyEchoSettled, wildsLive, wildsView, type WildsEpoch } from './store.ts'
import { settleEcho } from './remote.ts'
import { toRegionPosition } from './regions.ts'

type C = CanvasRenderingContext2D

/** What a site offers now: the prompt, the button's word, and what pressing does. */
export interface WildsClaim {
  label: string
  verb: string
  claim: () => void
}

interface SitesDeps {
  session: Session
  fx: Effects
  reducedMotion: boolean
  interactables: Interactables
  hero: () => { x: number; y: number }
}

/** The Wilds' claims and story sites outrank anything nearer (a claim is why you came). */
export const WILDS_RANK = 1
/** How near you must be to claim, settle or find something in the Wilds. */
export const WILDS_REACH = 44

/** An interaction point for a Wilds thing whose offer can change while you stand there. */
export function wildsPoint(id: string, at: { x: number; y: number }, markerOffset: number, offer: () => WildsClaim | null): Interactable {
  return {
    id: `wilds:${id}`,
    x: at.x,
    y: at.y,
    reach: WILDS_REACH,
    clickReach: WILDS_REACH,
    rank: WILDS_RANK,
    markerOffset,
    available: () => offer() !== null,
    label: () => offer()?.label ?? null,
    verb: () => offer()?.verb ?? null,
    activate: () => offer()?.claim()
  }
}

// ------------------------------------------------------------ art

const O = '#2a1f22'
const IRON = { dk: '#302a2c', md: '#463d3c', lt: '#5f5450' }
const STONE = { dk: '#6c665c', md: '#8a8476', lt: '#a8a292', white: '#efe9dc', hi: '#ffffff' }
const WOOD = { dk: '#5e432c', md: '#7a5a3a', lt: '#a8804e' }
const OIL = { dk: '#5a4a2a', md: '#8a7440', lt: '#b89a58' }

function px(c: C, x: number, y: number, col: string): void {
  c.fillStyle = col
  c.fillRect(Math.round(x), Math.round(y), 1, 1)
}
function rect(c: C, x: number, y: number, w: number, h: number, col: string): void {
  c.fillStyle = col
  c.fillRect(x, y, w, h)
}
function oval(c: C, cx: number, cy: number, rx: number, ry: number, col: string): void {
  for (let y = -Math.ceil(ry); y <= Math.ceil(ry); y++)
    for (let x = -Math.ceil(rx); x <= Math.ceil(rx); x++)
      if ((x * x) / (rx * rx + 0.3) + (y * y) / (ry * ry + 0.3) <= 1) px(c, cx + x, cy + y, col)
}
function outline(c: C, w: number, h: number): void {
  const d = c.getImageData(0, 0, w, h).data
  const f = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!f(x, y) && (f(x + 1, y) || f(x - 1, y) || f(x, y + 1) || f(x, y - 1))) px(c, x, y, O)
}

const ART: Record<string, [number, number, (c: C) => void]> = {
  // A kettle on three cold stones.
  'site-kettle': [14, 12, (c) => {
    for (const x of [2, 6, 10]) oval(c, x + 1, 10, 1.6, 1, STONE.md)
    oval(c, 7, 6, 4, 3, IRON.md)
    rect(c, 4, 4, 6, 1, IRON.lt)
    rect(c, 6, 2, 2, 1, IRON.dk)
    rect(c, 11, 5, 2, 1, IRON.md)
    px(c, 4, 5, IRON.lt)
    outline(c, 14, 12)
  }],
  // A yoke peg standing in the moss.
  'site-yoke': [10, 14, (c) => {
    rect(c, 4, 2, 3, 11, WOOD.md)
    rect(c, 4, 2, 1, 11, WOOD.lt)
    rect(c, 2, 4, 7, 2, WOOD.dk)
    px(c, 5, 8, WOOD.dk)
    outline(c, 10, 14)
  }],
  // A bedroll by the fire (Bett's camp keeps only her song).
  'site-bedroll': [16, 8, (c) => {
    oval(c, 8, 4, 6, 2.5, '#6a5a7a')
    rect(c, 3, 3, 10, 1, '#8a7a9a')
    rect(c, 12, 2, 2, 4, '#a89470')
    outline(c, 16, 8)
  }],
  // A crooked surveyor's stake and a chalked plank.
  'site-stake': [16, 16, (c) => {
    rect(c, 1, 11, 13, 3, WOOD.md)
    rect(c, 1, 11, 13, 1, WOOD.lt)
    for (let x = 3; x < 12; x += 3) px(c, x, 12, '#efe9dc')
    for (let i = 0; i < 11; i++) px(c, 11 + Math.floor(i / 4), 10 - i, i < 2 ? WOOD.dk : '#c4a074')
    px(c, 14, 0, '#c4523a')
    outline(c, 16, 16)
  }],
  // A tin whistle on a flat stone.
  'site-whistle': [12, 8, (c) => {
    oval(c, 6, 5, 5, 2, STONE.md)
    rect(c, 2, 3, 8, 1, '#c8ccd0')
    rect(c, 2, 2, 8, 1, '#e8ecee')
    px(c, 5, 2, '#5a5e64')
    px(c, 7, 2, '#5a5e64')
    outline(c, 12, 8)
  }],
  // A lamplighter's pole leaning on a stump.
  'site-wick': [14, 22, (c) => {
    oval(c, 4, 18, 3.5, 2, WOOD.dk)
    rect(c, 1, 15, 7, 3, WOOD.md)
    for (let i = 0; i < 19; i++) px(c, 4 + Math.floor(i * 0.45), 18 - i, i > 16 ? IRON.md : WOOD.lt)
    rect(c, 11, 0, 2, 2, IRON.dk)
    outline(c, 14, 22)
  }],
  // The Amberwash forage cairn: river-stones, three of them white.
  'site-cairn': [18, 26, (c) => {
    const stones: [number, number, number, number, string][] = [
      [9, 22, 7, 3, STONE.md], [8, 17, 6, 2.5, STONE.white], [10, 13, 5, 2.2, STONE.md],
      [9, 9, 4, 2, STONE.white], [9, 5.5, 3, 1.6, STONE.lt], [9, 2.5, 2.2, 1.4, STONE.white],
    ]
    for (const [x, y, rx, ry, col] of stones) {
      oval(c, x, y, rx, ry, STONE.dk)
      oval(c, x - 0.5, y - 0.5, rx - 1, ry - 0.5, col)
    }
    px(c, 8, 1, STONE.hi)
    px(c, 4, 22, '#557f38')
    outline(c, 18, 26)
  }],
  // A dead iron-oak with a jackdaw's nest in its crotch.
  'site-nest': [28, 46, (c) => {
    rect(c, 11, 14, 6, 30, IRON.md)
    rect(c, 11, 14, 2, 30, IRON.lt)
    for (let y = 16; y < 42; y += 3) px(c, 14, y, IRON.dk)
    for (let i = 0; i < 9; i++) px(c, 11 - i, 15 - Math.floor(i * 0.9), IRON.md)
    for (let i = 0; i < 8; i++) px(c, 16 + i, 14 - Math.floor(i * 1.1), IRON.md)
    for (let i = 0; i < 6; i++) px(c, 14 - Math.floor(i * 0.3), 14 - i, IRON.lt)
    oval(c, 14, 13, 5, 2.4, '#8a7448')
    for (let x = 10; x < 19; x += 2) px(c, x, 12, '#b89a60')
    px(c, 13, 11, '#e8e2d0')
    oval(c, 14, 44, 7, 1.5, IRON.dk)
    outline(c, 28, 46)
  }],
  // An oiled bundle, caught where the land (or the water) gave it up.
  'site-bundle': [12, 8, (c) => {
    oval(c, 6, 4, 5, 3, OIL.md)
    rect(c, 2, 3, 8, 1, OIL.lt)
    rect(c, 5, 1, 1, 6, OIL.dk)
    px(c, 8, 5, OIL.dk)
    outline(c, 12, 8)
  }],
  // A heavy iron-oak plank, half-buried, chalk on it.
  'site-plank': [26, 9, (c) => {
    rect(c, 1, 3, 24, 4, IRON.md)
    rect(c, 1, 3, 24, 1, IRON.lt)
    for (let x = 4; x < 22; x += 4) px(c, x, 5, '#e8e2d0')
    px(c, 12, 4, '#e8e2d0')
    rect(c, 0, 6, 26, 2, '#3a2e22')
    outline(c, 26, 9)
  }],
  // A pale mote of the white quiet.
  'site-mote': [3, 3, (c) => {
    px(c, 1, 0, '#e8f0f4')
    rect(c, 0, 1, 3, 1, '#e8f0f4')
    px(c, 1, 2, '#e8f0f4')
    px(c, 1, 1, '#ffffff')
  }],
}

function ensureSiteArt(scene: Phaser.Scene): void {
  for (const [key, [w, h, draw]] of Object.entries(ART)) {
    if (scene.textures.exists(key)) continue
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const c = canvas.getContext('2d', { willReadFrequently: true })!
    c.imageSmoothingEnabled = false
    draw(c)
    scene.textures.addCanvas(key, canvas)
  }
}

const PROP_ART: Record<EchoProp, string> = {
  kettle: 'site-kettle',
  yoke: 'site-yoke',
  song: 'site-bedroll',
  stake: 'site-stake',
  whistle: 'site-whistle',
  wick: 'site-wick',
}

const LOOK_ART: Partial<Record<SiteKind, string>> = {
  cairn: 'site-cairn',
  nest: 'site-nest',
  plank: 'site-plank',
}

// ------------------------------------------------------------ the layer

/** The phantom tint and how much of an Echo shows before it is settled. */
const PHANTOM = 0xb8d0ff

export class WildsSites {
  private sites: StorySite[]
  private images: Phaser.GameObjects.GameObject[] = []
  private greeted = new Set<string>()
  private echoes = new Map<string, EchoDef>()
  private renderedKey = ''

  constructor(
    private scene: Phaser.Scene,
    private deps: SitesDeps,
    private epoch: WildsEpoch,
    cx: number,
    cy: number,
    sites: readonly { id: string; kind: string; tx: number; ty: number }[]
  ) {
    ensureSiteArt(scene)
    this.sites = sites.map((s) => ({ ...s, kind: s.kind as SiteKind, cx, cy }))
    scene.events.once('shutdown', () => {
      this.images = []
    })
    if (epoch.regionId !== 'inner-1') this.motes()
    this.render()
    deps.interactables.register(
      this,
      // Quiet until a fresh region read lands (and while stale), like the claims around them.
      this.sites.map((s) => wildsPoint(`site:${s.id}`, this.sitePx(s), 20, () => (wildsLive(this.deps.session, this.epoch.regionId) ? this.offerAt(s) : null)))
    )
  }

  private ctx(): StoryContext {
    const s = this.deps.session.state
    return { flags: s.flags, late: s.quest === 'complete', mark: seasonMark(this.epoch.season) }
  }

  /** Re-render when anything a site shows has changed (flags, the road being lit). */
  update(): void {
    const c = this.ctx()
    const key = `${c.late}|${c.flags.filter((f) => f.startsWith('echo:') || f.startsWith('paper:')).length}`
    if (key !== this.renderedKey) this.render()
    this.greet()
  }

  private sitePx(s: StorySite): { x: number; y: number } {
    return tileFeet(s.tx, s.ty)
  }

  private add<T extends Phaser.GameObjects.GameObject>(o: T): T {
    this.images.push(o)
    return o
  }

  private render(): void {
    for (const o of this.images) {
      this.scene.tweens.killTweensOf(o)
      o.destroy()
    }
    this.images = []
    const c = this.ctx()
    this.renderedKey = `${c.late}|${c.flags.filter((f) => f.startsWith('echo:') || f.startsWith('paper:')).length}`
    // Who waits at each camp is this player's assignment, from the region read.
    this.echoes = new Map()
    for (const [site, a] of wildsView(this.epoch.regionId)?.echoes ?? []) {
      const def = ECHOES.find((e) => e.member === a.member)
      if (def) this.echoes.set(site, def)
    }
    for (const s of this.sites) {
      if (s.kind === 'echo') this.renderEcho(s)
      else this.renderLook(s, c)
    }
  }

  private img(key: string, x: number, y: number, frame?: string): Phaser.GameObjects.Image {
    const i = frame ? this.scene.add.image(x, y, key, frame) : this.scene.add.image(x, y, key)
    return this.add(i.setOrigin(0.5, 1).setDepth(y - 2))
  }

  private renderEcho(s: StorySite): void {
    const def = this.echoes.get(s.id)
    const at = this.sitePx(s)
    const settled = def ? echoSettled(this.deps.session.state.flags, def.member) : true
    const parts: Phaser.GameObjects.Image[] = []
    /** The delivered faint prop is pale already: it wavers less. */
    let faint: Phaser.GameObjects.Image | null = null
    const fire = this.img('wilds-campfire', at.x - 12, at.y)
    fire.setScale(12 / fire.height)
    parts.push(fire)
    if (def) {
      // The delivered prop (Commons pass): the faint replay until it's
      // settled, then the thing itself. Never flipped: Hollis's fox keeps
      // its long ear on the viewer's right.
      const prop = commonsArt(this.scene, `echo-${def.member}-${settled ? 'solid' : 'faint'}`)
      if (prop && !settled) faint = this.img(prop, at.x + 6, at.y + 2)
      else parts.push(prop ? this.img(prop, at.x + 6, at.y + 2) : this.img(PROP_ART[def.prop], at.x + 4, at.y + 1))
    }
    // The owed lamp: a fallen hero's lantern, dark until it is lit.
    const props = this.scene.textures.get('fingersnap-props')
    const lamp = commonsArt(this.scene, `fallen-hero-lantern-${settled ? 'lit' : 'unlit'}`)
    if (lamp) {
      this.img(lamp, at.x + 18, at.y - 4)
      if (settled) {
        const glow = this.add(this.scene.add.image(at.x + 18, at.y - 14, 'glow').setBlendMode(1).setTint(0xffb054).setScale(0.45).setAlpha(0.75).setDepth(at.y + 2))
        if (!this.deps.reducedMotion) this.scene.tweens.add({ targets: glow, alpha: { from: 0.7, to: 0.45 }, duration: 1300, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
      }
    } else if (props.has('lantern-post')) {
      const post = this.img('fingersnap-props', at.x + 16, at.y - 2, 'lantern-post')
      post.setScale(24 / props.get('lantern-post')!.height)
      if (!settled) post.setTint(0x5e5a70)
      else {
        const glow = this.add(this.scene.add.image(at.x + 16, at.y - 18, 'glow').setBlendMode(1).setTint(0xffb054).setScale(0.45).setAlpha(0.75).setDepth(at.y + 2))
        if (!this.deps.reducedMotion) this.scene.tweens.add({ targets: glow, alpha: { from: 0.7, to: 0.45 }, duration: 1300, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
      }
    }
    if (settled) {
      fire.setTint(0x9a8a7a)
      return
    }
    // The woods replaying it: pale, and not quite steady, under a cold haze.
    const haze = this.add(this.scene.add.image(at.x, at.y - 6, 'glow').setBlendMode(1).setTint(0xa8c4ff).setScale(1.1).setAlpha(0.32).setDepth(at.y - 4))
    if (!this.deps.reducedMotion) this.scene.tweens.add({ targets: haze, alpha: { from: 0.34, to: 0.16 }, scale: { from: 1.05, to: 1.2 }, duration: 2200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    for (const p of parts) p.setTint(PHANTOM)
    faint?.setTint(PHANTOM)
    if (this.deps.reducedMotion) {
      for (const p of parts) p.setAlpha(0.6)
      faint?.setAlpha(0.85)
    } else {
      this.scene.tweens.add({ targets: parts, alpha: { from: 0.72, to: 0.32 }, duration: 1600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
      if (faint) this.scene.tweens.add({ targets: faint, alpha: { from: 1, to: 0.6 }, duration: 1600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    }
    const glint = this.add(this.scene.add.image(at.x, at.y - 22, 'spark').setDepth(at.y + 3).setBlendMode(1).setTint(PHANTOM))
    if (!this.deps.reducedMotion) this.scene.tweens.add({ targets: glint, y: at.y - 26, alpha: { from: 0.85, to: 0.3 }, duration: 1100, yoyo: true, repeat: -1 })
  }

  private renderLook(s: StorySite, c: StoryContext): void {
    const at = this.sitePx(s)
    const art = s.kind === 'cairn' ? commonsArt(this.scene, 'cairn-white-stones') ?? LOOK_ART.cairn : LOOK_ART[s.kind]
    if (art) this.img(art, at.x, at.y)
    const find = siteFind(s.kind, c)
    if (!find) return
    // Something is due here: the bundle (or the stone, the nest) glints.
    if (s.kind === 'given' || s.kind === 'reeds') this.img('site-bundle', at.x, at.y)
    const lift = s.kind === 'nest' ? 40 : s.kind === 'cairn' ? 30 : 16
    const glint = this.add(this.scene.add.image(at.x, at.y - lift, 'spark').setDepth(at.y + 3).setBlendMode(1))
    if (!this.deps.reducedMotion) this.scene.tweens.add({ targets: glint, y: at.y - lift - 4, alpha: { from: 0.85, to: 0.35 }, duration: 900, yoyo: true, repeat: -1 })
  }

  /** Walking up to an unsettled Echo: what the woods are replaying. */
  private greet(): void {
    for (const s of this.sites) {
      if (s.kind !== 'echo' || this.greeted.has(s.id)) continue
      const def = this.echoes.get(s.id)
      if (!def || echoSettled(this.deps.session.state.flags, def.member)) continue
      const at = this.sitePx(s)
      const hero = this.deps.hero()
      if (Math.hypot(hero.x - at.x, hero.y - at.y) > 64) continue
      this.greeted.add(s.id)
      bus.emit(EV.toast, { text: def.scene, icon: 'sparkle', kind: 'thought' })
    }
  }

  // ------------------------------------------------------------ prompts

  /** What this site offers now (null: nothing, it keeps quiet). */
  private offerAt(s: StorySite): WildsClaim | null {
    const c = this.ctx()
    if (s.kind === 'echo') {
      const def = this.echoes.get(s.id)
      if (!def) return null
      // Carrying the person's keepsake: the camp offers to take it (docs/
      // items/overview.md), settled or not. The owed lamp stays offered in
      // the conversation, so leaving never takes the settling away.
      const offer = echoKeepsakeOffer(def.member, c.flags, this.carried())
      if (offer) {
        return { label: offer.label, verb: 'Leave', claim: () => this.offerKeepsake(s, def, offer) }
      }
      if (echoSettled(c.flags, def.member)) {
        if (def.member === 'nan' && !c.flags.includes('heirloom:nans-lamplighter-pole')) {
          return { label: 'Take Nan’s lamplighter pole', verb: 'Take', claim: () => this.takeNanPole() }
        }
        return null
      }
      return { label: def.verb, verb: 'Settle', claim: () => this.settle(s, def) }
    }
    const paper = siteFind(s.kind, c)
    if (!paper) return null
    const text = SITE_TEXT[s.kind as keyof typeof SITE_TEXT]
    return { label: text.verb, verb: 'Look', claim: () => this.find(s, paper) }
  }

  /**
   * Everything carried, both ways: the save's pack (guests, quest things)
   * and the world's item stacks (connected play).
   */
  private carried(): string[] {
    const s = this.deps.session
    return [...s.state.inventory, ...(itemsFor(s).view?.stacks.map((st) => st.itemDef) ?? [])]
  }

  // ------------------------------------------------------------ settling and finding

  private settle(s: StorySite, def: EchoDef): void {
    const session = this.deps.session
    if (echoSettled(session.state.flags, def.member)) return
    // The moment plays now. Connected, the settle is a predicted operation
    // and its answer carries the mark and the Echo's paper (the server grants
    // both); a take sent first would be refused as not yet due.
    if (!session.link) session.addFlag(echoFlag(def.member))
    this.sendSettle(s, def)
    const at = this.sitePx(s)
    sfx('lantern')
    this.deps.fx.sparkBurst(at.x + 16, at.y - 18, 12)
    // A keep left here before the settling: the moment finishes a little softer.
    const softened = def.keepsake && session.state.flags.includes(echoSoftenedFlag(def.member)) ? [def.keepsake.softened] : []
    openDialogue({ id: `wilds-echo:${def.member}`, speaker: `An Echo — ${def.name}`, lines: [...def.settle, ...softened] }, { sound: null })
    if (!session.link && def.paper && !session.state.flags.includes(paperFlag(def.paper))) grantPaper(session, def.paper)
    this.render()
  }

  private sendSettle(s: StorySite, def: EchoDef): void {
    const session = this.deps.session
    if (!session.link) return
    const hero = this.deps.hero()
    const where = { region: this.epoch.regionId, ...toRegionPosition(s.cx, s.cy, hero.x, hero.y) }
    void settleEcho(session, { epoch: this.epoch.id, site: s.id, member: def.member, where }).then((res) => {
      if (res.ok) {
        applyEchoSettled(s.id)
        if (res.result.paper && !session.state.flags.includes(paperFlag(res.result.paper))) grantPaper(session, res.result.paper)
        return
      }
      if (res.code !== 'echo-not-here') return
      // The server's assignment disagrees: the Echo still waits.
      session.state = { ...session.state, flags: session.state.flags.filter((f) => f !== echoFlag(def.member)) }
      this.render()
    })
  }

  /** A settle picked in a camp conversation (the keepsake's offer keeps the lamp open). */
  settleEcho(siteId: string): boolean {
    if (!wildsLive(this.deps.session, this.epoch.regionId)) return false
    const s = this.sites.find((x) => x.id === siteId && x.kind === 'echo')
    const def = s ? this.echoes.get(s.id) : undefined
    if (!s || !def) return false
    this.settle(s, def)
    return true
  }

  /**
   * The camp's offer while you carry its person's keepsake (docs/items/
   * overview.md, "Returning keepsakes"): the leave choice goes through the
   * server's `return` op — the same action the residents' talk uses — and
   * "not yet" never closes the door. While the echo still waits, its lamp
   * stays offered too. Guests get one short line: the leave itself waits
   * until they're signed in, like the heirloom beats.
   */
  private offerKeepsake(s: StorySite, def: EchoDef, offer: EchoKeepsakeOffer): void {
    const session = this.deps.session
    const settled = echoSettled(session.state.flags, def.member)
    const lamp: DialogueChoice = { text: def.verb, action: `echo:settle:${s.id}` }
    const notYet: DialogueChoice = { text: 'Not yet' }
    openDialogue({
      id: `wilds-keepsake:${def.member}`,
      speaker: echoCampSpeaker(def.member, settled),
      lines: session.link ? [...offer.lines] : [offer.guest],
      choices: session.link
        ? [{ text: offer.label, action: offer.action }, ...(settled ? [] : [lamp]), notYet]
        : settled
          ? undefined
          : [lamp, notYet]
    }, { sound: null })
  }

  private takeNanPole(): void {
    const session = this.deps.session
    if (session.state.flags.includes('heirloom:nans-lamplighter-pole')) return
    const h = HEIRLOOMS['nans-lamplighter-pole']
    if (!session.link) {
      openDialogue({
        id: 'wilds-heirloom:nans-lamplighter-pole',
        speaker: h.speaker,
        lines: [HEIRLOOM_GUEST_LINES.nan]
      }, { sound: null })
      return
    }
    // Offered only when the pole can come away now; otherwise the camp says why.
    const beat = heirloomBeat(session, 'nans-lamplighter-pole', 'Take the lamplighter pole')
    if (!beat) return
    openDialogue({
      id: 'wilds-heirloom:nans-lamplighter-pole',
      speaker: h.speaker,
      lines: beat.lines,
      choices: beat.choices.length ? [...beat.choices, { text: 'Not yet' }] : undefined
    }, { sound: null })
  }

  private find(s: StorySite, paper: string): void {
    const text = SITE_TEXT[s.kind as keyof typeof SITE_TEXT]
    if (text) bus.emit(EV.toast, { text: text.look, icon: 'map', kind: 'thought' })
    const session = this.deps.session
    if (session.link) {
      // A site's paper is the server's to check against this epoch's site:
      // the take names both, from where the hero stands. Its answer brings
      // the paper (announced when its mark arrives).
      bus.emit(EV.notePosition)
      void session.link.takePaper(paper, { epoch: this.epoch.id, site: s.id }).then(() => this.render())
    } else grantPaper(session, paper)
    this.render()
  }

  // ------------------------------------------------------------ the white quiet

  /** Pale motes drifting through the outer Wilds (still when motion is reduced). */
  private motes(): void {
    const w = 24 * TILE
    for (let i = 0; i < 26; i++) {
      const x = ((i * 97) % 23) * TILE + 8 + ((i * 13) % 9)
      const y = ((i * 53) % 23) * TILE + 6
      const m = this.add(this.scene.add.image(x, y, 'site-mote').setDepth(4500).setAlpha(0.35 + (i % 4) * 0.1))
      if (this.deps.reducedMotion) continue
      this.scene.tweens.add({
        targets: m,
        x: Math.min(w - 4, x + 18 + (i % 5) * 6),
        y: y - 10 - (i % 3) * 6,
        alpha: { from: m.alpha, to: 0.08 },
        duration: 5200 + (i % 7) * 900,
        delay: (i % 6) * 500,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      })
    }
  }

  // ------------------------------------------------------------ playtests

  debug(): Array<{ id: string; kind: string; tx: number; ty: number; echo: string | null; settled: boolean; find: string | null }> {
    const c = this.ctx()
    return this.sites.map((s) => {
      const def = s.kind === 'echo' ? this.echoes.get(s.id) ?? null : null
      return {
        id: s.id,
        kind: s.kind,
        tx: s.tx,
        ty: s.ty,
        echo: def?.member ?? null,
        settled: def ? echoSettled(c.flags, def.member) : false,
        find: s.kind === 'echo' ? null : siteFind(s.kind, c)
      }
    })
  }
}
