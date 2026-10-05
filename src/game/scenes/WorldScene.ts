/**
 * WorldScene — orchestration only: lifecycle (create/update/shutdown), area
 * transitions, camera and zoom, input dispatch, wiring to the session and
 * the event bus, the scripted beats, and the playtest hooks.
 *
 * Area construction lives in src/game/area/ (from WorldData produced by
 * src/game/worlds.ts). Entities — hero, avatar, enemies, projectiles, NPCs,
 * interactables, effects — live in src/game/entities/. Remote players have a
 * wired seam (entities/remote-players.ts) with no networking yet.
 */
import Phaser from 'phaser'
import type { AreaId, QuestEvent } from '../../lib/state'
import { itemInfo } from '../../content/world'
import { buildGround } from '../area/terrain'
import { buildSolids } from '../area/collision'
import { buildProps } from '../area/props'
import { buildForeground, updateOccluders as updateAreaOccluders, type Occluder } from '../area/foreground'
import { buildExitSigns } from '../area/exits'
import { refreshLanternVisuals, type LightProp } from '../area/lanterns'
import { bus, EV, type DialogueClosedPayload, type RelocatePayload } from '../events'
import { prefersReducedMotion, sfx } from '../sfx'
import { touchVec, uiBlocked, uiState } from '../input'
import { TILE } from '../textures'
import type { Session } from '../session'
import { buildArea, hasAreaKind, type EnemyType, type WorldData } from '../worlds'
import { CHARM_ITEM, ROAD_LANTERNS, isLit, type EmberSpend, type RoadLanternId } from '../../lib/embers'
import { maybeNudgePip } from '../nudges' // P1 onboarding
import { AvatarVisual } from '../entities/avatar'
import { Hero } from '../entities/hero'
import { EnemySystem } from '../entities/enemies'
import { Projectiles } from '../entities/projectiles'
import { Interactables } from '../entities/interactables'
import { PaperPickups } from '../entities/papers'
import { Effects } from '../entities/fx'
import { NPC_NAMES, Npcs } from '../entities/npcs'
import { createRemotePlayers, showEmoteBubble, type RemotePlayers } from '../entities/remote-players'
import { presence } from '../presence'
import { presenceAreaFor } from '../../lib/presence-client'
import type { EmotePayload } from '../events'
import { HomesteadLayer } from '../entities/homesteads'
import { VillageLayer } from '../entities/village-life'
import { buildRoom, ROOM_ENTRY } from '../cottage'
import { COMMONS_FROM_WILDS } from '../commons'
import {
  WILDS_AREA,
  fromRegionPosition,
  inRegion,
  isWildsArea,
  parseChunkArea,
  toRegionPosition,
  wildsArrivalPosition,
  wildsReturnTile,
  wildsSceneEntry,
} from '../wilds/regions'
import { ensureWildsAreaKinds, prepareWilds, wildsEpoch } from '../wilds/store'
import { WildsEntities, type WildsAction } from '../wilds/entities'

interface SceneData {
  entry?: { tx: number; ty: number }
  fromDefeat?: boolean
  /** Inside a cottage on the Commons: whose, and the doorstep outside it. */
  room?: { owner: string; doorstep: { tx: number; ty: number } }
}

/** Keyboard focus is on a control in the placement tray. */
function trayFocused(): boolean {
  const el = typeof document !== 'undefined' ? document.activeElement : null
  return !!el && el !== document.body && !!el.closest?.('[data-testid="placement-tray"]')
}

/** Areas where the zero-HP lock still lets you walk (home to rest). */
const SAFE_AREAS = ['village', 'commons']

/**
 * Can the scene go here? Registered areas, plus the Wilds: its chunk kinds
 * register lazily once the region loads (prepareWilds), so `wilds` and
 * `chunk:…` targets count before that.
 */
function canEnter(area: string): boolean {
  return hasAreaKind(area) || area === WILDS_AREA || parseChunkArea(area) !== null
}

export class WorldScene extends Phaser.Scene {
  private session!: Session
  private world!: WorldData
  private fx!: Effects
  private remotePlayers!: RemotePlayers
  /** Wilds entities for a generated chunk scene (null in curated areas). */
  private wilds: WildsEntities | null = null
  /** Collisions for terrain tiles and prop footprints (area/collision). */
  private solidGroup!: Phaser.Physics.Arcade.StaticGroup
  /** Atlas-prop lanterns that can glow when lit (area/lanterns owns visuals). */
  private lightProps: LightProp[] = []
  /** Foreground canopies/arches that fade when something walks beneath. */
  private occluders: Occluder[] = []
  private interactables!: Interactables
  private hero!: Hero
  private npcs!: Npcs
  private enemies!: EnemySystem
  private projectiles!: Projectiles
  private avatar!: AvatarVisual
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys
  private wasd!: Record<string, Phaser.Input.Keyboard.Key>
  private actionKeys!: Record<string, Phaser.Input.Keyboard.Key>
  private transitioning = false
  private reducedMotion = false
  private captureReleased = false
  private cinematic = false
  private positionTimer = 0
  /** This area's presence room (null where presence doesn't reach). */
  private presenceArea: string | null = null
  /** The Commons/cottage homestead layer (null elsewhere). */
  private homesteads: HomesteadLayer | null = null
  private room: SceneData['room'] | null = null

  constructor() {
    super('World')
  }

  init(data: SceneData): void {
    this.transitioning = false
    this.pendingEntry = data?.entry ?? null
    this.pendingDefeatToast = data?.fromDefeat === true
    this.room = data?.room ?? null
  }

  private pendingEntry: { tx: number; ty: number } | null = null
  private pendingDefeatToast = false

  create(): void {
    this.session = this.registry.get('session') as Session
    const state = this.session.state
    // A cottage is a view on the Commons: the save keeps saying Commons.
    if (this.room && state.area !== 'commons') this.room = null
    // Wilds: resolve the saved region-wide position into its chunk area and
    // a chunk-local arrival tile (see src/game/wilds/regions.ts).
    const wildsEntry = wildsSceneEntry(state, wildsEpoch())
    this.wilds = null
    if (wildsEntry) ensureWildsAreaKinds(wildsEpoch())
    // A save (or a server relocation) in an area this build can't draw comes
    // back in at the Commons arch.
    if (!wildsEntry && !hasAreaKind(state.area)) {
      const back = hasAreaKind('commons') ? { area: 'commons', at: COMMONS_FROM_WILDS } : { area: 'village', at: { tx: 7, ty: 11 } }
      state.area = back.area
      state.position = { x: (back.at.tx + 0.5) * TILE, y: (back.at.ty + 0.5) * TILE }
      this.pendingEntry = { ...back.at }
      this.session.saveSoon()
    }
    this.world = this.room ? buildRoom(this.room.doorstep) : wildsEntry ? buildArea(wildsEntry.areaId) : buildArea(state.area)
    this.occluders = []
    this.cinematic = false
    this.captureReleased = false
    this.reducedMotion = prefersReducedMotion()
    this.fx = new Effects(this, this.reducedMotion)

    // Area construction from WorldData (a new area kind is data + a small
    // builder — see the registry in src/game/worlds.ts).
    buildGround(this, this.world)
    this.solidGroup = buildSolids(this, this.world)
    this.lightProps = buildProps(this, this.world, this.solidGroup)

    // Entities
    const papers = new PaperPickups(this, { world: this.world, session: this.session, fx: this.fx, reducedMotion: this.reducedMotion })
    this.interactables = new Interactables(this, { world: this.world, session: this.session, reducedMotion: this.reducedMotion, papers })
    // Read-only: found-text pickups still lying in this area (playtests).
    ;(window as unknown as { __fsPapers?: () => string[] }).__fsPapers = () => papers.lying()
    this.hero = new Hero(
      this,
      {
        world: this.world,
        session: this.session,
        fx: this.fx,
        reducedMotion: this.reducedMotion,
        enemies: () => this.enemies,
        projectiles: () => this.projectiles,
        avatar: () => this.avatar,
        restRate: () => this.lanternRestRate(),
        transitioning: () => this.transitioning,
        cinematic: () => this.cinematic,
        onDefeat: () => this.defeatRecovery()
      },
      wildsEntry ? wildsEntry.tile : this.pendingEntry
    )
    this.avatar = new AvatarVisual(this, { session: this.session, world: this.world, hero: () => this.hero })
    this.npcs = new Npcs(this, this.world)
    this.projectiles = new Projectiles(this, this.fx, () => this.enemies)
    this.enemies = new EnemySystem(
      this,
      {
        world: this.world,
        session: this.session,
        fx: this.fx,
        reducedMotion: this.reducedMotion,
        solidGroup: this.solidGroup,
        hero: () => this.hero
      },
      state
    )
    // Village life (calendar, festivals, notice boards, project changes) everywhere.
    this.interactables.setExtra(new VillageLayer(this, { world: this.world, session: this.session, reducedMotion: this.reducedMotion, interactables: this.interactables }))
    this.homesteads = null
    if (this.world.areaId === 'commons' || this.room) {
      this.homesteads = new HomesteadLayer(this, {
        world: this.world,
        session: this.session,
        fx: this.fx,
        reducedMotion: this.reducedMotion,
        solidGroup: this.solidGroup,
        interactables: this.interactables,
        hero: () => this.hero.sprite,
        room: this.room ? { owner: this.room.owner } : null,
        enterRoom: (owner, doorstep) => this.enterRoom(owner, doorstep),
        rebuild: () => this.rebuildArea()
      })
      this.interactables.setExtra(this.homesteads)
    }
    this.occluders = buildForeground(this, this.world)
    buildExitSigns(this, this.world, this.reducedMotion)
    this.physics.add.collider(this.hero.sprite, this.solidGroup)

    // The Wilds layer: camps, nodes, chests, POIs and lanterns (null in the
    // curated areas). The region read refreshes in the background; entities
    // render from the store and follow its changes.
    if (wildsEntry) {
      this.wilds = new WildsEntities(this, {
        world: this.world,
        session: this.session,
        fx: this.fx,
        enemies: this.enemies,
        reducedMotion: this.reducedMotion
      })
      void prepareWilds(this.session, 60_000)
    }

    // Arcade's world bounds default to the canvas size, which is larger than
    // small maps — without this the hero can walk off the map edge.
    this.physics.world.setBounds(0, 0, this.world.widthPx, this.world.heightPx)
    this.cameras.main.startFollow(this.hero.sprite, true, 0.12, 0.12)
    this.applyZoom(this.scale.width, this.scale.height)
    const onResize = (size: Phaser.Structs.Size) => this.applyZoom(size.width, size.height)
    this.scale.on('resize', onResize)
    this.events.once('shutdown', () => this.scale.off('resize', onResize))
    this.cameras.main.fadeIn(280, 12, 12, 20)

    // Input
    const kb = this.input.keyboard!
    kb.addCapture('SPACE,UP,DOWN,LEFT,RIGHT,W,A,S,D,E,F,M,SHIFT')
    this.cursors = kb.createCursorKeys()
    this.wasd = kb.addKeys('W,A,S,D') as Record<string, Phaser.Input.Keyboard.Key>
    this.actionKeys = kb.addKeys('E,SPACE,F,M,SHIFT') as Record<string, Phaser.Input.Keyboard.Key>
    // Event-driven, not polled: Key.onUp clears _justDown, so polling
    // JustDown once per frame silently drops taps shorter than a frame
    // (common on slower devices). DOWN fires once per press, never on repeat.
    this.actionKeys.E.on('down', this.onActionKey, this)
    this.actionKeys.SPACE.on('down', this.onActionKey, this)
    this.actionKeys.F.on('down', this.onCastKey, this)
    this.actionKeys.M.on('down', this.onRideKey, this)
    this.actionKeys.SHIFT.on('down', this.onDodgeKey, this)
    bus.on(EV.action, this.handleAction, this)
    bus.on(EV.cast, this.onCastKey, this)
    bus.on(EV.dodge, this.onDodgeKey, this)
    bus.on(EV.dialogueClosed, this.onDialogueClosed, this)
    this.events.once('shutdown', () => {
      for (const key of Object.values(this.actionKeys)) key.removeAllListeners('down')
      bus.off(EV.action, this.handleAction, this)
      bus.off(EV.cast, this.onCastKey, this)
      bus.off(EV.dodge, this.onDodgeKey, this)
      bus.off(EV.dialogueClosed, this.onDialogueClosed, this)
      // A restart mid-beat must never leave the HUD hidden and input blocked.
      if (this.cinematic) {
        this.cinematic = false
        bus.emit(EV.cinematic, { active: false })
      }
      this.input.keyboard?.enableGlobalCapture()
    })

    this.session.emitArea()
    this.session.emitStats()
    this.session.emitQuest()
    this.session.startAutosave()
    refreshLanternVisuals(this, this.lightProps, this.session.questStage, this.session.state)
    this.interactables.buildMarkers()
    this.emitPortraits()
    bus.on(EV.quest, this.refreshMarkers, this)
    this.events.once('shutdown', () => bus.off(EV.quest, this.refreshMarkers, this))
    bus.on(EV.profileChanged, this.onProfileChanged, this)
    bus.on(EV.worldRefresh, this.onWorldRefresh, this)
    bus.on(EV.relocate, this.onRelocate, this)
    this.events.once('shutdown', () => {
      bus.off(EV.profileChanged, this.onProfileChanged, this)
      bus.off(EV.worldRefresh, this.onWorldRefresh, this)
      bus.off(EV.relocate, this.onRelocate, this)
      // Epoch bump: in-flight avatar/companion loads must not add objects to a
      // dead scene or fight a rebuilt scene's own composition. Hero combat
      // timing and the avatar's carried state ride out the restart.
      this.hero.carry()
      this.avatar.invalidate()
    })
    // Remote players (phase 6 presence): join this area's room and draw the
    // others in it. A cottage is part of the Commons room, but its map is not:
    // inside, nobody is drawn and we stand at our door for the others.
    const feed = presence()
    this.presenceArea = presenceAreaFor(this.room ? 'commons' : this.world.areaId)
    feed?.setArea(this.presenceArea)
    this.remotePlayers = createRemotePlayers(this, feed, this.presenceArea, !!this.room)
    bus.on(EV.emote, this.onOwnEmote, this)
    this.events.once('shutdown', () => {
      this.remotePlayers.clear()
      bus.off(EV.emote, this.onOwnEmote, this)
    })
    void this.avatar.build() // imported layered avatar (if any)

    // Read-only handle for automated playtesting (docs/playtest.md).
    ;(window as unknown as { __fsPlayer?: () => { x: number; y: number; body: { x: number; y: number; w: number; h: number }; blocked: Record<string, boolean> } }).__fsPlayer = () => {
      const b = this.hero.sprite.body as Phaser.Physics.Arcade.Body
      return {
        x: this.hero.sprite.x,
        y: this.hero.sprite.y,
        body: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
        blocked: { up: b.blocked.up, down: b.blocked.down, left: b.blocked.left, right: b.blocked.right }
      }
    }
    ;(window as unknown as { __fsEnemies?: () => Array<{ x: number; y: number; state: string; hp: number; texture: string; body: { x: number; y: number; w: number; h: number }; flipX: boolean; type: string; locked: boolean }> }).__fsEnemies =
      () => this.enemies.enemies.map((e) => {
        const b = e.sprite.body as Phaser.Physics.Arcade.Body
        return {
          x: e.sprite.x,
          y: e.sprite.y,
          state: e.state,
          hp: e.hp,
          texture: e.sprite.texture.key,
          body: { x: b.x, y: b.y, w: Math.round(b.width), h: Math.round(b.height) },
          flipX: e.sprite.flipX,
          type: e.type,
          locked: e.state === 'telegraph' && (e.lungeX !== 0 || e.lungeY !== 0),
          tint: '0x' + e.sprite.tintTopLeft.toString(16).padStart(6, '0')
        }
      })
    // Read-only warden snapshot: dormant, active (and whether it stands open), or settled.
    ;(window as unknown as { __fsWarden?: () => ReturnType<EnemySystem['wardenView']> }).__fsWarden = () => this.enemies.wardenView()
    // Read-only map geometry, so playtests can check the hero is confined to it.
    ;(window as unknown as { __fsWorld?: () => { areaId: AreaId; widthPx: number; heightPx: number; bounds: { x: number; y: number; w: number; h: number }; solid: boolean[][] } }).__fsWorld = () => {
      const b = this.physics.world.bounds
      return { areaId: this.world.areaId, widthPx: this.world.widthPx, heightPx: this.world.heightPx, bounds: { x: b.x, y: b.y, w: b.width, h: b.height }, solid: this.world.solid }
    }
    // Dev-only playtest lever: deal damage through the normal hurt path so
    // low-health and defeat beats can be checked without a long fight.
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>
      w.__fsDevHurt = (n: number) => {
        this.hero.iframes = 0
        this.hero.damagePlayer(n, this.hero.sprite.x - 1)
      }
      w.__fsDevWarp = (area: AreaId, tx: number, ty: number) => this.transitionTo(area, { tx, ty })
      // Roll in a given direction from inside the frame loop, so playtests can
      // react to an aim lock without input latency.
      w.__fsDevDodge = (dx: number, dy: number) => this.hero.tryDodge(new Phaser.Math.Vector2(dx, dy))
      w.__fsDevStrike = (n: number, type?: EnemyType) => {
        for (const e of [...this.enemies.enemies]) if (!e.dead && (!type || e.type === type)) this.enemies.damageEnemy(e, n, this.hero.sprite.x)
      }
      // Hold up the rubbing to the warden. `force` skips the opening/reach
      // rules (skipping the encounter); without it, the real rules apply.
      w.__fsDevShowRubbing = (force = false) => this.enemies.showRubbing(force)
      // Set the hero down at a spot in this area (no scene restart), so a
      // playtest can step up to the warden inside its opening.
      w.__fsDevPlace = (x: number, y: number) => {
        this.hero.sprite.setPosition(x, y)
        this.hero.sprite.setVelocity(0, 0)
      }
      // Add an exit to this area until the scene restarts, so a playtest can
      // walk into a destination no area kind is registered for (the guard).
      w.__fsDevAddExit = (exit: { tx: number; ty: number; tw: number; th: number; to: string }) => {
        this.world.exits.push({ ...exit, entry: { tx: 1, ty: 1 } })
      }
      // Read-only: where the save says the hero is (area and position).
      w.__fsDevSaved = () => ({ area: this.session.state.area, position: { ...this.session.state.position } })
    }
    // Connected-play status for playtests (read-only; null for guests).
    ;(window as unknown as { __fsLink?: () => string | null }).__fsLink = () => this.session.link?.status ?? null
    // Read-only Wilds snapshot for playtests (null outside the Wilds).
    ;(window as unknown as { __fsWilds?: () => ReturnType<WildsEntities['debug']> }).__fsWilds = () => this.wilds?.debug() ?? null
    // Sync-safety snapshot for the UI gate (read-only).
    ;(window as unknown as { __fsSafety?: () => { areaId: AreaId; transitioning: boolean; dialogueOpen: boolean; enemiesNear: boolean } }).__fsSafety = () => {
      const px = this.hero.sprite.x
      const py = this.hero.sprite.y
      return {
        areaId: this.world.areaId,
        transitioning: this.transitioning,
        dialogueOpen: uiState.dialogueOpen,
        enemiesNear: this.enemies.enemies.some((e) => Math.hypot(e.sprite.x - px, e.sprite.y - py) < 200)
      }
    }
    // Read-only avatar/combat diagnostics for verification (no mutation).
    ;(window as unknown as { __fsDebug?: () => Record<string, unknown> }).__fsDebug = () => ({
      avatar: !!this.avatar.container,
      pet: !!this.avatar.pet,
      riding: this.avatar.riding,
      playerAlpha: this.hero.sprite.alpha,
      playerVisible: this.hero.sprite.visible,
      bolts: this.projectiles ? this.projectiles.length : -1,
      attackCooldown: this.hero.attackCooldown,
      castCooldown: this.hero.castCooldown,
      facing: { x: this.hero.facing.x, y: this.hero.facing.y },
      heroTex: this.hero.sprite.texture.key,
      npcs: this.npcs.npcs.map((n) => ({
        id: n.id,
        texture: n.sprite.texture.key,
        anim: n.sprite instanceof Phaser.GameObjects.Sprite ? n.sprite.anims.currentAnim?.key ?? null : null
      })),
      keys: {
        left: this.cursors.left.isDown,
        right: this.cursors.right.isDown,
        up: this.cursors.up.isDown,
        down: this.cursors.down.isDown,
        E: this.actionKeys.E.isDown,
        F: this.actionKeys.F.isDown
      },
      keyboardEnabled: this.input.keyboard?.enabled ?? null,
      keyboardActive: (this.input.keyboard as unknown as { isActive?: () => boolean }).isActive?.() ?? null,
      body: (() => {
        const b = this.hero.sprite.body as Phaser.Physics.Arcade.Body
        return { vx: b.velocity.x, vy: b.velocity.y, moves: b.moves, enable: b.enable, physicsPaused: this.physics.world.isPaused }
      })()
    })

    if (this.pendingDefeatToast) {
      this.pendingDefeatToast = false
      bus.emit(EV.defeat, { phase: 'woke' })
    }
  }

  // ------------------------------------------------------------- update loop

  update(time: number, delta: number): void {
    const dt = Math.min(delta / 1000, 0.05)
    // While a panel/dialogue owns the screen, stop preventDefault-ing Space
    // etc. so focused buttons (replies, confirms) activate natively.
    // A focused placement-tray control gets its keys natively (Space presses it).
    const uiOwns = uiBlocked() || trayFocused()
    if (uiOwns !== this.captureReleased) {
      this.captureReleased = uiOwns
      if (uiOwns) this.input.keyboard?.disableGlobalCapture()
      else this.input.keyboard?.enableGlobalCapture()
    }
    this.hero.tick(dt)
    this.session.tickPlaySeconds(dt)

    // While a sync persistence owns the save file the world freezes its
    // resource/combat mutations: the committed snapshot must never revert a
    // mid-flight enemy hit, regen tick, or position write. The panel closes
    // normally; this gate only covers the brief disk write.
    this.homesteads?.update(dt)
    // Others keep walking while a panel or dialogue holds the screen.
    this.remotePlayers.update(dt)
    this.samplePresence()
    if (uiBlocked() || this.transitioning || this.cinematic || this.session.persistenceInFlight || this.homesteads?.placing) {
      this.hero.halt()
      this.interactables.hideKeyHint()
      this.enemies.updateEnemyBars()
      this.updateOccluders(dt)
      return
    }

    this.hero.move(dt, this.inputVector())
    this.enemies.update(dt)
    this.projectiles.update(dt)
    this.wilds?.update()
    this.updateDiscoveries()
    this.checkExits()
    maybeNudgePip(this.session, this.world, this.hero.sprite) // P1 onboarding: Pip's one-off gate line
    const show = this.enemies.showTarget()
    const wildsAction: WildsAction | null = this.wilds?.promptAction(this.hero.sprite) ?? null
    const action = wildsAction ?? (show ? { label: 'Hold up the rubbing', verb: 'Show', ...show } : null)
    this.interactables.updatePrompt(this.hero.sprite, this.time.now, action)
    this.enemies.updateEnemyBars()
    this.updateOccluders(dt)
    this.updateDepth()
    this.avatar.update(time)

    this.positionTimer += dt
    // In a cottage the save keeps the doorstep (set on the way in).
    if (this.positionTimer > 1 && !this.room) {
      this.positionTimer = 0
      // Wilds: saved progress is region-wide pixels (one convention for
      // saves, reloads, claims and defeat reports).
      this.session.state.position = this.wildsEntryNow()
        ? this.wildsPosition(Math.round(this.hero.sprite.x), Math.round(this.hero.sprite.y))
        : { x: Math.round(this.hero.sprite.x), y: Math.round(this.hero.sprite.y) }
    }
  }

  /** Tell the presence feed where the hero is (it paces the wire itself). */
  private samplePresence(): void {
    const feed = presence()
    if (!feed || !this.presenceArea) return
    if (this.room) {
      // Indoors: the others see us at our door.
      const door = this.session.state.position
      feed.position({ x: door.x, y: door.y, facing: { x: 0, y: 1 }, moving: false })
      return
    }
    const body = this.hero.sprite.body as Phaser.Physics.Arcade.Body
    const moving = !this.transitioning && Math.hypot(body.velocity.x, body.velocity.y) > 5
    feed.position({ x: this.hero.sprite.x, y: this.hero.sprite.y, facing: this.hero.facing, moving })
  }

  /** Our own emote: a bubble over the hero (the server doesn't echo it back). */
  private onOwnEmote(p: EmotePayload): void {
    if (p.habiticaId !== null) return
    this.ownBubble?.destroy()
    this.ownBubble = showEmoteBubble(this, this.hero.sprite, p.id, -32)
  }

  private ownBubble: Phaser.GameObjects.Container | null = null

  /** Is the scene playing a Wilds chunk right now (also true mid-transition). */
  private wildsEntryNow(): boolean {
    return isWildsArea(this.session.state.area) || parseChunkArea(this.world.areaId) !== null
  }

  /** Chunk-local scene pixels → the region-wide progress position. */
  private wildsPosition(x: number, y: number): { x: number; y: number } {
    const chunk = parseChunkArea(this.world.areaId) ?? { cx: 0, cy: 0 }
    return toRegionPosition(chunk.cx, chunk.cy, x, y)
  }

  /** World input is live only while the hero actually has control. */
  private worldLive(): boolean {
    return !uiBlocked() && !this.transitioning && !this.cinematic && !this.session.persistenceInFlight &&
      !this.homesteads?.placing && performance.now() >= uiState.blockedUntil
  }

  private onActionKey(): void {
    if (this.worldLive()) this.handleAction()
  }

  private onCastKey(): void {
    if (this.worldLive()) this.hero.handleCast()
  }

  private onRideKey(): void {
    if (this.worldLive()) void this.avatar.toggleRide()
  }

  private onDodgeKey(): void {
    if (this.worldLive()) this.hero.tryDodge(this.inputVector())
  }

  /** Current movement input (keys + joystick), not normalized. */
  private inputVector(): Phaser.Math.Vector2 {
    let dx = touchVec.x
    let dy = touchVec.y
    if (this.cursors.left.isDown || this.wasd.A.isDown) dx -= 1
    if (this.cursors.right.isDown || this.wasd.D.isDown) dx += 1
    if (this.cursors.up.isDown || this.wasd.W.isDown) dy -= 1
    if (this.cursors.down.isDown || this.wasd.S.isDown) dy += 1
    return new Phaser.Math.Vector2(dx, dy)
  }

  private handleAction(): void {
    if (uiBlocked() || this.cinematic || this.transitioning || this.homesteads?.placing || performance.now() < uiState.blockedUntil) return
    // The warden standing open after a lunge, within reach: show it the mark.
    if (this.enemies.showRubbing()) return
    // Wilds claims (harvest, camp, chest, POI, lantern) outrank talking.
    if (this.wilds?.handleAction()) return
    if (this.interactables.currentTarget) {
      // Free village activities stay available at zero HP: talking is fine.
      this.interactables.open(this.interactables.currentTarget)
      return
    }
    if (this.session.zeroHpLocked) return // too injured to fight; no auto revival
    this.hero.tryAttack()
  }

  /** Quest progress (or a spend) changes what the markers say; owned by Interactables. */
  private refreshMarkers(): void {
    this.interactables.refreshMarkers()
  }

  private onProfileChanged(): void {
    // A sync may have brought embers: ember-spot markers can change.
    this.refreshMarkers()
    this.avatar.onProfileChanged()
  }

  /** Connected play: balances or paid outcomes changed on the server. */
  private onWorldRefresh(): void {
    refreshLanternVisuals(this, this.lightProps, this.session.questStage, this.session.state)
    this.refreshMarkers()
    this.interactables.invalidatePrompt()
  }

  /**
   * Connected play: the server's area/position won (a stale merge after
   * another device played). Same area: step there. Another area: rebuild the
   * scene, which places the hero from the session state. Wilds positions are
   * region-wide pixels: the chunk they fall in decides.
   */
  private onRelocate(p: RelocatePayload): void {
    if (this.transitioning) return
    if (isWildsArea(p.area)) {
      const here = parseChunkArea(this.world.areaId)
      const r = inRegion(p.x, p.y) ? fromRegionPosition(p.x, p.y) : null
      if (here && r && r.cx === here.cx && r.cy === here.cy) {
        this.hero.sprite.setPosition(r.x, r.y)
        this.hero.sprite.setVelocity(0, 0)
        return
      }
      // A different chunk (or a position outside the region): rebuild, and
      // the wilds entry resolver places the hero (spawn as a fallback).
      if (!r) {
        this.session.state.position = wildsArrivalPosition(wildsEpoch())
      }
      this.transitioning = true
      this.cameras.main.fade(240, 12, 12, 20, true)
      this.cameras.main.once('camerafadeoutcomplete', () => {
        void prepareWilds(this.session, 60_000).finally(() => this.scene.restart({}))
      })
      return
    }
    if (p.area === this.world.areaId) {
      this.hero.sprite.setPosition(p.x, p.y)
      this.hero.sprite.setVelocity(0, 0)
      return
    }
    this.transitioning = true
    this.cameras.main.fade(240, 12, 12, 20, true)
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.scene.restart({})
    })
  }

  /** Canopies and arches fade so nothing (hero or enemy) hides beneath them. */
  private updateOccluders(dt: number): void {
    if (this.occluders.length === 0) return
    const things: { x: number; y: number }[] = [{ x: this.hero.sprite.x, y: this.hero.sprite.y }]
    for (const e of this.enemies.enemies) things.push({ x: e.sprite.x, y: e.sprite.y })
    updateAreaOccluders(this.occluders, dt, things)
  }

  private updateDepth(): void {
    this.hero.updateDepth()
    this.npcs.updateDepth()
  }

  /**
   * Small native portraits for the dialogue box and character sheet. Each is
   * trimmed to its visible pixels (textures carry transparent padding) and,
   * for people, cropped to head and shoulders, then centered on a square.
   */
  private emitPortraits(): void {
    const out: Record<string, string> = {}
    const add = (name: string, key: string, frame: string | undefined, bust: boolean) => {
      try {
        if (!this.textures.exists(key)) return
        const tex = this.textures.get(key)
        if (frame && !tex.has(frame)) return
        const f = frame ? tex.get(frame) : tex.get()
        const src = f.source.image as CanvasImageSource
        const w = f.cutWidth
        const h = f.cutHeight
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(src, f.cutX, f.cutY, w, h, 0, 0, w, h)
        const data = ctx.getImageData(0, 0, w, h).data
        let minX = w, minY = h, maxX = -1, maxY = -1
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > 16) {
              if (x < minX) minX = x
              if (x > maxX) maxX = x
              if (y < minY) minY = y
              if (y > maxY) maxY = y
            }
          }
        }
        if (maxX < 0) return
        const bw = maxX - minX + 1
        const bh = maxY - minY + 1
        const cropH = bust ? Math.max(1, Math.ceil(bh * 0.58)) : bh
        const size = Math.max(bw, cropH) + 2
        const o = document.createElement('canvas')
        o.width = size
        o.height = size
        const octx = o.getContext('2d')!
        octx.imageSmoothingEnabled = false
        const dx = Math.floor((size - bw) / 2)
        const dy = bust ? size - cropH : Math.floor((size - bh) / 2)
        octx.drawImage(c, minX, minY, bw, cropH, dx, dy, bw, cropH)
        out[name] = o.toDataURL()
      } catch {
        /* portrait is optional decoration */
      }
    }
    for (const id of ['mara', 'pip', 'orrin']) {
      add(NPC_NAMES[id], this.textures.exists(`${id}-idle-0`) ? `${id}-idle-0` : id, undefined, true)
    }
    if (this.textures.get('fingersnap-props').has('stone-milestone')) add('Route Marker', 'fingersnap-props', 'stone-milestone', false)
    else add('Route Marker', 'mural', undefined, false)
    add('Hilltop Lantern', 'fingersnap-props', 'lantern-shrine', false)
    add('Hearth Lantern', 'fingersnap-props', 'lantern-post', false)
    add('Road Lantern', 'fingersnap-props', 'lantern-post', false)
    add('Ashwatch Chest', 'fingersnap-props', 'treasure-chest', false)
    add('You', 'fingersnap-demo-walk', 'walk-down-0', true)
    bus.emit(EV.portraits, out)
  }

  // ------------------------------------------------------------- interaction

  private onDialogueClosed = (payload: DialogueClosedPayload): void => {
    uiState.dialogueOpen = false
    uiState.blockedUntil = performance.now() + 220
    if (payload?.action) this.applyEmberAction(payload.action)
    const event = payload?.event as QuestEvent | undefined
    if (!event) return
    // The clue is journaled under the shared content id (advanceQuest also
    // carries it; addUnique keeps it single-entry).
    if (event === 'find-clue') this.session.recordDiscovery('old-route-marker', 'The Closure Mark')
    if (event === 'light-lantern' || event === 'return-village') {
      this.playLanternBeat(event)
      return
    }
    this.session.applyQuestEvent(event)
    refreshLanternVisuals(this, this.lightProps, this.session.questStage, this.session.state)
    if (event === 'find-clue' && this.world.areaId === 'ruin') this.enemies.spawnGuardian(true)
  }

  /** A spend picked in an ember-spot conversation; the payoff is visible. */
  private applyEmberAction(action: string): void {
    if (action.startsWith('home:')) {
      void this.homesteads?.onAction(action)
      return
    }
    const spend: EmberSpend | null =
      action === 'rest' ? { kind: 'rest' }
        : action === 'home-rest' ? { kind: 'home-rest' }
        : action === 'chest' ? { kind: 'chest' }
          : action.startsWith('light:') && (ROAD_LANTERNS as readonly string[]).includes(action.slice(6))
            ? { kind: 'road-lantern', id: action.slice(6) as RoadLanternId }
            : null
    if (!spend) return
    if (this.session.link) {
      void this.applyRemoteSpend(spend)
      return
    }
    const refused = this.session.spend(spend)
    if (refused) {
      const text =
        refused === 'short' ? 'The flame gutters — not enough embers after all.'
          : refused === 'full' ? 'You’re already rested. Keep your embers.'
            : refused === 'done' ? 'That’s already done.'
                : refused === 'needs-earned' ? 'Only embers earned on Habitica can get you back on your feet.'
              : 'Hold on — your hero is still syncing. Try again in a moment.'
      bus.emit(EV.toast, { text, kind: 'error' })
      return
    }
    this.spendPayoff(spend)
  }

  /**
   * Connected play: the server decides. The world waits (persistenceInFlight)
   * and the HUD shows a short pending state; the payoff plays only after a
   * yes, and nothing changes on a no.
   */
  private async applyRemoteSpend(spend: EmberSpend): Promise<void> {
    const link = this.session.link!
    const result = await link.spend(spend)
    if (!this.sys.isActive()) return
    if (result === null) {
      this.spendPayoff(spend)
      return
    }
    const text =
      result === 'offline' ? 'Needs a connection. Your embers are safe — try again when you’re back online.'
        : result === 'superseded' ? 'Another device took over this journey.'
          : result === 'short' ? 'The flame gutters — not enough embers after all.'
            : result === 'full' ? 'You’re already rested. Keep your embers.'
              : result === 'done' ? 'That’s already done.'
                : result === 'needs-earned' ? 'Only embers earned on Habitica can get you back on your feet.'
                  : result === 'unsafe' ? 'Resting only works in Hearthwick.'
                    : result === 'not-home' ? 'You can only rest at your own place.'
                    : result === 'busy' ? 'Hold on — the last one is still on its way.'
                      : 'The lantern didn’t answer. Nothing was spent — try again in a moment.'
    bus.emit(EV.toast, { text, kind: 'error' })
  }

  /** The visible reward for a spend that went through. */
  private spendPayoff(spend: EmberSpend): void {
    sfx('lantern')
    if (spend.kind === 'rest' || spend.kind === 'home-rest') {
      this.hero.sprite.setTint(0xffe2a8)
      this.time.delayedCall(260, () => this.hero.sprite.clearTint())
      this.fx.sparkBurst(this.hero.sprite.x, this.hero.sprite.y - 10, 10)
      this.fx.floatText(this.hero.sprite.x, this.hero.sprite.y - 24, 'Rested', '#ffd27a', false)
      bus.emit(EV.toast, {
        text: spend.kind === 'home-rest' ? 'Home, and rested. Health and mana restored.' : 'Warm and rested. Health and mana restored.',
        icon: 'ember'
      })
    } else if (spend.kind === 'road-lantern') {
      const lp = this.lightProps.find((l) => l.id === spend.id)
      refreshLanternVisuals(this, this.lightProps, this.session.questStage, this.session.state)
      if (lp) {
        const bloom = this.add.image(lp.gx, lp.gy, 'glow').setBlendMode(Phaser.BlendModes.ADD).setDepth(4002).setScale(0.2)
        this.tweens.add({ targets: bloom, scale: 2.4, alpha: 0, duration: 900, ease: 'Quad.easeOut', onComplete: () => bloom.destroy() })
        this.fx.sparkBurst(lp.gx, lp.gy, 10)
      }
      bus.emit(EV.toast, { text: 'The road lantern is lit. Rest in its light to recover.', icon: 'lantern' })
    } else {
      const spot = this.world.emberSpots.find((e) => e.id === 'chest')
      if (spot) this.fx.sparkBurst(spot.tx * TILE + 8, spot.ty * TILE + 6, 14)
      bus.emit(EV.toast, { text: `Found: ${itemInfo(CHARM_ITEM).name}. Your strikes find the gaps more often.`, icon: 'ember' })
    }
    this.refreshMarkers()
    this.interactables.invalidatePrompt()
  }

  /** Standing in a lit road lantern's light (and out of a fight) mends you. */
  private lanternRestRate(): number {
    for (const lp of this.lightProps) {
      if (!(ROAD_LANTERNS as readonly string[]).includes(lp.id) || !isLit(this.session.state, lp.id as RoadLanternId)) continue
      if (Math.hypot(this.hero.sprite.x - lp.gx, this.hero.sprite.y - (lp.gy + 18)) > 44) continue
      const threatened = this.enemies.enemies.some((e) => !e.dead && Math.hypot(e.sprite.x - this.hero.sprite.x, e.sprite.y - this.hero.sprite.y) < 90)
      return threatened ? 0 : 1
    }
    return 0
  }

  /**
   * The big moment: the HUD steps aside, the camera eases to the lantern,
   * and the flame catches with a bloom of light and a chime. The quest event
   * is applied at the peak so the UI's quest banner lands right after.
   */
  private playLanternBeat(event: QuestEvent): void {
    const target = this.lightProps.find((lp) => lp.id === (event === 'light-lantern' ? 'shrine' : 'village'))
    const finish = () => {
      this.session.applyQuestEvent(event)
      refreshLanternVisuals(this, this.lightProps, this.session.questStage, this.session.state)
    }
    if (!target) {
      finish()
      return
    }
    this.cinematic = true
    bus.emit(EV.cinematic, { active: true })
    const cam = this.cameras.main
    const baseZoom = cam.zoom
    cam.stopFollow()
    const panMs = this.reducedMotion ? 0 : 900
    cam.pan(target.gx, target.gy + 10, panMs, 'Sine.easeInOut')
    if (!this.reducedMotion) cam.zoomTo(baseZoom * 1.3, panMs, 'Sine.easeInOut')
    this.time.delayedCall(panMs + 150, () => {
      sfx('lantern')
      if (!this.reducedMotion) cam.flash(500, 255, 220, 150)
      const bloom = this.add.image(target.gx, target.gy, 'glow')
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(4002)
        .setScale(0.2)
      this.tweens.add({ targets: bloom, scale: 4, alpha: 0, duration: 1400, ease: 'Quad.easeOut', onComplete: () => bloom.destroy() })
      this.fx.sparkBurst(target.gx, target.gy, 16)
      finish()
    })
    this.time.delayedCall(panMs + 2300, () => {
      cam.pan(this.hero.sprite.x, this.hero.sprite.y, panMs, 'Sine.easeInOut')
      // Return to the zoom for the CURRENT viewport (it may have resized).
      if (!this.reducedMotion) cam.zoomTo(this.zoomFor(this.scale.height), panMs, 'Sine.easeInOut')
      this.time.delayedCall(panMs + 50, () => {
        cam.startFollow(this.hero.sprite, true, 0.12, 0.12)
        this.cinematic = false
        bus.emit(EV.cinematic, { active: false })
      })
    })
  }

  // ------------------------------------------------------------- transitions

  private checkExits(): void {
    if (this.transitioning) return
    // Zero-HP gates expeditions only from the village; a legacy zero-HP save
    // found outside may travel home freely (nothing heals en route).
    // The Commons counts as home: a hurt hero may walk there to rest.
    const locked = this.session.zeroHpLocked && (SAFE_AREAS.includes(this.world.areaId) || !!this.room)
    const tx = Math.floor(this.hero.sprite.x / TILE)
    const ty = Math.floor(this.hero.sprite.y / TILE)
    for (const exit of this.world.exits) {
      if (locked && !SAFE_AREAS.includes(exit.to)) continue
      if (tx >= exit.tx && tx < exit.tx + exit.tw && ty >= exit.ty && ty < exit.ty + exit.th) {
        if (!canEnter(exit.to)) {
          this.overgrown(exit)
          return
        }
        this.transitionTo(exit.to, exit.entry)
        return
      }
    }
  }

  private overgrownAt = 0

  /**
   * An exit to an area this build can't draw (the Wilds before its client
   * is here): the save is never touched; the hero steps back and is told.
   */
  private overgrown(exit: { tx: number; ty: number; tw: number; th: number }): void {
    const h = this.hero.sprite
    const cx = (exit.tx + exit.tw / 2) * TILE
    const cy = (exit.ty + exit.th / 2) * TILE
    const horizontal = exit.tw > exit.th
    h.setVelocity(0, 0)
    if (horizontal) h.setY(cy + (h.y >= cy ? 1 : -1) * (exit.th / 2 + 1) * TILE)
    else h.setX(cx + (h.x >= cx ? 1 : -1) * (exit.tw / 2 + 1) * TILE)
    if (performance.now() - this.overgrownAt < 2500) return
    this.overgrownAt = performance.now()
    this.fx.floatText(h.x, h.y - 24, 'Overgrown', '#fff3c4', false)
    bus.emit(EV.toast, { text: 'The way is overgrown. Brambles and fallen iron-oak — nobody has cleared it yet.', icon: 'map' })
  }

  private transitionTo(area: AreaId, entry: { tx: number; ty: number }): void {
    if (!canEnter(area)) return
    this.transitioning = true
    const state = this.session.state
    const leavingWilds = isWildsArea(state.area)
    const targetChunk = area === WILDS_AREA ? null : parseChunkArea(String(area))
    if (area === WILDS_AREA || targetChunk) {
      // Into the Wilds: the saved area stays `wilds` and the position is
      // region-wide pixels. `wilds` (the Commons' exit, the dev warp)
      // arrives at the region's entry point; chunk targets use their own
      // exit's entry tile.
      const epoch = wildsEpoch()
      const dest = targetChunk ?? parseChunkArea(WILDS_AREA)!
      // `wilds` (the Commons' exit, the dev warp) arrives at the region's
      // entry point, and the scene restarts there.
      const arrivalTile = targetChunk
        ? entry
        : (() => {
            const r = fromRegionPosition(wildsArrivalPosition(epoch).x, wildsArrivalPosition(epoch).y)
            return { tx: Math.floor(r.x / TILE), ty: Math.floor(r.y / TILE) }
          })()
      state.area = WILDS_AREA
      state.position = targetChunk
        ? toRegionPosition(dest.cx, dest.cy, (entry.tx + 0.5) * TILE, (entry.ty + 0.5) * TILE)
        : wildsArrivalPosition(epoch)
      this.session.saveSoon()
      this.cameras.main.fade(240, 12, 12, 20, true)
      this.cameras.main.once('camerafadeoutcomplete', () => {
        // The region must be loaded before the chunk builds (shared epoch).
        void prepareWilds(this.session, 60_000).finally(() => this.scene.restart({ entry: arrivalTile }))
      })
      return
    }
    if (leavingWilds && area === 'commons') {
      // The agreed handoff: back through the north arch.
      const tile = wildsReturnTile()
      entry = { tx: tile.tx, ty: tile.ty }
    }
    state.area = area
    state.position = { x: (entry.tx + 0.5) * TILE, y: (entry.ty + 0.5) * TILE }
    this.session.saveSoon()
    this.cameras.main.fade(240, 12, 12, 20, true)
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.scene.restart({ entry })
    })
  }

  /**
   * Walk into a cottage. The save stays in the Commons, on the doorstep
   * (inside the plot), and the scene rebuilds as the room.
   */
  private enterRoom(owner: string, doorstep: { tx: number; ty: number }): void {
    if (this.transitioning) return
    this.transitioning = true
    const state = this.session.state
    state.area = 'commons'
    state.position = { x: (doorstep.tx + 0.5) * TILE, y: (doorstep.ty + 0.5) * TILE }
    this.session.saveSoon()
    this.cameras.main.fade(240, 12, 12, 20, true)
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.scene.restart({ entry: ROOM_ENTRY, room: { owner, doorstep } })
    })
  }

  /** The Commons grew a row (a new neighbour): rebuild it where we stand. */
  private rebuildArea(): void {
    if (this.transitioning || this.room) return
    this.transitioning = true
    this.session.state.position = { x: Math.round(this.hero.sprite.x), y: Math.round(this.hero.sprite.y) }
    const entry = { tx: Math.floor(this.hero.sprite.x / TILE), ty: Math.floor(this.hero.sprite.y / TILE) }
    this.time.delayedCall(0, () => this.scene.restart({ entry }))
  }

  /**
   * Defeat: a short collapse beat, then wake at the village well. In the
   * Wilds the defeat is reported first (a fallen-hero lantern), before
   * recovery touches vitals.
   */
  private defeatRecovery(): void {
    this.transitioning = true
    // Tell the UI first: it holds the bars while the hero collapses, then
    // shows the recovered vitals once the screen is dark.
    bus.emit(EV.defeat, { phase: 'falling' })
    const wildsReport = isWildsArea(this.session.state.area) ? this.wilds?.reportDefeat() ?? null : null
    this.session.defeat()
    sfx('defeat')
    this.hero.sprite.setVelocity(0, 0)
    this.tweens.add({ targets: this.avatar.container ?? this.hero.sprite, scaleY: (this.avatar.container ?? this.hero.sprite).scaleY * 0.6, duration: 380, ease: 'Quad.easeIn' })
    this.hero.sprite.setTint(0x8a7a9a)
    // force: a fade-in still running (scene just started) must not swallow
    // this fade, or 'camerafadeoutcomplete' never fires and we soft-lock.
    this.cameras.main.fade(1100, 12, 12, 20, true)
    this.cameras.main.once('camerafadeoutcomplete', () => {
      // The report is queued ahead of everything else this tab sends; the
      // recovery never waits on it, but it must not be dropped either.
      void wildsReport?.catch(() => undefined)
      this.scene.restart({ fromDefeat: true })
    })
  }

  // ------------------------------------------------------------- zoom

  private zoomFor(h: number): number {
    return Phaser.Math.Clamp(Math.round((h / 280) * 2) / 2, 1.5, 5)
  }

  private applyZoom(w: number, h: number): void {
    const zoom = this.zoomFor(h)
    this.cameras.main.setZoom(zoom)
    // A map smaller than the view (a cottage room) sits centred in it.
    const vw = w / zoom
    const vh = h / zoom
    const bx = Math.min(0, (this.world.widthPx - vw) / 2)
    const by = Math.min(0, (this.world.heightPx - vh) / 2)
    this.cameras.main.setBounds(bx, by, Math.max(this.world.widthPx, vw), Math.max(this.world.heightPx, vh))
  }

  // ------------------------------------------------------------- world upkeep

  private updateDiscoveries(): void {
    for (const spot of this.world.discoverySpots) {
      const d = Math.hypot(this.hero.sprite.x - (spot.tx * TILE + 8), this.hero.sprite.y - 8 - (spot.ty * TILE + 8))
      if (d < 24) this.session.recordDiscovery(spot.id, spot.label)
    }
  }
}
