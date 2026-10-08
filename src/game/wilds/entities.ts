/**
 * Wilds entities — the generated things inside one chunk scene: camps (their
 * enemies spawn from the camp's mix; when all are down the camp is
 * claimable), resource nodes (harvest prompt with the material's verb),
 * personal chests, points of interest (discovery text; "Charted by {name}"
 * for the world's first discoverer), and other members' fallen-hero
 * lanterns (relightable).
 *
 * Everything renders from the region store (src/game/wilds/store.ts) — the
 * served chunks' bodies with the server's cycles and claims — and re-renders
 * when the store's version moves. Claims and relights are operations
 * (./remote.ts). Each claimable thing is
 * an interaction point (../entities/interactables.ts) that outranks the
 * people and props around it; the action key claims it.
 *
 * Papers: two POIs and the tier-3 chests carry found texts (papers.ts
 * sources `wilds-poi` / `wilds-chest`). The server grants them with the
 * claim; WILDS_PAPER_PLACEMENTS predicts which.
 */
import type Phaser from 'phaser'
import { TRANSPORT_ERRORS } from '../../content/errors'
import {
  CAMP_WALK_IN_LINES,
  CHEST_OPEN_FLAVOR,
  FALLEN_HERO_LANTERNS,
  MATERIALS,
  POIS,
} from '../../content/expansion-writing.ts'
import type { WildsEntityView, WildsLanternView } from '../../lib/api/types.ts'
import { CHUNK_TILES, parseChunkArea, toRegionPosition, wildsRegion } from './regions.ts'
import { claimEntity, relightLantern, type WildsWhere } from './remote.ts'
import {
  applyClaim,
  applyLanterns,
  discoveryFor,
  entityAvailable,
  isClaimed,
  lootName,
  lootText,
  refreshWilds,
  wildsEpoch,
  wildsEpochEndsAt,
  wildsLive,
  wildsStale,
  wildsView,
  type WildsView,
} from './store.ts'
import { WildsSites, wildsPoint, type WildsClaim } from './sites.ts'
import { grantPaper } from '../papers'
import { bus, EV, type ToastPayload } from '../events'
import { sfx } from '../sfx'
import { emitResidents } from '../residents'
import { commonsAnim, commonsArt } from '../commons-pass'
import { TILE, tileFeet, tileMid } from '../../lib/tile'
import type { Session } from '../session'
import type { Effects } from '../entities/fx'
import type { EnemySystem } from '../entities/enemies'
import type { Interactables } from '../entities/interactables'
import type { EnemyType, WorldData } from '../worlds'

/** Server error code → what the player reads. All text is static. */
const CLAIM_ERROR: Record<string, string> = {
  'old-cycle': 'Someone got there first — it will come back.',
  'entity-unavailable': 'Someone got there first — it will come back.',
  'already-claimed': 'You have already claimed this one.',
  'too-far-away': 'Too far away — step closer.',
  'not-in-wilds': 'That only works out in the Wilds.',
  'epoch-ended': 'The Wilds shift. Make your way back to the entrance.',
  'claim-rate-limited': 'That is plenty of gathering for one minute. Take a breath.',
  offline: 'Needs a connection. The Wilds keep what you have not claimed.',
  superseded: TRANSPORT_ERRORS.superseded,
  busy: TRANSPORT_ERRORS.busy,
  pending: TRANSPORT_ERRORS.pending,
  unknown: 'The Wilds didn’t answer. Nothing was taken — try again in a moment.',
}

/**
 * Deterministic paper placements live in ./placements.ts (with the reasoning);
 * claimed POIs and tier-3 chests carry their find.
 */
import { wildsPaperFor } from './placements.ts'
import { openDialogue } from '../dialogue.ts'

export interface WildsDeps {
  world: WorldData
  session: Session
  fx: Effects
  enemies: EnemySystem
  reducedMotion: boolean
  interactables: Interactables
  hero: () => { x: number; y: number }
}

interface Rendered {
  images: Phaser.GameObjects.Image[]
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
  'wilds-pond': {
    rows: [
      '...oooooo....',
      '.oiIIIIIIio..',
      'oIIWIIIIIIMo.',
      'oIIIWIIIIMMo.',
      'oIIIIIWIIIMo.',
      '.oiIIIIIIio..',
      '...oooooo....'
    ],
    pal: { o: '#3a2a28', i: '#9cc3d8', I: '#c3dcea', W: '#fffbef', M: '#7fa8c0' }
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

function ensureArt(scene: Phaser.Scene): void {
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
  'frozen-pond': { tex: 'wilds-pond', h: 10 },
  'abandoned-cart': { tex: 'wilds-cart', h: 14 },
  'mossy-arch': { tex: 'fingersnap-foreground', frame: 'stone-arch', h: 30 },
}

/** The delivered icon for a loot toast: the find, else the first material. */
const lootArt = (drop: { materials: { id: string }[]; trinket: string | null }): string | undefined =>
  drop.trinket ? `icon-${drop.trinket}` : drop.materials[0] ? `icon-${drop.materials[0].id}` : undefined

/**
 * What a drop put in the bag, for the bag button: the first item, and its
 * count when it's the only one; mixed loot says what it was ("3 Fiber, 1 Amber").
 */
const lootGain = (drop: { materials: { id: string; qty: number }[]; trinket: string | null }): ToastPayload['gain'] => {
  const first = drop.trinket ?? drop.materials[0]?.id
  if (!first) return undefined
  const single = drop.materials.length + (drop.trinket ? 1 : 0) === 1
  if (single) return { to: 'bag', itemDef: first, qty: drop.trinket ? 1 : drop.materials[0].qty }
  const label = [...drop.materials.map((m) => `${m.qty} ${lootName(m.id)}`), ...(drop.trinket ? [lootName(drop.trinket)] : [])].join(', ')
  return { to: 'bag', itemDef: first, label }
}

const poiName = (id: string): string => POIS.find((p) => p.id === id)?.name ?? id
const materialOf = (id: string) => MATERIALS.find((m) => m.id === id)

export class WildsEntities {
  private chunk: { region: string; cx: number; cy: number }
  /** Story sites in this chunk: Echo camps and given-back finds. */
  private sites: WildsSites
  private rendered = new Map<string, Rendered>()
  private spawnedCamps = new Set<string>()
  private greeted = new Set<string>()
  private claiming = false
  private lastVersion = -1
  /** Shown as last seen (no fresh read, or no connection): the label, and when to try again. */
  private staleLabel: Phaser.GameObjects.Text | null = null
  private staleRetryAt = 0

  constructor(private scene: Phaser.Scene, private deps: WildsDeps) {
    this.chunk = parseChunkArea(deps.world.areaId) ?? { region: 'inner-1', cx: 0, cy: 0 }
    ensureArt(scene)
    this.sites = new WildsSites(
      scene,
      { session: deps.session, fx: deps.fx, reducedMotion: deps.reducedMotion, interactables: deps.interactables, hero: deps.hero },
      wildsEpoch(this.chunk.region),
      this.chunk.cx,
      this.chunk.cy,
      deps.world.storySites ?? []
    )
    scene.events.once('shutdown', () => {
      this.rendered.clear()
      this.staleLabel = null
    })
    this.render(wildsView())
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
      void refreshWilds(session, 0, this.chunk.region)
    }
  }

  // ------------------------------------------------------------ per frame

  update(): void {
    const view = wildsView()
    if (!view) return
    this.showStale(wildsStale(this.deps.session, this.chunk.region))
    if (view.version !== this.lastVersion) {
      this.lastVersion = view.version
      this.render(view)
    }
    this.spawnCampEnemies(view)
    this.greetCamps(view)
    this.sites.update()
  }

  /** A settle picked in an Echo camp conversation (the keep's offer keeps the lamp open). */
  settleEcho(siteId: string): boolean {
    return this.sites.settleEcho(siteId)
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
   * Claimable right now: nodes and camps while their cycle is available
   * (camps additionally only once their enemies are down), chests and POIs
   * once per player per epoch.
   */
  private claimable(e: WildsEntityView, _view: WildsView, nowSec: number): boolean {
    if (isClaimed(e.id)) return false
    if (e.kind === 'poi' || e.kind === 'chest') return true
    if (!entityAvailable(e, nowSec)) return false
    if (e.kind === 'camp') return this.campCleared(e.id)
    return true
  }

  /** A camp is claimable when every enemy it spawned is down. */
  private campCleared(campId: string): boolean {
    const prefix = `wilds:${campId}`
    const live = this.deps.enemies.enemies.some((e) => !e.dead && e.id.startsWith(prefix))
    return this.spawnedCamps.has(campId) && !live
  }

  private async claim(entityId: string): Promise<void> {
    if (this.claiming) return
    const session = this.deps.session
    const view = wildsView()
    const entity = view?.entities.find((e) => e.id === entityId)
    if (!view || !entity) return
    if (!session.link) return
    this.claiming = true
    try {
      await this.claimConnected(entity)
    } finally {
      this.claiming = false
    }
  }

  private async claimConnected(entity: WildsEntityView): Promise<void> {
    const session = this.deps.session
    // A fresh read advances respawn cycles; the claim needs the current one.
    const ok = await refreshWilds(session)
    const fresh = wildsLive(session)
    if (!ok || !fresh) {
      bus.emit(EV.toast, { text: CLAIM_ERROR.offline, kind: 'error' })
      return
    }
    const target = fresh.entities.find((e) => e.id === entity.id)
    const nowSec = Math.floor(Date.now() / 1000)
    if (!target || !this.claimable(target, fresh, nowSec)) {
      if (target && (target.kind === 'camp' || target.kind === 'node') && !entityAvailable(target, nowSec)) {
        bus.emit(EV.toast, { text: CLAIM_ERROR['entity-unavailable'], kind: 'error' })
      }
      return
    }
    const res = await claimEntity(session, { epoch: fresh.epochId, entityId: entity.id, cycle: target.cycle, where: this.where() })
    if (!res.ok) {
      this.claimError(res.code)
      return
    }
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
    void refreshWilds(session, 0)
  }

  private claimError(code: string): void {
    // The epoch ended under us: the outer Wilds have turned (the scene plays it).
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
    const res = await relightLantern(session, { epoch: view.epochId, ownerId: l.ownerId, lanternId: l.id, where: this.where() })
    if (!res.ok) {
      this.claimError(res.code)
      return
    }
    applyLanterns(res.result.lanterns)
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
  private lootFeedback(entity: WildsEntityView, drop: { materials: { id: string; qty: number }[]; trinket: string | null }, papers: readonly string[]): void {
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

    // Found texts ride their personal claim (see ./placements.ts). Connected,
    // the claim's answer names the ones the server granted (already in the
    // adopted state); a take of the client's own guess would be refused.
    const paperId = this.deps.session.link ? null : wildsPaperFor(entity, this.chunk.cx, wildsRegion(this.chunk.region).gridWidth, this.deps.session.state.quest === 'complete')
    for (const paper of new Set([...papers, ...(paperId ? [paperId] : [])])) {
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

  // ------------------------------------------------------------ defeat

  /**
   * A fall in the Wilds leaves its lantern through the `fall` operation: the
   * server places it where `where` says (server-first.md 2.2, "Falls").
   * Nothing to send from here; kept so the scene's fall path stays one call.
   */
  reportDefeat(): Promise<void> | null {
    return null
  }

  // ------------------------------------------------------------ internals

  /** Where the hero stands, as the server reads it: this region, region-wide pixels. */
  private where(): WildsWhere {
    return { region: this.chunk.region, ...this.regionPosition() }
  }

  private regionPosition(): { x: number; y: number } {
    const hero = this.deps.hero()
    return toRegionPosition(this.chunk.cx, this.chunk.cy, hero.x, hero.y)
  }

  private chunkEntities(view: WildsView): WildsEntityView[] {
    return view.entities.filter((e) => this.ownEntity(e))
  }

  private ownEntity(e: WildsEntityView): boolean {
    const parts = e.id.split(':')
    if (parts.length !== 4) return false
    return Number(parts[1]) === this.chunk.cx && Number(parts[2]) === this.chunk.cy
  }

  private chunkLanterns(view: WildsView): WildsLanternView[] {
    return view.lanterns.filter((l) => Math.floor(l.x / CHUNK_TILES) === this.chunk.cx && Math.floor(l.y / CHUNK_TILES) === this.chunk.cy)
  }

  private entityPx(e: WildsEntityView): { x: number; y: number } {
    return tileFeet(e.tx, e.ty)
  }

  private lanternPx(l: WildsLanternView): { x: number; y: number } {
    const lx = (l.x - this.chunk.cx * CHUNK_TILES) * TILE + 8
    const ly = (l.y - this.chunk.cy * CHUNK_TILES) * TILE + TILE
    return { x: lx, y: ly }
  }

  // ------------------------------------------------------------ rendering

  private render(view: WildsView | null): void {
    for (const r of this.rendered.values()) for (const img of r.images) img.destroy()
    this.rendered.clear()
    this.publish(view)
    if (!view) return
    const nowSec = Math.floor(Date.now() / 1000)
    for (const e of this.chunkEntities(view)) {
      this.rendered.set(e.id, { images: this.renderEntity(e, nowSec) })
    }
    for (const l of this.chunkLanterns(view)) {
      this.rendered.set(l.id, { images: this.renderLantern(l) })
    }
  }

  /**
   * This chunk's claims as interaction points: what's claimable now (a
   * node or camp in its cycle, a camp once its creatures are down, a chest
   * or POI once per epoch) and unlit fallen lanterns.
   */
  private publish(view: WildsView | null): void {
    if (!view) return this.deps.interactables.register(this, [])
    const entities = this.chunkEntities(view).map((e) =>
      wildsPoint(e.id, this.entityPx(e), 20, () => {
        // Nothing is offered from a stale view, or without a connection.
        const now = wildsLive(this.deps.session)
        return now && this.claimable(e, now, Math.floor(Date.now() / 1000)) ? this.offerFor(e) : null
      })
    )
    const lanterns = this.chunkLanterns(view)
      .filter((l) => !l.litBy)
      .map((l) => wildsPoint(l.id, this.lanternPx(l), 32, () => (wildsLive(this.deps.session) ? this.relightOffer(l) : null)))
    this.deps.interactables.register(this, [...entities, ...lanterns])
  }

  private renderEntity(e: WildsEntityView, nowSec: number): Phaser.GameObjects.Image[] {
    const scene = this.scene
    const at = this.entityPx(e)
    const images: Phaser.GameObjects.Image[] = []
    const add = (tex: string, frame: string | undefined, h: number, dy = 0, dx = 0): void => {
      const img = frame ? scene.add.image(at.x + dx, at.y + dy, tex, frame) : scene.add.image(at.x + dx, at.y + dy, tex)
      const f = frame ? scene.textures.get(tex).get(frame)! : scene.textures.get(tex).get()
      img.setOrigin(0.5, 1).setScale(h / f.height).setDepth(at.y + dy - 2)
      images.push(img)
    }
    /** A delivered Commons-pass frame at its native size; null when it didn't load. */
    const native = (frame: string, dy = 0, dx = 0): Phaser.GameObjects.Image | null => {
      const key = commonsArt(scene, frame)
      if (!key) return null
      const img = scene.add.image(at.x + dx, at.y + dy, key).setOrigin(0.5, 1).setDepth(at.y + dy - 2)
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
          const flame = scene.add.sprite(at.x - 14, at.y - 3, 'commons-art:camp-flame-0').setOrigin(0.5, 1).setDepth(at.y - 1)
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
      const glint = scene.add.image(at.x, at.y - 22, 'spark').setDepth(at.y + 3).setBlendMode(1)
      if (this.deps.reducedMotion) glint.setAlpha(0.7)
      else scene.tweens.add({ targets: glint, y: at.y - 26, alpha: { from: 0.85, to: 0.35 }, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
      images.push(glint)
    }
    return images
  }

  private renderLantern(l: WildsLanternView): Phaser.GameObjects.Image[] {
    const scene = this.scene
    const at = this.lanternPx(l)
    // A fallen hero's lantern (Commons pass), lit or dark; else a road post.
    const delivered = commonsArt(scene, `fallen-hero-lantern-${l.litBy ? 'lit' : 'unlit'}`)
    const post = delivered
      ? scene.add.image(at.x, at.y, delivered).setOrigin(0.5, 1).setDepth(at.y)
      : scene.add.image(at.x, at.y, 'fingersnap-props', 'lantern-post')
        .setOrigin(0.5, 1)
        .setScale(28 / scene.textures.get('fingersnap-props').get('lantern-post')!.height)
        .setDepth(at.y)
    const images = [post]
    if (l.litBy) {
      const glow = scene.add.image(at.x, at.y - (delivered ? 10 : 18), 'glow').setBlendMode(1).setTint(0xffb054).setScale(0.5).setAlpha(0.75).setDepth(at.y + 2)
      if (!this.deps.reducedMotion) {
        scene.tweens.add({ targets: glow, alpha: { from: 0.65, to: 0.4 }, scale: { from: 0.48, to: 0.55 }, duration: 1400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
      }
      images.push(glow)
    } else if (!delivered) {
      post.setAlpha(0.8)
    }
    return images
  }

  // ------------------------------------------------------------ camps

  /** Spawn an available camp's enemies from its generated mix (once per camp). */
  private spawnCampEnemies(view: WildsView): void {
    const nowSec = Math.floor(Date.now() / 1000)
    for (const e of this.chunkEntities(view)) {
      if (e.kind !== 'camp') continue
      if (this.spawnedCamps.has(e.id) || !entityAvailable(e, nowSec)) continue
      this.spawnedCamps.add(e.id)
      const offsets = [
        [0, 0],
        [1, 0],
        [0, 1]
      ]
      e.enemies.slice(0, 3).forEach((type, i) => {
        const [ox, oy] = offsets[i % offsets.length]
        this.deps.enemies.spawnWilds(`wilds:${e.id}:${i}`, type as EnemyType, e.tx + ox, e.ty + oy)
      })
    }
  }

  /** A walk-in line the first time the hero nears a lived-in camp. */
  private greetCamps(view: WildsView): void {
    const nowSec = Math.floor(Date.now() / 1000)
    for (const e of this.chunkEntities(view)) {
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
    stale: boolean
    region: string
    season: string
    endsAt: number | null
    sites: ReturnType<WildsSites['debug']>
    chunk: { cx: number; cy: number }
    position: { x: number; y: number }
    entities: Array<{
      id: string
      kind: string
      chunk: { cx: number; cy: number }
      tx: number
      ty: number
      regionPx: { x: number; y: number }
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
    const p = this.regionPosition()
    return {
      epochId: view.epochId,
      stale: wildsStale(this.deps.session, this.chunk.region),
      region: this.chunk.region,
      season: wildsEpoch(this.chunk.region).season,
      endsAt: wildsEpochEndsAt(this.chunk.region),
      sites: this.sites.debug(),
      chunk: { cx: this.chunk.cx, cy: this.chunk.cy },
      position: p,
      entities: view.entities.map((e) => {
        const parts = e.id.split(':')
        return {
          id: e.id,
          kind: e.kind,
          chunk: { cx: Number(parts[1]), cy: Number(parts[2]) },
          tx: e.tx,
          ty: e.ty,
          regionPx: toRegionPosition(Number(parts[1]), Number(parts[2]), tileMid(e.tx), tileMid(e.ty)),
          state: e.state,
          cycle: e.cycle,
          availableIn: Math.max(0, e.available_at - nowSec),
          claimable: this.claimable(e, view, nowSec),
          material: e.material,
          tier: e.tier,
          poi: e.poi,
          enemies: e.enemies
        }
      }),
      lanterns: view.lanterns.map((l) => ({
        id: l.id,
        ownerId: l.ownerId,
        own: this.deps.session.link ? l.ownerId === this.deps.session.link.accountId : false,
        lit: !!l.litBy,
        x: l.x,
        y: l.y
      })),
      materials: { ...view.materials },
      claims: [...view.claims],
      discoveries: view.discoveries.map((d) => ({ entityId: d.entityId, poiId: d.poiId, by: d.displayName }))
    }
  }
}

function pick(list: readonly string[], seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return list[h % list.length]
}
