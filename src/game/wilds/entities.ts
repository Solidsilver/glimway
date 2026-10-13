/**
 * Wilds entities — the generated things in the open map's attached chunks
 * (./window.ts attaches and detaches them as the hero walks): camps (their
 * enemies are the server room's, drawn by ../entities/server-enemies.ts; once
 * the server stores its fall with this account as a witness, the near read
 * names it claimable for that epoch and cycle, ./camp-fights.ts), resource
 * nodes (harvest prompt with the material's verb),
 * personal chests, points of interest (discovery text; "Charted by {name}"
 * for the world's first discoverer), and other members' fallen-hero
 * lanterns (relightable).
 *
 * Everything renders from the store (src/game/wilds/store.ts) — the served
 * chunks' bodies with the near read's cycles and claims — per chunk: a chunk
 * that comes draws its own things, one that goes takes its own, and when the
 * store's version moves only the things whose look changed (claimed, spent,
 * relit) are drawn again.
 * Claims and relights are operations (./remote.ts). Each claimable thing is
 * an interaction point (../entities/interactables.ts) that outranks the
 * people and props around it; the action key claims it.
 *
 * Papers: two POIs and the tier-3 chests carry found texts (papers.ts
 * sources `wilds-poi` / `wilds-chest`). The server grants them with the
 * claim.
 */
import type Phaser from 'phaser'
import { presence } from '../presence'
import { WILDS_CLAIM_ERRORS } from '../../content/wilds-errors.ts'
import {
  CAMP_WALK_IN_LINES,
  CHEST_OPEN_FLAVOR,
  FALLEN_HERO_LANTERNS,
  MATERIALS,
  POIS,
} from '../../content/expansion-writing.ts'
import type { WildsEntityView, WildsLanternView } from '../../lib/api/types.ts'
import { CHUNK_TILES, chunkKey, chunkOfPixel } from './coords.ts'
import { claimEntity, relightLantern, type WildsWhere } from './remote.ts'
import {
  applyClaim,
  applyLanterns,
  campClaimable,
  chunkEpoch,
  chunkThings,
  discoveryFor,
  entityAvailable,
  entityCycle,
  entityChunk,
  isClaimed,
  requestRead,
  takeReadRequest,
  lootName,
  lootText,
  refreshNear,
  wickEndsAt,
  wildsEpoch,
  wildsLive,
  wildsStale,
  wildsView,
  type WildsThing,
} from './store.ts'
import type { ChunkTerrain } from './terrain.ts'
import { WildsSites, wildsPoint, type WildsClaim } from './sites.ts'
import { grantPaper } from '../papers'
import { bus, EV, type ToastPayload } from '../events'
import { sfx } from '../sfx'
import { emitResidents } from '../residents'
import { commonsAnim, commonsArt } from '../commons-pass'
import { TILE, tileFeet } from '../../lib/tile'
import type { Session } from '../session'
import type { Effects } from '../entities/fx'
import type { EnemySystem } from '../entities/enemies'
import type { Interactables } from '../entities/interactables'
import { perfSpan, perfTime } from '../perf.ts'
import { ServerCampOutcome, type CampNow } from './camp-fights.ts'
import { addAll, destroyAll, looseImage } from '../area/bulk.ts'

/** Server error code → what the player reads. All text is static. */
export const CLAIM_ERROR = WILDS_CLAIM_ERRORS

import { openDialogue } from '../dialogue.ts'

export interface WildsDeps {
  session: Session
  fx: Effects
  enemies: EnemySystem
  reducedMotion: boolean
  interactables: Interactables
  hero: () => { x: number; y: number }
}

/** What one thing or lantern shows: its images and the tweens that move them (stopped with them), and the look they show. */
interface Rendered {
  look: string
  images: Phaser.GameObjects.GameObject[]
  tweens: Phaser.Tweens.Tween[]
}

/**
 * Stop drawings' tweens and destroy their images, off the display list in
 * one pass (a destroyed image's endless tween would run on).
 */
function dropRendered(scene: Phaser.Scene, drawings: Iterable<Rendered>): void {
  const images: Phaser.GameObjects.GameObject[] = []
  for (const r of drawings) {
    for (const t of r.tweens) t.stop()
    images.push(...r.images)
  }
  destroyAll(scene, images)
}

/** Small pixel art for the entities the prop atlas has no frame for. */
const ART: Record<string, { rows: string[]; pal: Record<string, string> }> = {
  'wilds-campfire': {
    rows: [
      '...o..o.....',
      '..ofo.ofo...',
      '..offoffo...',
      '.oifyyiifo..',
      '.oiyyyyifo..',
      'ooffwwffoo..',
      'offffffffffo',
      'oFFFFFFFFFfo',
      '.oooooooooo.'
    ],
    pal: { o: '#3a2a28', f: '#8a5a34', F: '#b07a48', y: '#ffd24a', i: '#e07a52', w: '#fffbef' }
  },
  'wilds-amber': {
    rows: [
      '...o..o....',
      '..oYo..oYo.',
      '.oYAAYoAYo.',
      '.oYAAAYAYo.',
      'oYAAAYAAYo.',
      'oYAAYAAYYo.',
      '.oYYYYYYo..',
      '.oooooooo..'
    ],
    pal: { o: '#3a2a28', Y: '#e8a53c', A: '#ffd98a' }
  },
  'wilds-stone': {
    rows: [
      '...oooooo....',
      '..oGGGGGGo...',
      '.oGGLGGGLGGo.',
      'oGGGLLGGLGGo.',
      'oGLGGGGGGGGo.',
      'oGGGLLGGLLGo.',
      'oGoGGLGGGLGo.',
      '.oooooooooo..'
    ],
    pal: { o: '#3a2a28', G: '#8d948f', L: '#c6cec8' }
  },
  'wilds-fiber': {
    rows: [
      '..o..o..o....',
      '.oFo.oFo.oFo.',
      '.oFFoFFoFFo..',
      'oFFFoFFFoFFo.',
      'oFFFoFFFoFFFo',
      'oFFFoFFFoFFFo',
      '.oFFoFFoFFFo.',
      '..ooo.oo.oo..'
    ],
    pal: { o: '#3a2a28', F: '#7a9a4a', f: '#a8bf6a' }
  },
  'wilds-cart': {
    rows: [
      '.o..........o.',
      'offfo..oofffo.',
      'offffoofffffo.',
      'offffoofffffo.',
      '.oooooooooooo.',
      '..oFo....oFo..',
      '..oFo....oFo..',
      '..ooo....ooo..'
    ],
    pal: { o: '#3a2a28', f: '#8a5a34', F: '#5a4a3a' }
  }
}

/**
 * The frozen pond (a POI): a little iced-over pool two tiles across, sunk
 * in a rim of earth and stones, cloudy ice with cracks and a glint, a few
 * reeds frozen at the edge. Drawn at world size (it lies flat on the ground).
 */
function drawPond(): HTMLCanvasElement {
  const W = 30
  const H = 16
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  const px = (x: number, y: number, col: string) => {
    ctx.fillStyle = col
    ctx.fillRect(x, y, 1, 1)
  }
  const cx = 14.5
  const cy = 8
  const inside = (x: number, y: number, rx: number, ry: number) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!inside(x, y, 14.5, 7.6)) continue
      if (!inside(x, y, 13.2, 6.4)) px(x, y, y < cy ? '#4a3c2e' : '#3a2f25') // the earth rim
      else if (!inside(x, y, 12, 5.4)) px(x, y, y < cy - 1 ? '#c9dde6' : '#7d9db0') // frost at the edge, shadow below
      else {
        // Cloudy ice: lighter to the upper left, a darker heart.
        const t = (x - cx) / 12 + (y - cy) / 5
        px(x, y, t < -0.6 ? '#b8d4e2' : t < 0.2 ? '#9cc0d2' : '#83a8bd')
      }
    }
  // Cracks and a glint.
  for (const [x, y] of [[9, 7], [10, 8], [11, 8], [12, 9], [13, 9], [17, 6], [18, 7], [18, 8], [19, 8]]) px(x!, y!, '#5f8399')
  for (const [x, y] of [[8, 5], [9, 5], [10, 4], [20, 10]]) px(x!, y!, '#f4f8fa')
  // Stones on the rim, lit from the upper left.
  for (const [x, y] of [[2, 6], [26, 5], [6, 13], [23, 12], [15, 14]]) {
    px(x!, y!, '#a8a292')
    px(x! + 1, y!, '#8a8476')
    px(x!, y! + 1, '#6c665c')
    px(x! + 1, y! + 1, '#4f4a44')
  }
  // Reeds frozen at the north-east edge.
  for (const [x, h] of [[21, 4], [23, 5], [24, 3]]) for (let i = 0; i < h!; i++) px(x!, 3 - i + 1, i === h! - 1 ? '#c4c0a4' : '#7a8a52')
  return c
}

function ensureArt(scene: Phaser.Scene): void {
  if (!scene.textures.exists('wilds-pond')) scene.textures.addCanvas('wilds-pond', drawPond())
  for (const [key, art] of Object.entries(ART)) {
    if (scene.textures.exists(key)) continue
    const w = Math.max(...art.rows.map((r) => r.length))
    const h = art.rows.length
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    art.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = art.pal[row[x]]
        if (!c) continue
        ctx.fillStyle = c
        ctx.fillRect(x, y, 1, 1)
      }
    })
    scene.textures.addCanvas(key, canvas)
  }
}

/** Node props by material — distinct from the scatter decor, so a node reads
 * as something to work, not as scenery. */
const NODE_FRAME: Record<string, { tex: string; frame?: string; h: number }> = {
  timber: { tex: 'fingersnap-props', frame: 'tool-crate', h: 16 },
  stone: { tex: 'wilds-stone', h: 14 },
  fiber: { tex: 'wilds-fiber', h: 15 },
  amber: { tex: 'wilds-amber', h: 12 },
}

/** POI props by POI definition id. */
const POI_FRAME: Record<string, { tex: string; frame?: string; h: number }> = {
  'old-shrine': { tex: 'fingersnap-props', frame: 'lantern-shrine', h: 26 },
  waystone: { tex: 'fingersnap-props', frame: 'stone-milestone', h: 18 },
  'frozen-pond': { tex: 'wilds-pond', h: 16 },
  'abandoned-cart': { tex: 'wilds-cart', h: 14 },
  'mossy-arch': { tex: 'fingersnap-foreground', frame: 'stone-arch', h: 30 },
}

/** The delivered icon for a loot toast: the find, else the first material. */
export const lootArt = (drop: { materials: { id: string }[]; trinket: string | null }): string | undefined =>
  drop.trinket ? `icon-${drop.trinket}` : drop.materials[0] ? `icon-${drop.materials[0].id}` : undefined

/**
 * What a drop put in the bag, for the bag button: the first item, and its
 * count when it's the only one; mixed loot says what it was ("3 Fiber, 1 Amber").
 */
export const lootGain = (drop: { materials: { id: string; qty: number }[]; trinket: string | null }): ToastPayload['gain'] => {
  const first = drop.trinket ?? drop.materials[0]?.id
  if (!first) return undefined
  const single = drop.materials.length + (drop.trinket ? 1 : 0) === 1
  if (single) return { to: 'bag', itemDef: first, qty: drop.trinket ? 1 : drop.materials[0].qty }
  const label = [...drop.materials.map((m) => `${m.qty} ${lootName(m.id)}`), ...(drop.trinket ? [lootName(drop.trinket)] : [])].join(', ')
  return { to: 'bag', itemDef: first, label }
}

const poiName = (id: string): string => POIS.find((p) => p.id === id)?.name ?? id
const materialOf = (id: string) => MATERIALS.find((m) => m.id === id)

/** An attached chunk: where it is, and its story sites. */
interface Attached {
  cx: number
  cy: number
  sites: WildsSites
}

export class WildsEntities {
  /** The open map's attached chunks, by `cx,cy`. */
  private attached = new Map<string, Attached>()
  /** What each attached chunk shows, by thing or lantern id. */
  private drawn = new Map<string, Map<string, Rendered>>()
  /**
   * Every generated camp's claim prompt, by epoch, entity and cycle: the near
   * read's word for that exact cycle, hurried by its server room's completion
   * (./camp-fights.ts). An absent room or a down socket keeps the last word.
   */
  private campOutcome = new ServerCampOutcome(camp => {
    const feed = presence()
    return feed?.live ? feed.fights.campWon(camp.id, camp.epoch) : undefined
  }, requestRead)
  private greeted = new Set<string>()
  private claiming = false
  private lastVersion = -1
  /** Shown as last seen (no fresh read, or no connection): the label, and when to try again. */
  private staleLabel: Phaser.GameObjects.Text | null = null
  private staleRetryAt = 0

  constructor(private scene: Phaser.Scene, private deps: WildsDeps) {
    ensureArt(scene)
    scene.events.once('shutdown', () => {
      this.drawn.clear()
      this.attached.clear()
      this.staleLabel = null
    })
  }

  /** A chunk joined the window: its sites, entities and lanterns show. */
  attach(chunk: ChunkTerrain): void {
    const key = chunkKey(chunk.cx, chunk.cy)
    this.detach(key, false)
    const epoch = chunkEpoch(chunk.cx, chunk.cy) ?? wildsEpoch('wick')
    const sites = perfTime('attach:sites', () => new WildsSites(
      this.scene,
      { session: this.deps.session, fx: this.deps.fx, reducedMotion: this.deps.reducedMotion, interactables: this.deps.interactables, hero: this.deps.hero },
      epoch,
      chunk.cx,
      chunk.cy,
      chunk.sites,
      chunk.look === 'outer'
    ))
    this.attached.set(key, { cx: chunk.cx, cy: chunk.cy, sites })
    if (!wildsView()) return this.render(null)
    this.draw(key, Math.floor(Date.now() / 1000))
    this.publish(true)
  }

  /** A chunk left the window: what it showed goes, and its camps' creatures with it. */
  detach(key: string, republish = true): void {
    const a = this.attached.get(key)
    if (!a) return
    this.attached.delete(key)
    a.sites.destroy()
    this.undraw(key)
    // By id, not by the store's things: after a reset (the turning) the store no longer lists them.
    // A camp's fight is its room's: nothing of it goes with the chunk.
    for (const id of [...this.greeted]) {
      const at = entityChunk(id)
      if (at?.cx === a.cx && at.cy === a.cy) this.greeted.delete(id)
    }
    if (republish) this.publish(wildsView() ? true : null)
  }

  /** Drop every chunk (the turning reloads the window). */
  detachAll(): void {
    for (const key of [...this.attached.keys()]) this.detach(key, false)
    this.render(null)
  }

  /** While stale: say so on screen, and try a fresh read now and then. */
  private showStale(stale: boolean): void {
    if (stale && !this.staleLabel) {
      this.staleLabel = this.scene.add
        .text(this.scene.scale.width / 2, 6, 'Out of reach — the Wilds as you last saw them', { fontFamily: '"Pixelify Sans", monospace', fontSize: '8px', color: '#ffe9a8', stroke: '#2b1d1a', strokeThickness: 2, resolution: 4 })
        .setOrigin(0.5, 0)
        .setScrollFactor(0)
        .setDepth(100000)
    } else if (!stale && this.staleLabel) {
      this.staleLabel.destroy()
      this.staleLabel = null
    }
    const session = this.deps.session
    if (stale && session.link?.status === 'online' && Date.now() >= this.staleRetryAt) {
      this.staleRetryAt = Date.now() + 10_000
      void this.refresh()
    }
  }

  // ------------------------------------------------------------ per frame

  update(): void {
    const view = wildsView()
    if (!view) {
      // Never read yet (the server didn't answer on the way in): try again now and then.
      if (this.deps.session.link?.status === 'online' && Date.now() >= this.staleRetryAt) {
        this.staleRetryAt = Date.now() + 10_000
        void this.refresh()
      }
      return
    }
    this.showStale(wildsStale(this.deps.session))
    // The store found it held something the world doesn't (a refusal, an answer for land that turned): read again.
    if (takeReadRequest()) void this.refresh()
    if (view.version !== this.lastVersion) {
      this.lastVersion = view.version
      this.render(true)
    }
    const things = this.things()
    this.watchCamps(things)
    this.greetCamps(things)
    for (const a of this.attached.values()) a.sites.update()
  }

  /** A settle picked in an Echo camp conversation (the keep's offer keeps the lamp open). */
  settleEcho(siteId: string): boolean {
    return [...this.attached.values()].some((a) => a.sites.settleEcho(siteId))
  }

  /** A fresh near read around the hero's chunk (claims name the current cycle). */
  private refresh(): Promise<boolean> {
    const hero = this.deps.hero()
    const { cx, cy } = chunkOfPixel(hero.x, hero.y)
    return refreshNear(this.deps.session, cx, cy)
  }

  /** Every entity of the attached chunks, with its state. */
  private things(): WildsThing[] {
    return [...this.attached.values()].flatMap((a) => chunkThings(a.cx, a.cy))
  }

  private attachedAt(tx: number, ty: number): boolean {
    return this.attached.has(chunkKey(Math.floor(tx / CHUNK_TILES), Math.floor(ty / CHUNK_TILES)))
  }

  // ------------------------------------------------------------ claims

  /** What a thing offers now: harvest, claim, open or study (null: nothing to do). */
  private offerFor(e: WildsEntityView): WildsClaim | null {
    if (e.kind === 'node') {
      const m = materialOf(e.material)
      if (!m) return null
      return { label: `${m.harvestVerb} the ${m.name.toLowerCase()}`, verb: m.harvestVerb, claim: () => void this.claim(e.id) }
    }
    if (e.kind === 'camp') {
      return { label: 'Claim the camp', verb: 'Claim', claim: () => void this.claim(e.id) }
    }
    if (e.kind === 'chest') {
      return { label: 'Open the chest', verb: 'Open', claim: () => void this.claim(e.id) }
    }
    return { label: `Study the ${poiName(e.poi).toLowerCase()}`, verb: 'Study', claim: () => void this.claim(e.id) }
  }

  private relightOffer(l: WildsLanternView): WildsClaim {
    const own = this.deps.session.link ? l.ownerId === this.deps.session.link.accountId : false
    return {
      label: own ? 'Relight your lantern' : 'Relight the fallen lantern',
      verb: 'Relight',
      claim: () => void this.relight(l)
    }
  }

  /**
   * Claimable right now: nodes while their cycle is available, camps while
   * the near read names this cycle's fall claimable for this account (the
   * camp shows cleared from its fall until its next cycle; once per account
   * per cycle), chests and POIs once per player per epoch.
   */
  private claimable(e: WildsThing, nowSec: number): boolean {
    if (isClaimed(e.id)) return false
    if (e.kind === 'poi' || e.kind === 'chest') return true
    if (e.kind === 'camp') {
      const camp = this.campNow(e, nowSec)
      return !!camp && this.campOutcome.won(camp)
    }
    return entityAvailable(e, nowSec)
  }

  /** A camp as its claim names it: epoch, entity and projected cycle (null: its chunk's epoch isn't known). */
  private campNow(e: WildsThing, nowSec: number): CampNow | null {
    const epoch = chunkEpoch(e.cx, e.cy)?.id
    return epoch ? { id: e.id, epoch, cycle: entityCycle(e, nowSec), claimable: campClaimable(e, nowSec) } : null
  }

  private async claim(entityId: string): Promise<void> {
    if (this.claiming) return
    const session = this.deps.session
    const entity = this.things().find((e) => e.id === entityId)
    if (!entity) return
    if (!session.link) return
    this.claiming = true
    try {
      await this.claimConnected(entity)
    } finally {
      this.claiming = false
    }
  }

  private async claimConnected(entity: WildsThing): Promise<void> {
    const session = this.deps.session
    const before = chunkEpoch(entity.cx, entity.cy)?.id
    // A fresh read advances respawn cycles; the claim needs the current one.
    const ok = await this.refresh()
    const fresh = wildsLive(session)
    const epoch = chunkEpoch(entity.cx, entity.cy)
    // The read named a new wick: the land turned under the claim (the scene plays it).
    if (ok && epoch && before && epoch.id !== before) return
    if (!ok || !fresh || !epoch) {
      bus.emit(EV.toast, { text: CLAIM_ERROR.offline, kind: 'error' })
      return
    }
    const target = chunkThings(entity.cx, entity.cy).find((e) => e.id === entity.id)
    const nowSec = Math.floor(Date.now() / 1000)
    if (!target || !this.claimable(target, nowSec)) {
      if (target && target.kind === 'node' && !entityAvailable(target, nowSec)) {
        bus.emit(EV.toast, { text: CLAIM_ERROR['entity-unavailable'], kind: 'error' })
      }
      return
    }
    const camp = target.kind === 'camp' ? this.campNow(target, nowSec) : null
    const res = await claimEntity(session, { epoch: epoch.id, entityId: entity.id, cycle: entityCycle(target, nowSec), where: this.where() })
    if (!res.ok) {
      // Not this account's to claim again this cycle (claimed, or not a witness of its fall).
      // `not-defeated` (no fall stored yet) stays open: the next press is a new operation, a fresh key.
      if (camp && (res.code === 'already-claimed' || res.code === 'condition-unmet')) this.campOutcome.claimed(camp)
      this.claimError(res.code)
      return
    }
    if (camp) this.campOutcome.claimed(camp)
    const drop = applyClaim(res.result)
    this.lootFeedback(target, drop, res.result.papers)
    if (res.result.wardenSliverFound) {
      const session = this.deps.session
      // A story find, kept in the journal ("A Still Stone"): a gain, not a passing thought.
      bus.emit(EV.toast, { text: 'A chip of grey stone with an amber fleck. It sits very still in your hand.', icon: 'scroll', kind: 'gain', gain: { to: 'journal', label: 'A Still Stone' } })
      if (!session.state.flags.includes('warden-sliver:found')) {
        session.addFlag('warden-sliver:found')
        emitResidents(session)
      }
    }
    if (res.result.stormDropFound) {
      bus.emit(EV.toast, { text: 'A drop of amber with a bright core — storm-grade, kept for the old ways. The deep woods let it go.', icon: 'sparkle', art: 'icon-storm-grade-drop' })
    }
    // Personal claims and discoveries lists, complete.
    void this.refresh()
  }

  private claimError(code: string): void {
    // The epoch ended under us: the Beyond has turned (the scene plays it).
    if (code === 'epoch-ended') {
      bus.emit(EV.turning, { reason: 'epoch-ended' })
      return
    }
    bus.emit(EV.toast, { text: CLAIM_ERROR[code] ?? CLAIM_ERROR.unknown, kind: 'error' })
  }

  /** Relight a fallen hero's lantern (own ones too — the warm act, no reward). */
  private async relight(l: WildsLanternView): Promise<void> {
    const session = this.deps.session
    const view = wildsLive(session)
    if (!session.link || !view) return
    const { cx, cy } = { cx: Math.floor(l.x / CHUNK_TILES), cy: Math.floor(l.y / CHUNK_TILES) }
    const epoch = chunkEpoch(cx, cy)
    if (!epoch) return
    const res = await relightLantern(session, { epoch: epoch.id, ownerId: l.ownerId, lanternId: l.id, where: this.where() })
    if (!res.ok) {
      this.claimError(res.code)
      return
    }
    applyLanterns(res.result.lanterns, res.result.epoch)
    const loot = { materials: (res.result.loot?.materials ?? []).map((m) => ({ id: m.id, qty: m.qty })), trinket: res.result.loot?.trinket ?? null }
    sfx('lantern')
    const at = this.lanternPx(l)
    this.deps.fx.sparkBurst(at.x, at.y - 20, 10)
    const own = l.ownerId === session.link.accountId
    const text = own ? FALLEN_HERO_LANTERNS.yourOwnLantern : FALLEN_HERO_LANTERNS.relitByFriend
    bus.emit(EV.toast, { text, icon: 'lantern' })
    if (res.result.rewarded && lootText(loot)) {
      bus.emit(EV.toast, { text: `For the light: ${lootText(loot)}.`, icon: 'sparkle', art: lootArt(loot), kind: 'gain', gain: lootGain(loot) })
    }
  }

  /** The visible payoff of a claim: chest flavor, loot, papers (the server's, and the predicted find). */
  private lootFeedback(entity: WildsThing, drop: { materials: { id: string; qty: number }[]; trinket: string | null }, papers: readonly string[]): void {
    const at = this.entityPx(entity)
    if (drop.materials.length > 0 || drop.trinket) this.deps.fx.sparkBurst(at.x, at.y - 8, 12)
    const loot = lootText(drop)
    let text: string
    if (entity.kind === 'camp') text = loot ? `The camp is yours to rest at: ${loot}.` : 'The camp is yours to rest at.'
    else if (entity.kind === 'chest') text = loot ? `${pick(CHEST_OPEN_FLAVOR, entity.id)} ${loot}.` : pick(CHEST_OPEN_FLAVOR, entity.id) + '.'
    else if (entity.kind === 'node') text = `Harvested: ${loot}.`
    else text = loot ? `The Wilds give back: ${loot}.` : ''
    // Loot goes to the bag button; a chest's flavour alone is a passing thought.
    const kind: ToastPayload['kind'] = loot ? 'gain' : entity.kind === 'chest' ? 'thought' : 'info'
    if (text.trim()) bus.emit(EV.toast, { text, icon: 'sparkle', art: lootArt(drop), kind, ...(loot ? { gain: lootGain(drop) } : {}) })

    // Found texts ride their personal claim: the claim's answer names the
    // ones the server granted (already in the adopted state).
    for (const paper of new Set(papers)) {
      if (!this.deps.session.state.flags.includes(`paper:${paper}`)) grantPaper(this.deps.session, paper)
    }

    if (entity.kind === 'poi') this.poiDiscovery(entity)
  }

  /** POI discovery: the text in the reading panel, with the world's chart. */
  private poiDiscovery(entity: WildsEntityView): void {
    const info = POIS.find((p) => p.id === entity.poi)
    if (!info) return
    const disc = discoveryFor(entity.id)
    const by = disc?.displayName || this.deps.session.link?.name || 'you'
    openDialogue({
      id: `wilds-poi:${entity.id}`,
      speaker: info.name,
      lines: [info.discoveryText, `Charted by ${by}.`]
    }, { sound: 'discover' })
  }

  // ------------------------------------------------------------ internals

  /** Where the hero stands, as the server reads it: world pixels. */
  private where(): WildsWhere {
    const hero = this.deps.hero()
    return { x: hero.x, y: hero.y }
  }

  /** Fallen lanterns in the attached chunks (their x, y are world tiles). */
  private lanterns(): WildsLanternView[] {
    return [...(wildsView()?.lanterns.values() ?? [])].filter((l) => this.attachedAt(l.x, l.y))
  }

  /** Fallen lanterns in one chunk. */
  private lanternsIn(cx: number, cy: number): WildsLanternView[] {
    return [...(wildsView()?.lanterns.values() ?? [])].filter((l) => Math.floor(l.x / CHUNK_TILES) === cx && Math.floor(l.y / CHUNK_TILES) === cy)
  }

  private entityPx(e: WildsThing): { x: number; y: number } {
    return tileFeet(e.cx * CHUNK_TILES + e.tx, e.cy * CHUNK_TILES + e.ty)
  }

  private lanternPx(l: WildsLanternView): { x: number; y: number } {
    return { x: l.x * TILE + 8, y: l.y * TILE + TILE }
  }

  // ------------------------------------------------------------ rendering

  /** Every attached chunk's drawings brought up to date (null: nothing read yet, nothing shown). */
  private render(read: true | null): void {
    const done = perfSpan('things:render')
    this.publish(read)
    if (!read) for (const key of [...this.drawn.keys()]) this.undraw(key)
    else {
      const nowSec = Math.floor(Date.now() / 1000)
      for (const key of this.attached.keys()) this.draw(key, nowSec)
    }
    done()
  }

  /**
   * One chunk's things and lanterns drawn as they are now: what already
   * shows its look stays, what changed is drawn again, what went goes.
   */
  private draw(key: string, nowSec: number): void {
    const a = this.attached.get(key)
    if (!a) return
    const had = this.drawn.get(key) ?? new Map<string, Rendered>()
    const next = new Map<string, Rendered>()
    const fresh: Phaser.GameObjects.GameObject[] = []
    const keep = (id: string, look: string, make: () => Rendered) => {
      const r = had.get(id)
      if (r && r.look === look) {
        had.delete(id)
        next.set(id, r)
        return
      }
      const made = make()
      fresh.push(...made.images)
      next.set(id, made)
    }
    for (const e of chunkThings(a.cx, a.cy)) {
      const look = this.lookOf(e, nowSec)
      keep(e.id, look, () => this.renderEntity(e, nowSec, look))
    }
    for (const l of this.lanternsIn(a.cx, a.cy)) {
      const look = l.litBy ? 'lit' : 'dark'
      keep(l.id, look, () => this.renderLantern(l, look))
    }
    dropRendered(this.scene, had.values())
    addAll(this.scene, fresh)
    this.drawn.set(key, next)
  }

  /** A chunk's drawings go. */
  private undraw(key: string): void {
    dropRendered(this.scene, this.drawn.get(key)?.values() ?? [])
    this.drawn.delete(key)
  }

  /** What a thing shows: spent (depleted, or a chest or POI already claimed), and whether its cycle is out. */
  private lookOf(e: WildsThing, nowSec: number): string {
    const depleted = (e.kind === 'camp' || e.kind === 'node') && !entityAvailable(e, nowSec)
    const spent = depleted || ((e.kind === 'chest' || e.kind === 'poi') && isClaimed(e.id))
    return `${depleted ? 'depleted' : 'available'}|${spent ? 'spent' : 'fresh'}`
  }

  /**
   * This chunk's claims as interaction points: what's claimable now (a
   * node or camp in its cycle, a camp once its creatures are down, a chest
   * or POI once per epoch) and unlit fallen lanterns.
   */
  private publish(read: true | null): void {
    perfTime('things:publish', () => this.publishNow(read))
  }

  private publishNow(read: true | null): void {
    if (!read) return this.deps.interactables.register(this, [])
    const entities = this.things().map((e) =>
      wildsPoint(e.id, this.entityPx(e), 20, () => {
        // Nothing is offered from a stale view, or without a connection.
        const now = wildsLive(this.deps.session)
        return now && this.claimable(e, Math.floor(Date.now() / 1000)) ? this.offerFor(e) : null
      })
    )
    const lanterns = this.lanterns()
      .filter((l) => !l.litBy)
      .map((l) => wildsPoint(l.id, this.lanternPx(l), 32, () => (wildsLive(this.deps.session) ? this.relightOffer(l) : null)))
    this.deps.interactables.register(this, [...entities, ...lanterns])
  }

  private renderEntity(e: WildsThing, nowSec: number, look: string): Rendered {
    const scene = this.scene
    const at = this.entityPx(e)
    const images: Phaser.GameObjects.Image[] = []
    const tweens: Phaser.Tweens.Tween[] = []
    const add = (tex: string, frame: string | undefined, h: number, dy = 0, dx = 0): void => {
      const img = looseImage(scene, at.x + dx, at.y + dy, tex, frame)
      const f = frame ? scene.textures.get(tex).get(frame)! : scene.textures.get(tex).get()
      img.setOrigin(0.5, 1).setScale(h / f.height).setDepth(at.y + dy - 2)
      images.push(img)
    }
    /** A delivered Commons-pass frame at its native size; null when it didn't load. */
    const native = (frame: string, dy = 0, dx = 0): Phaser.GameObjects.Image | null => {
      const key = commonsArt(scene, frame)
      if (!key) return null
      const img = looseImage(scene, at.x + dx, at.y + dy, key).setOrigin(0.5, 1).setDepth(at.y + dy - 2)
      images.push(img)
      return img
    }
    const depleted = (e.kind === 'camp' || e.kind === 'node') && !entityAvailable(e, nowSec)
    // Delivered art that already shows its spent state isn't faded as well.
    let showsSpent = false
    if (e.kind === 'camp') {
      if (commonsArt(scene, 'wilds-tent') && commonsArt(scene, 'wilds-fire-ring') && commonsArt(scene, 'wilds-pack')) {
        // A small tent behind, the fire ring beside the scattered pack.
        native('wilds-tent', -6, 2)
        native('wilds-fire-ring', 0, -14)
        native('wilds-pack', 1, 13)
        // Someone's camp: a small flame in the ring until it's cleared.
        const flicker = commonsAnim(scene, 'camp-flame-animation')
        if (!depleted && flicker) {
          const flame = scene.make.sprite({ x: at.x - 14, y: at.y - 3, key: 'commons-art:camp-flame-0' }, false).setOrigin(0.5, 1).setDepth(at.y - 1)
          if (!this.deps.reducedMotion) flame.play({ key: flicker, startFrame: Math.floor(Math.random() * 3) })
          images.push(flame)
        }
      } else {
        // The fire sits beside the pack (the cot), not behind it.
        add('wilds-campfire', undefined, 12, 0, -13)
        add('fingersnap-props', 'expedition-backpack', 18, -2)
      }
    } else if (e.kind === 'node') {
      if (native(`resource-${e.material}-${depleted ? 'depleted' : 'available'}`)) showsSpent = true
      else {
        const frame = NODE_FRAME[e.material] ?? NODE_FRAME.fiber
        add(frame.tex, frame.frame, frame.h)
      }
    } else if (e.kind === 'chest') {
      add('fingersnap-props', 'treasure-chest', 16)
    } else {
      const frame = POI_FRAME[e.poi] ?? POI_FRAME.waystone
      add(frame.tex, frame.frame, frame.h)
    }
    // Depleted and already-claimed things read as spent.
    const spent = depleted || ((e.kind === 'chest' || e.kind === 'poi') && isClaimed(e.id))
    if (spent) {
      if (!showsSpent) for (const img of images) img.setAlpha(0.45)
    } else if (e.kind !== 'camp') {
      // A small glint over anything claimable, so attention finds it.
      const glint = looseImage(scene, at.x, at.y - 22, 'spark').setDepth(at.y + 3).setBlendMode(1)
      if (this.deps.reducedMotion) glint.setAlpha(0.7)
      else tweens.push(scene.tweens.add({ targets: glint, y: at.y - 26, alpha: { from: 0.85, to: 0.35 }, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' }))
      images.push(glint)
    }
    return { look, images, tweens }
  }

  private renderLantern(l: WildsLanternView, look: string): Rendered {
    const scene = this.scene
    const at = this.lanternPx(l)
    // A fallen hero's lantern (Commons pass), lit or dark; else a road post.
    const delivered = commonsArt(scene, `fallen-hero-lantern-${l.litBy ? 'lit' : 'unlit'}`)
    const post = delivered
      ? looseImage(scene, at.x, at.y, delivered).setOrigin(0.5, 1).setDepth(at.y)
      : looseImage(scene, at.x, at.y, 'fingersnap-props', 'lantern-post')
        .setOrigin(0.5, 1)
        .setScale(28 / scene.textures.get('fingersnap-props').get('lantern-post')!.height)
        .setDepth(at.y)
    const images = [post]
    const tweens: Phaser.Tweens.Tween[] = []
    if (l.litBy) {
      const glow = looseImage(scene, at.x, at.y - (delivered ? 10 : 18), 'glow').setBlendMode(1).setTint(0xffb054).setScale(0.5).setAlpha(0.75).setDepth(at.y + 2)
      if (!this.deps.reducedMotion) {
        tweens.push(scene.tweens.add({ targets: glow, alpha: { from: 0.65, to: 0.4 }, scale: { from: 0.48, to: 0.55 }, duration: 1400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' }))
      }
      images.push(glow)
    } else if (!delivered) {
      post.setAlpha(0.8)
    }
    return { look, images, tweens }
  }

  // ------------------------------------------------------------ camps

  /** Every frame: a camp its room shows won asks the near read for the server's word (./camp-fights.ts). */
  private watchCamps(things: readonly WildsThing[]): void {
    const nowSec = Math.floor(Date.now() / 1000)
    for (const e of things) {
      const camp = e.kind === 'camp' ? this.campNow(e, nowSec) : null
      if (camp) this.campOutcome.won(camp)
    }
  }

  /** A walk-in line the first time the hero nears a lived-in camp. */
  private greetCamps(things: readonly WildsThing[]): void {
    const nowSec = Math.floor(Date.now() / 1000)
    for (const e of things) {
      if (e.kind !== 'camp' || this.greeted.has(e.id) || !entityAvailable(e, nowSec)) continue
      const at = this.entityPx(e)
      const hero = this.deps.hero()
      if (Math.hypot(hero.x - at.x, hero.y - at.y) > 56) continue
      this.greeted.add(e.id)
      bus.emit(EV.toast, { text: pick(CAMP_WALK_IN_LINES, e.id), icon: 'sparkle', kind: 'thought' })
    }
  }

  // ------------------------------------------------------------ e2e hooks

  /** Read-only dump for playtests: what the Wilds look like right now. */
  debug(): {
    epochId: string
    stillEpoch: string
    wickEpoch: string
    stale: boolean
    season: string
    endsAt: number | null
    chunks: { cx: number; cy: number }[]
    sites: (ReturnType<WildsSites['debug']>[number] & { cx: number; cy: number })[]
    chunk: { cx: number; cy: number }
    position: { x: number; y: number }
    entities: Array<{
      id: string
      kind: string
      chunk: { cx: number; cy: number }
      tx: number
      ty: number
      worldPx: { x: number; y: number }
      state: string
      cycle: number
      availableIn: number
      claimable: boolean
      material: string
      tier: number
      poi: string
      enemies: string[]
    }>
    lanterns: Array<{ id: string; ownerId: string; own: boolean; lit: boolean; x: number; y: number }>
    materials: Record<string, number>
    claims: string[]
    discoveries: Array<{ entityId: string; poiId: string; by: string }>
  } | null {
    const view = wildsView()
    if (!view) return null
    const nowSec = Math.floor(Date.now() / 1000)
    const hero = this.deps.hero()
    const here = chunkOfPixel(hero.x, hero.y)
    return {
      epochId: chunkEpoch(here.cx, here.cy)?.id ?? '',
      stillEpoch: view.still.id,
      wickEpoch: view.wick.id,
      stale: wildsStale(this.deps.session),
      season: view.wick.season,
      endsAt: wickEndsAt(),
      chunks: [...this.attached.values()].map((a) => ({ cx: a.cx, cy: a.cy })),
      sites: [...this.attached.values()].flatMap((a) => a.sites.debug().map((s) => ({ ...s, cx: a.cx, cy: a.cy }))),
      chunk: chunkOfPixel(hero.x, hero.y),
      position: { x: Math.round(hero.x), y: Math.round(hero.y) },
      entities: this.things().map((e) => ({
        id: e.id,
        kind: e.kind,
        chunk: { cx: e.cx, cy: e.cy },
        tx: e.tx,
        ty: e.ty,
        worldPx: { x: (e.cx * CHUNK_TILES + e.tx) * TILE + TILE / 2, y: (e.cy * CHUNK_TILES + e.ty) * TILE + TILE / 2 },
        state: e.state,
        cycle: e.cycle,
        availableIn: Math.max(0, e.available_at - nowSec),
        claimable: this.claimable(e, nowSec),
        material: e.material,
        tier: e.tier,
        poi: e.poi,
        enemies: e.enemies
      })),
      lanterns: [...view.lanterns.values()].map((l) => ({
        id: l.id,
        ownerId: l.ownerId,
        own: this.deps.session.link ? l.ownerId === this.deps.session.link.accountId : false,
        lit: !!l.litBy,
        x: l.x,
        y: l.y
      })),
      materials: { ...view.materials },
      claims: [...view.claims],
      discoveries: [...view.discoveries.values()].map((d) => ({ entityId: d.entityId, poiId: d.poiId, by: d.displayName }))
    }
  }
}

function pick(list: readonly string[], seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return list[h % list.length]
}
