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
import { bus, EV, type DialogueClosedPayload } from '../events'
import { prefersReducedMotion, sfx } from '../sfx'
import { touchVec, uiBlocked, uiState } from '../input'
import { TILE } from '../textures'
import type { Session } from '../session'
import { buildArea, type EnemyType, type WorldData } from '../worlds'
import { CHARM_ITEM, ROAD_LANTERNS, isLit, type EmberSpend, type RoadLanternId } from '../../lib/embers'
import { maybeNudgePip } from '../nudges' // P1 onboarding
import { AvatarVisual } from '../entities/avatar'
import { Hero } from '../entities/hero'
import { EnemySystem } from '../entities/enemies'
import { Projectiles } from '../entities/projectiles'
import { Interactables } from '../entities/interactables'
import { Effects } from '../entities/fx'
import { NPC_NAMES, Npcs } from '../entities/npcs'
import { createRemotePlayers, type RemotePlayers } from '../entities/remote-players'

interface SceneData {
  entry?: { tx: number; ty: number }
  fromDefeat?: boolean
}

export class WorldScene extends Phaser.Scene {
  private session!: Session
  private world!: WorldData
  private fx!: Effects
  private remotePlayers!: RemotePlayers
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

  constructor() {
    super('World')
  }

  init(data: SceneData): void {
    this.transitioning = false
    this.pendingEntry = data?.entry ?? null
    this.pendingDefeatToast = data?.fromDefeat === true
  }

  private pendingEntry: { tx: number; ty: number } | null = null
  private pendingDefeatToast = false

  create(): void {
    this.session = this.registry.get('session') as Session
    const state = this.session.state
    this.world = buildArea(state.area)
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
    this.interactables = new Interactables(this, { world: this.world, session: this.session, reducedMotion: this.reducedMotion })
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
      this.pendingEntry
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
    this.occluders = buildForeground(this, this.world)
    buildExitSigns(this, this.world, this.reducedMotion)
    this.physics.add.collider(this.hero.sprite, this.solidGroup)

    // Arcade's world bounds default to the canvas size, which is larger than
    // small maps — without this the hero can walk off the map edge.
    this.physics.world.setBounds(0, 0, this.world.widthPx, this.world.heightPx)
    this.cameras.main.setBounds(0, 0, this.world.widthPx, this.world.heightPx)
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
    this.events.once('shutdown', () => {
      bus.off(EV.profileChanged, this.onProfileChanged, this)
      // Epoch bump: in-flight avatar/companion loads must not add objects to a
      // dead scene or fight a rebuilt scene's own composition. Hero combat
      // timing and the avatar's carried state ride out the restart.
      this.hero.carry()
      this.avatar.invalidate()
    })
    // Remote players (presence seam): no-op layer, wired so phase 6 can
    // slot the real renderer in without touching the scene loop.
    this.remotePlayers = createRemotePlayers(this)
    this.events.once('shutdown', () => this.remotePlayers.clear())
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
    }
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
    const uiOwns = uiBlocked()
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
    if (uiBlocked() || this.transitioning || this.cinematic || this.session.persistenceInFlight) {
      this.hero.halt()
      this.interactables.hideKeyHint()
      this.enemies.updateEnemyBars()
      this.updateOccluders(dt)
      return
    }

    this.hero.move(dt, this.inputVector())
    this.enemies.update(dt)
    this.projectiles.update(dt)
    this.updateDiscoveries()
    this.checkExits()
    maybeNudgePip(this.session, this.world, this.hero.sprite) // P1 onboarding: Pip's one-off gate line
    this.interactables.updatePrompt(this.hero.sprite, this.time.now)
    this.enemies.updateEnemyBars()
    this.updateOccluders(dt)
    this.updateDepth()
    this.avatar.update(time)
    this.remotePlayers.update(dt)

    this.positionTimer += dt
    if (this.positionTimer > 1) {
      this.positionTimer = 0
      this.session.state.position = { x: Math.round(this.hero.sprite.x), y: Math.round(this.hero.sprite.y) }
    }
  }

  /** World input is live only while the hero actually has control. */
  private worldLive(): boolean {
    return !uiBlocked() && !this.transitioning && !this.cinematic && !this.session.persistenceInFlight &&
      performance.now() >= uiState.blockedUntil
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
    if (uiBlocked() || this.cinematic || this.transitioning || performance.now() < uiState.blockedUntil) return
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
    const spend: EmberSpend | null =
      action === 'rest' ? { kind: 'rest' }
        : action === 'chest' ? { kind: 'chest' }
          : action.startsWith('light:') && (ROAD_LANTERNS as readonly string[]).includes(action.slice(6))
            ? { kind: 'road-lantern', id: action.slice(6) as RoadLanternId }
            : null
    if (!spend) return
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
    sfx('lantern')
    if (spend.kind === 'rest') {
      this.hero.sprite.setTint(0xffe2a8)
      this.time.delayedCall(260, () => this.hero.sprite.clearTint())
      this.fx.sparkBurst(this.hero.sprite.x, this.hero.sprite.y - 10, 10)
      this.fx.floatText(this.hero.sprite.x, this.hero.sprite.y - 24, 'Rested', '#ffd27a', false)
      bus.emit(EV.toast, { text: 'Warm and rested. Health and mana restored.', icon: 'ember' })
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
    if (this.session.zeroHpLocked && this.world.areaId === 'village') return
    const tx = Math.floor(this.hero.sprite.x / TILE)
    const ty = Math.floor(this.hero.sprite.y / TILE)
    for (const exit of this.world.exits) {
      if (tx >= exit.tx && tx < exit.tx + exit.tw && ty >= exit.ty && ty < exit.ty + exit.th) {
        this.transitionTo(exit.to, exit.entry)
        return
      }
    }
  }

  private transitionTo(area: AreaId, entry: { tx: number; ty: number }): void {
    this.transitioning = true
    const state = this.session.state
    state.area = area
    state.position = { x: (entry.tx + 0.5) * TILE, y: (entry.ty + 0.5) * TILE }
    this.session.saveSoon()
    this.cameras.main.fade(240, 12, 12, 20, true)
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.scene.restart({ entry })
    })
  }

  /** Defeat: a short collapse beat, then wake at the village well. */
  private defeatRecovery(): void {
    this.transitioning = true
    // Tell the UI first: it holds the bars while the hero collapses, then
    // shows the recovered vitals once the screen is dark.
    bus.emit(EV.defeat, { phase: 'falling' })
    this.session.defeat()
    sfx('defeat')
    this.hero.sprite.setVelocity(0, 0)
    this.tweens.add({ targets: this.avatar.container ?? this.hero.sprite, scaleY: (this.avatar.container ?? this.hero.sprite).scaleY * 0.6, duration: 380, ease: 'Quad.easeIn' })
    this.hero.sprite.setTint(0x8a7a9a)
    // force: a fade-in still running (scene just started) must not swallow
    // this fade, or 'camerafadeoutcomplete' never fires and we soft-lock.
    this.cameras.main.fade(1100, 12, 12, 20, true)
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.scene.restart({ fromDefeat: true })
    })
  }

  // ------------------------------------------------------------- zoom

  private zoomFor(h: number): number {
    return Phaser.Math.Clamp(Math.round((h / 280) * 2) / 2, 1.5, 5)
  }

  private applyZoom(_w: number, h: number): void {
    this.cameras.main.setZoom(this.zoomFor(h))
  }

  // ------------------------------------------------------------- world upkeep

  private updateDiscoveries(): void {
    for (const spot of this.world.discoverySpots) {
      const d = Math.hypot(this.hero.sprite.x - (spot.tx * TILE + 8), this.hero.sprite.y - 8 - (spot.ty * TILE + 8))
      if (d < 24) this.session.recordDiscovery(spot.id, spot.label)
    }
  }
}
