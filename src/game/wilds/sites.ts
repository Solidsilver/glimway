/**
 * Story sites in a Wilds chunk scene (src/lib/wilds/outer.ts places them;
 * src/lib/wilds/stories.ts decides what they hold):
 *
 *  - Echo camps: the woods replaying a waiting moment of one of the Six — a
 *    kettle that won't boil, a tune cut off. Phantom until settled: light
 *    the owed lamp (no cost) and the moment finishes kindly (a short text,
 *    the `echo:<member>` story flag, and for the twins a found text).
 *  - Given-back places: the crossing, the Amberwash cairn, a jackdaw's nest
 *    in a dead iron-oak, a reed backwater of the Wend, and a plank where the
 *    bridge tore. Each gives its found text back when its moment is due.
 *
 * Everything here is client-side story state: nothing reaches the economy.
 * The outer Wilds also drift with pale motes of the white quiet.
 */
import type Phaser from 'phaser'
import { ECHOES, ECHO_SETTLED_LINE, SITE_TEXT, echoFlag, type EchoDef, type EchoProp } from '../../content/echoes.ts'
import { paperFlag } from '../../content/papers.ts'
import { echoAssignments, echoSettled, siteFind, type StoryContext } from '../../lib/wilds/stories.ts'
import { seasonMark, siteChunks, type SiteKind, type StorySite } from '../../lib/wilds/outer.ts'
import type { Epoch } from '../../lib/wilds/types.ts'
import { bus, EV } from '../events'
import { uiState } from '../input'
import { grantPaper } from '../papers'
import { sfx } from '../sfx'
import { TILE } from '../textures'
import type { Session } from '../session'
import type { Effects } from '../entities/fx'
import type { PromptAction } from '../entities/interactables'

type C = CanvasRenderingContext2D

export interface SiteAction extends PromptAction {
  entityId: string
  claim: () => void
}

interface SitesDeps {
  session: Session
  fx: Effects
  reducedMotion: boolean
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
  private heroPx = { x: 0, y: 0 }
  private current: SiteAction | null = null
  private echoes = new Map<string, EchoDef>()
  private renderedKey = ''

  constructor(
    private scene: Phaser.Scene,
    private deps: SitesDeps,
    private epoch: Epoch,
    cx: number,
    cy: number,
    sites: readonly { id: string; kind: string; tx: number; ty: number }[]
  ) {
    ensureSiteArt(scene)
    this.sites = sites.map((s) => ({ ...s, kind: s.kind as SiteKind, cx, cy }))
    scene.events.once('shutdown', () => {
      this.images = []
      this.current = null
    })
    if (epoch.regionId !== 'inner-1') this.motes()
    this.render()
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
    return { x: s.tx * TILE + 8, y: s.ty * TILE + TILE }
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
    // Echo assignments are region-wide facts (each member waits in one camp):
    // assign over the whole epoch's sites, of which this chunk holds a few.
    this.echoes = echoAssignments(this.epoch, siteChunks(this.epoch), c.late)
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
    const fire = this.img('wilds-campfire', at.x - 12, at.y)
    fire.setScale(12 / fire.height)
    parts.push(fire)
    if (def) parts.push(this.img(PROP_ART[def.prop], at.x + 4, at.y + 1))
    // The owed lamp: a road lantern post, dark until it is lit.
    const props = this.scene.textures.get('fingersnap-props')
    if (props.has('lantern-post')) {
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
    if (this.deps.reducedMotion) for (const p of parts) p.setAlpha(0.6)
    else this.scene.tweens.add({ targets: parts, alpha: { from: 0.72, to: 0.32 }, duration: 1600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    const glint = this.add(this.scene.add.image(at.x, at.y - 22, 'spark').setDepth(at.y + 3).setBlendMode(1).setTint(PHANTOM))
    if (!this.deps.reducedMotion) this.scene.tweens.add({ targets: glint, y: at.y - 26, alpha: { from: 0.85, to: 0.3 }, duration: 1100, yoyo: true, repeat: -1 })
  }

  private renderLook(s: StorySite, c: StoryContext): void {
    const at = this.sitePx(s)
    const art = LOOK_ART[s.kind]
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
      if (Math.hypot(this.heroPx.x - at.x, this.heroPx.y - at.y) > 64) continue
      this.greeted.add(s.id)
      bus.emit(EV.toast, { text: def.scene, icon: 'sparkle' })
    }
  }

  // ------------------------------------------------------------ prompts

  /** The nearest site action within reach, with its distance. */
  promptAction(hero: { x: number; y: number }): { action: SiteAction; d: number } | null {
    this.heroPx = { x: hero.x, y: hero.y }
    const c = this.ctx()
    let best: { action: SiteAction; d: number } | null = null
    for (const s of this.sites) {
      const at = this.sitePx(s)
      const d = Math.hypot(hero.x - at.x, hero.y - at.y)
      if (d > 44) continue
      const action = this.actionFor(s, at, c)
      if (action && (!best || d < best.d)) best = { action, d }
    }
    this.current = best?.action ?? null
    return best
  }

  private actionFor(s: StorySite, at: { x: number; y: number }, c: StoryContext): SiteAction | null {
    const spot = { x: Math.round(at.x), y: Math.round(at.y - 20) }
    if (s.kind === 'echo') {
      const def = this.echoes.get(s.id)
      if (!def || echoSettled(c.flags, def.member)) return null
      return { entityId: `site:${s.id}`, label: def.verb, verb: 'Settle', x: spot.x, y: spot.y, claim: () => this.settle(s, def) }
    }
    const paper = siteFind(s.kind, c)
    if (!paper) return null
    const text = SITE_TEXT[s.kind as keyof typeof SITE_TEXT]
    return { entityId: `site:${s.id}`, label: text.verb, verb: 'Look', x: spot.x, y: spot.y, claim: () => this.find(s, paper) }
  }

  /** The action key while a site prompt is up. */
  handleAction(): boolean {
    if (!this.current) return false
    this.current.claim()
    return true
  }

  // ------------------------------------------------------------ settling and finding

  private settle(s: StorySite, def: EchoDef): void {
    const session = this.deps.session
    if (echoSettled(session.state.flags, def.member)) return
    session.addFlag(echoFlag(def.member))
    const at = this.sitePx(s)
    sfx('lantern')
    this.deps.fx.sparkBurst(at.x + 16, at.y - 18, 12)
    uiState.dialogueOpen = true
    bus.emit(EV.dialogue, { id: `wilds-echo:${def.member}`, speaker: `An Echo — ${def.name}`, lines: [...def.settle] })
    if (def.paper && !session.state.flags.includes(paperFlag(def.paper))) grantPaper(session, def.paper)
    this.render()
  }

  private find(s: StorySite, paper: string): void {
    const text = SITE_TEXT[s.kind as keyof typeof SITE_TEXT]
    if (text) bus.emit(EV.toast, { text: text.look, icon: 'map' })
    grantPaper(this.deps.session, paper)
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

export { ECHOES, ECHO_SETTLED_LINE }
