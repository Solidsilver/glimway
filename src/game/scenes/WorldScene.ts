import Phaser from 'phaser'
import type { AreaId, GameState, QuestEvent } from '../../lib/state'
import { dialogueFor, emberDialogue, itemInfo, locations, type Dialogue } from '../../content/world'
import { placeFingersnapOccluder } from '../expansion'
import { bus, EV, type AbilityPayload, type DialogueClosedPayload, type PromptPayload } from '../events'
import { prefersReducedMotion, sfx } from '../sfx'
import { touchVec, uiBlocked, uiState } from '../input'
import { TERRAIN, TILE } from '../textures'
import type { Session } from '../session'
import { buildArea, type EmberSpotId, type EnemyType, type InteractId, type WorldData } from '../worlds'
import { getCombatKit, type CombatKit } from '../../lib/combat'
import { passiveRegenAllowed } from '../../lib/habitica/sync'
import { CHARM_ITEM, EMBER_COSTS, withCharm, ROAD_LANTERNS, isLit, type EmberSpend, type RoadLanternId } from '../../lib/embers'
import { loadCompanion, loadWorldAvatar } from '../avatar-render'

/**
 * Explicit mapping from procedural terrain ids to the delivered expansion's
 * named tiles (indexed by order in the expansion manifest). The runtime
 * tileset is a normalized 4x4 sheet of 32px cells drawn into 16px world tiles.
 */
const TERRAIN_TO_EXPANSION: Record<number, string> = {
  [TERRAIN.grass_a]: 'grass',
  [TERRAIN.grass_b]: 'forest-moss',
  [TERRAIN.grass_c]: 'grass',
  [TERRAIN.flowers]: 'flower-grass',
  [TERRAIN.path_a]: 'packed-dirt',
  [TERRAIN.path_b]: 'packed-dirt',
  [TERRAIN.dirt]: 'packed-dirt',
  [TERRAIN.sand]: 'packed-dirt',
  [TERRAIN.water_a]: 'pond-water',
  [TERRAIN.water_b]: 'pond-water',
  [TERRAIN.bridge]: 'wood-planks',
  [TERRAIN.stone_a]: 'cobblestone',
  [TERRAIN.stone_b]: 'cobblestone',
  [TERRAIN.stone_crack]: 'mossy-cobblestone',
  [TERRAIN.wall_stone]: 'shrine-stone',
  [TERRAIN.wall_moss]: 'mossy-cobblestone',
  [TERRAIN.roof]: 'dark-wood-planks',
  [TERRAIN.roof_edge]: 'dark-wood-planks',
  [TERRAIN.wall_house]: 'wood-planks',
  [TERRAIN.door]: 'dark-wood-planks',
  [TERRAIN.window]: 'dark-wood-planks',
  [TERRAIN.fence]: 'wood-planks'
}

interface SceneData {
  entry?: { tx: number; ty: number }
  fromDefeat?: boolean
}

interface NpcEntity {
  id: Exclude<InteractId, 'clue' | 'lantern'>
  sprite: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite
}

interface Enemy {
  id: string
  type: EnemyType
  sprite: Phaser.Physics.Arcade.Sprite
  hp: number
  maxHp: number
  homeX: number
  homeY: number
  dirX: number
  dirY: number
  wanderTimer: number
  attackTimer: number
  state: 'chase' | 'telegraph' | 'lunge' | 'recover' | 'stunned'
  stateTimer: number
  lungeX: number
  lungeY: number
  /** Remaining hurt-pose window (seconds); visual only. */
  hurtTimer: number
  /** Knockback in progress: physics velocity owned by the shove, AI paused. */
  knockTimer: number
  /** Sidestepping an obstacle on the way home (seconds left). */
  detourTimer: number
  knockX: number
  knockY: number
  /** Atlas art prefix for small enemies ('slime' | 'mushroom' | 'beetle'). */
  art: string
  dead: boolean
}

interface Interactable {
  id: InteractId
  x: number
  y: number
  label: string
}

/** Who the player has already heard from at each quest stage (this tab). */
const heardAt = new Set<string>()

/** Was this a touch-first device? Picks the in-world button hint. */
function isTouchFirst(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
  } catch {
    return false
  }
}

const NPC_NAMES: Record<string, string> = {
  mara: 'Mara',
  orrin: 'Orrin',
  pip: 'Pip'
}

const PLAYER_SPEED = 110
const ATTACK_RANGE = 26
const CONTACT_IFRAMES = 1.1

/**
 * Cozy-demo combat tuning: every real attack is telegraphed (a windup pose,
 * a "!" and a rising tone) so it can be read and dodged; bumping into an
 * enemy that isn't attacking only stings.
 */
const ENEMY_TUNING = {
  // lock: seconds before launch when the aim freezes (with a white flash) —
  // the moment to step aside.
  wisp: { hp: 10, contact: 1, chase: 38, aggro: 90, hopRange: 46, windup: 0.5, lock: 0.18, hopSpeed: 175, hopTime: 0.24, hop: 2, recover: 0.65, cooldown: 1.4 },
  beetle: { hp: 18, contact: 1, walk: 30, aggro: 130, keepAway: 64, chargeRange: 120, windup: 0.8, lock: 0.3, chargeSpeed: 220, chargeTime: 0.85, charge: 3, stun: 1.4, recover: 0.5, cooldown: 2.1, stunnedTakes: 1.5 },
  guardian: { hp: 44, contact: 2, lunge: 3, lungeSpeed: 250, telegraph: 0.65, cooldown: 3.2 }
} as const

/** Dodge roll: a short burst with invulnerability, on its own cooldown. */
const DODGE = { speed: 240, time: 0.2, iframes: 0.32, cooldown: 0.75 }

/** Knockback impulses (px/s) applied over KNOCK.time through physics. */
const KNOCK = { small: 170, guardian: 60, player: 150, time: 0.13 }

export class WorldScene extends Phaser.Scene {
  private session!: Session
  private world!: WorldData
  private player!: Phaser.Physics.Arcade.Sprite
  private heroShadow!: Phaser.GameObjects.Image
  private facing: Phaser.Math.Vector2 = new Phaser.Math.Vector2(0, 1)
  private npcs: NpcEntity[] = []
  private enemies: Enemy[] = []
  private bolts!: Phaser.Physics.Arcade.Group
  private hpBars!: Phaser.GameObjects.Graphics
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys
  private wasd!: Record<string, Phaser.Input.Keyboard.Key>
  private actionKeys!: Record<string, Phaser.Input.Keyboard.Key>

  private interactables: Interactable[] = []
  private currentTarget: Interactable | null = null
  private lastPrompt: string | null = null
  private solidGroup!: Phaser.Physics.Arcade.StaticGroup

  private attackCooldown = 0
  private castCooldown = 0
  /** Remaining shadowstep-dash window (seconds) — movement defers to it. */
  private dashTime = 0
  private avatarContainer: Phaser.GameObjects.Container | null = null
  private petSprite: Phaser.GameObjects.Image | null = null
  private avatarFallbackNotified = false
  private avatarPartialNotified = false
  private riding = false
  private iframes = 0
  private transitioning = false
  private guardianSpawned = false
  /** Atlas-prop lanterns that can glow when lit: shrine and village lantern. */
  /** Flames that can be lit: 'village', 'shrine', or a road lantern id. */
  private lightProps: { id: string; sprite: Phaser.GameObjects.Image; gx: number; gy: number; glow: Phaser.GameObjects.Image | null }[] = []
  private positionTimer = 0
  /** Foreground canopies/arches that fade when something walks beneath. */
  private occluders: { image: Phaser.GameObjects.Image; bounds: Phaser.Geom.Rectangle; footY: number }[] = []
  /** Floating "!" / "…" markers keyed by interactable id. */
  private markers = new Map<string, Phaser.GameObjects.Image>()
  /** Keycap hint floating above the current interaction target. */
  private keyHint: Phaser.GameObjects.Image | null = null
  private reducedMotion = false
  private captureReleased = false
  private cinematic = false
  private dodgeCooldown = 0

  constructor() {
    super('World')
  }

  init(data: SceneData): void {
    this.transitioning = false
    this.guardianSpawned = false
    this.currentTarget = null
    this.lastPrompt = null
    this.pendingEntry = data?.entry ?? null
    this.pendingDefeatToast = data?.fromDefeat === true
  }

  private pendingEntry: { tx: number; ty: number } | null = null
  private pendingDefeatToast = false

  create(): void {
    this.session = this.registry.get('session') as Session
    const state = this.session.state
    this.world = buildArea(state.area)
    this.npcs = []
    this.enemies = []
    this.occluders = []
    this.markers = new Map()
    this.keyHint = null
    this.lightProps = []
    this.cinematic = false
    this.dodgeCooldown = 0
    this.captureReleased = false
    this.reducedMotion = prefersReducedMotion()

    this.buildGround()
    this.buildSolids()
    this.buildProps()
    this.buildInteractables()
    this.buildPlayer(state, this.pendingEntry)
    this.buildNpcs()
    this.buildEnemies(state)
    this.buildForeground()
    this.buildExitSigns()
    this.physics.add.collider(this.player, this.solidGroup)

    // Arcade's world bounds default to the canvas size, which is larger than
    // small maps — without this the hero can walk off the map edge.
    this.physics.world.setBounds(0, 0, this.world.widthPx, this.world.heightPx)
    this.cameras.main.setBounds(0, 0, this.world.widthPx, this.world.heightPx)
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12)
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
    bus.on(EV.cast, this.handleCast, this)
    bus.on(EV.dodge, this.onDodgeKey, this)
    bus.on(EV.dialogueClosed, this.onDialogueClosed, this)
    this.events.once('shutdown', () => {
      for (const key of Object.values(this.actionKeys)) key.removeAllListeners('down')
      bus.off(EV.action, this.handleAction, this)
      bus.off(EV.cast, this.handleCast, this)
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
    this.refreshLanternVisuals()
    this.buildMarkers()
    this.emitPortraits()
    bus.on(EV.quest, this.refreshMarkers, this)
    this.events.once('shutdown', () => bus.off(EV.quest, this.refreshMarkers, this))
    bus.on(EV.profileChanged, this.onProfileChanged, this)
    this.events.once('shutdown', () => {
      bus.off(EV.profileChanged, this.onProfileChanged, this)
      // Epoch bump: in-flight avatar/companion loads must not add objects to a
      // dead scene or fight a rebuilt scene's own composition.
      this.avatarBuildToken++
      this.avatarContainer = null
      this.petSprite = null
    })
    void this.buildAvatarVisual() // imported layered avatar (if any)

    // Read-only handle for automated playtesting (docs/playtest.md).
    ;(window as unknown as { __fsPlayer?: () => { x: number; y: number; body: { x: number; y: number; w: number; h: number }; blocked: Record<string, boolean> } }).__fsPlayer = () => {
      const b = this.player.body as Phaser.Physics.Arcade.Body
      return {
        x: this.player.x,
        y: this.player.y,
        body: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
        blocked: { up: b.blocked.up, down: b.blocked.down, left: b.blocked.left, right: b.blocked.right }
      }
    }
    ;(window as unknown as { __fsEnemies?: () => Array<{ x: number; y: number; state: string; hp: number; texture: string; body: { x: number; y: number; w: number; h: number }; flipX: boolean; type: string; locked: boolean }> }).__fsEnemies =
      () => this.enemies.map((e) => {
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
        this.iframes = 0
        this.damagePlayer(n, this.player.x - 1)
      }
      w.__fsDevWarp = (area: AreaId, tx: number, ty: number) => this.transitionTo(area, { tx, ty })
      // Roll in a given direction from inside the frame loop, so playtests can
      // react to an aim lock without input latency.
      w.__fsDevDodge = (dx: number, dy: number) => this.tryDodge(new Phaser.Math.Vector2(dx, dy))
      w.__fsDevStrike = (n: number, type?: EnemyType) => {
        for (const e of [...this.enemies]) if (!e.dead && (!type || e.type === type)) this.damageEnemy(e, n, this.player.x)
      }
    }
    // Sync-safety snapshot for the UI gate (read-only).
    ;(window as unknown as { __fsSafety?: () => { areaId: AreaId; transitioning: boolean; dialogueOpen: boolean; enemiesNear: boolean } }).__fsSafety = () => {
      const px = this.player.x
      const py = this.player.y
      return {
        areaId: this.world.areaId,
        transitioning: this.transitioning,
        dialogueOpen: uiState.dialogueOpen,
        enemiesNear: this.enemies.some((e) => Math.hypot(e.sprite.x - px, e.sprite.y - py) < 200)
      }
    }
    // Read-only avatar/combat diagnostics for verification (no mutation).
    ;(window as unknown as { __fsDebug?: () => Record<string, unknown> }).__fsDebug = () => ({
      avatar: !!this.avatarContainer,
      pet: !!this.petSprite,
      riding: this.riding,
      playerAlpha: this.player.alpha,
      playerVisible: this.player.visible,
      bolts: this.bolts ? this.bolts.getLength() : -1,
      attackCooldown: this.attackCooldown,
      castCooldown: this.castCooldown,
      facing: { x: this.facing.x, y: this.facing.y },
      heroTex: this.player.texture.key,
      npcs: this.npcs.map((n) => ({
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
        const b = this.player.body as Phaser.Physics.Arcade.Body
        return { vx: b.velocity.x, vy: b.velocity.y, moves: b.moves, enable: b.enable, physicsPaused: this.physics.world.isPaused }
      })()
    })

    if (this.pendingDefeatToast) {
      this.pendingDefeatToast = false
      bus.emit(EV.defeat, { phase: 'woke' })
    }
  }

  // ------------------------------------------------------------- world build

  private buildGround(): void {
    const manifest = this.cache.json.get('fingersnap-expansion-manifest') as {
      terrain: { tileWidth: number; tiles: Record<string, string> }
    } | null
    const tileIndex: Record<string, number> = {}
    if (manifest) {
      for (const [k, name] of Object.entries(manifest.terrain.tiles)) tileIndex[name] = Number(k)
    }
    const cell = manifest ? manifest.terrain.tileWidth : 32
    const cols = 4
    const sheet = this.textures.get('fingersnap-terrain-runtime').getSourceImage() as HTMLCanvasElement
    const canvas = document.createElement('canvas')
    canvas.width = this.world.widthPx
    canvas.height = this.world.heightPx
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    for (let y = 0; y < this.world.height; y++) {
      for (let x = 0; x < this.world.width; x++) {
        const id = this.world.ground[y][x]
        const draw = (name: string) => {
          const idx = tileIndex[name] ?? 0
          ctx.drawImage(sheet, (idx % cols) * cell, Math.floor(idx / cols) * cell, cell, cell, x * TILE, y * TILE, TILE, TILE)
        }
        if (id === TERRAIN.bridge) draw('pond-water')
        draw(TERRAIN_TO_EXPANSION[id] ?? 'grass')
      }
    }
    const key = `ground-${this.world.areaId}`
    if (this.textures.exists(key)) this.textures.remove(key)
    this.textures.addCanvas(key, canvas)
    this.add.image(0, 0, key).setOrigin(0, 0).setDepth(-10)
  }

  private buildSolids(): void {
    this.solidGroup = this.physics.add.staticGroup()
    const addBlock = (cx: number, cy: number, w: number, h: number) => {
      const img = this.physics.add.staticImage(cx, cy, 'px').setDisplaySize(w, h).refreshBody()
      img.setVisible(false)
      this.solidGroup.add(img)
    }
    // Terrain solid tiles, merged into horizontal runs
    for (let y = 0; y < this.world.height; y++) {
      let x = 0
      while (x < this.world.width) {
        if (this.world.solid[y][x]) {
          let x2 = x
          while (x2 + 1 < this.world.width && this.world.solid[y][x2 + 1]) x2++
          addBlock((x + (x2 - x + 1) / 2) * TILE, y * TILE + TILE / 2, (x2 - x + 1) * TILE, TILE)
          x = x2 + 1
        } else {
          x++
        }
      }
    }
    // Prop bodies (visible sprites are drawn separately for depth sorting)
    const addPropBody = (tx: number, ty: number, w: number, h: number) => {
      addBlock(tx * TILE + TILE / 2, ty * TILE + TILE - h / 2, w, h)
    }
    for (const t of this.world.trees) addPropBody(t.tx, t.ty, 12, 6)
    for (const b of this.world.bushes) addPropBody(b.tx, b.ty, 12, 8)
    for (const r of this.world.rocks) addPropBody(r.tx, r.ty, 12, 8)
    if (this.world.well) addPropBody(this.world.well.tx, this.world.well.ty, 14, 10)
    if (this.world.mural) addPropBody(this.world.mural.tx, this.world.mural.ty, 16, 8)
    for (const n of this.world.npcs) addPropBody(n.tx, n.ty, 12, 8)
  }

  private buildProps(): void {
    for (const t of this.world.trees) {
      this.add.image(t.tx * TILE + 8, t.ty * TILE + TILE, 'tree').setOrigin(0.5, 1)
    }
    for (const b of this.world.bushes) {
      this.add.image(b.tx * TILE + 8, b.ty * TILE + TILE, 'bush').setOrigin(0.5, 1).setDepth(b.ty * TILE + TILE)
    }
    for (const r of this.world.rocks) {
      this.add.image(r.tx * TILE + 8, r.ty * TILE + TILE, 'rock').setOrigin(0.5, 1).setDepth(r.ty * TILE + TILE)
    }
    if (this.world.well) {
      const w = this.world.well
      this.add.image(w.tx * TILE + 6, w.ty * TILE + TILE, 'well').setOrigin(0.5, 1).setDepth(w.ty * TILE + TILE)
    }
    // The ruin's route marker is the quest's clue: it needs a visible stone
    // (it used to be an invisible interactable on a bare wall).
    if (this.world.mural) {
      const m = this.world.mural
      const x = m.tx * TILE + 8
      const y = m.ty * TILE + TILE
      const props = this.textures.get('fingersnap-props')
      if (props.has('stone-milestone')) {
        const f = props.get('stone-milestone')!
        this.add.image(x, y, 'fingersnap-props', 'stone-milestone').setOrigin(0.5, 1).setScale(22 / f.height).setDepth(y)
      } else {
        this.add.image(x, y, 'mural').setOrigin(0.5, 1).setDepth(y)
      }
    }
    // Supplied atlas props at deliberate small-world display heights, with
    // explicit collision boxes at their bases.
    for (const p of this.world.props) {
      if (!this.textures.get('fingersnap-props').has(p.frame)) continue
      const frame = this.textures.get('fingersnap-props').get(p.frame)!
      const scale = p.h / frame.height
      const x = p.tx * TILE + TILE / 2
      const y = p.ty * TILE + TILE
      const img = this.add.image(x, y, 'fingersnap-props', p.frame)
        .setOrigin(0.5, 1)
        .setScale(scale)
        .setDepth(y)
      const body = this.physics.add.staticImage(x, y - p.body[1] / 2, 'px')
        .setDisplaySize(p.body[0], p.body[1])
        .refreshBody()
      body.setVisible(false)
      this.solidGroup.add(body)
      // Light-capable props get a glow anchor near their lamp
      if (p.light) {
        this.lightProps.push({ id: p.light, sprite: img, gx: x, gy: y - p.h * 0.72, glow: null })
      }
    }
  }

  private buildInteractables(): void {
    this.interactables = []
    for (const n of this.world.npcs) {
      this.interactables.push({
        id: n.id,
        x: n.tx * TILE + 8,
        y: n.ty * TILE + TILE - 4,
        label: `Talk to ${NPC_NAMES[n.id]}`
      })
    }
    if (this.world.mural) {
      this.interactables.push({ id: 'clue', x: this.world.mural.tx * TILE + 8, y: this.world.mural.ty * TILE + TILE, label: 'Study the route marker' })
    }
    if (this.world.shrine) {
      this.interactables.push({ id: 'lantern', x: this.world.shrine.tx * TILE + 8, y: this.world.shrine.ty * TILE + TILE, label: 'Look at the lantern' })
    }
    for (const spot of this.world.emberSpots) {
      this.interactables.push({
        id: spot.id,
        x: spot.tx * TILE + 8,
        y: spot.ty * TILE + TILE,
        label: spot.id === 'hearth' ? 'Sit by the lantern' : spot.id === 'chest' ? 'Look at the chest' : 'Look at the lantern'
      })
    }
  }

  private isEmberSpot(id: InteractId): id is EmberSpotId {
    return id === 'hearth' || id === 'chest' || (ROAD_LANTERNS as readonly string[]).includes(id)
  }

  /** Whether an ember spot has something to buy right now (drives its marker). */
  private emberSpotReady(id: EmberSpotId): boolean {
    const spend: EmberSpend = id === 'hearth' ? { kind: 'rest' } : id === 'chest' ? { kind: 'chest' } : { kind: 'road-lantern', id }
    return this.session.checkSpend(spend).ok
  }

  /** Prompt wording that says what pressing the button will actually do. */
  private promptLabel(it: Interactable): string {
    const stage = this.session.questStage
    if (it.id === 'clue') return stage === 'accepted' ? 'Take a rubbing of the marker' : it.label
    if (it.id === 'lantern') return stage === 'guardian-defeated' ? 'Light the lantern' : it.label
    if (it.id === 'chest') return this.session.state.flags.includes('opened:ashwatch-chest') ? it.label : `Open the chest · ${EMBER_COSTS.chest} embers`
    if (it.id === 'hearth') return `Rest by the lantern · ${EMBER_COSTS.rest} embers`
    if (this.isEmberSpot(it.id)) {
      return isLit(this.session.state, it.id as RoadLanternId) ? it.label : `Light the lantern · ${EMBER_COSTS.roadLantern} embers`
    }
    return it.label
  }

  /** Height above an interactable's base where its marker floats. */
  private markerOffset(id: InteractId): number {
    if (id === 'lantern') return 44
    if (id === 'hearth') return 36
    if (id === 'road-1' || id === 'road-2' || id === 'road-3') return 32
    if (id === 'clue' || id === 'chest') return 22
    return 25
  }

  /** "!" over whoever moves the story on, "…" over anyone with news. */
  private buildMarkers(): void {
    for (const it of this.interactables) {
      const img = this.add.image(it.x, it.y - this.markerOffset(it.id), 'mark-quest')
        .setOrigin(0.5, 1)
        .setDepth(6000)
        .setVisible(false)
      if (!this.reducedMotion) {
        this.tweens.add({ targets: img, y: img.y - 2, duration: 650, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
      }
      this.markers.set(it.id, img)
    }
    this.keyHint = this.add.image(0, 0, isTouchFirst() ? 'key-a' : 'key-e')
      .setOrigin(0.5, 1)
      .setDepth(6001)
      .setVisible(false)
    this.refreshMarkers()
  }

  private refreshMarkers(): void {
    if (!this.session) return
    const stage = this.session.questStage
    for (const it of this.interactables) {
      const img = this.markers.get(it.id)
      if (!img || !img.active) continue
      let kind: 'quest' | 'talk' | null = null
      if (this.isEmberSpot(it.id)) {
        kind = this.emberSpotReady(it.id) ? 'talk' : null
      } else {
        try {
          const d = dialogueFor(it.id, stage)
          if (d.event) kind = 'quest'
          else if (it.id in NPC_NAMES && !heardAt.has(`${it.id}@${stage}`)) kind = 'talk'
        } catch {
          kind = null
        }
      }
      if (kind) img.setTexture(kind === 'quest' ? 'mark-quest' : 'mark-talk')
      img.setVisible(kind !== null && this.currentTarget?.id !== it.id)
    }
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

  private buildPlayer(state: GameState, entry: { tx: number; ty: number } | null): void {
    let px: number
    let py: number
    if (entry) {
      px = (entry.tx + 0.5) * TILE
      py = (entry.ty + 0.5) * TILE
    } else {
      const saved = state.position
      px = saved.x
      py = saved.y
      // Fall back to spawn if the saved spot is out of bounds or solid.
      const tx = Math.floor(px / TILE)
      const ty = Math.floor(py / TILE)
      const inBounds = tx >= 0 && ty >= 0 && tx < this.world.width && ty < this.world.height
      if (!inBounds || this.world.solid[ty][tx]) {
        px = (this.world.spawn.tx + 0.5) * TILE
        py = (this.world.spawn.ty + 0.5) * TILE
      }
    }
    this.heroShadow = this.add.image(px, py - 1, 'shadow').setDepth(-1)
    // Delivered 4-direction walk hero, normalized to the 16px world
    // (source frames are ~133x228; displayed ~20px tall).
    const tex = this.textures.get('fingersnap-demo-walk')
    const heroFrame = tex.has('walk-down-0') ? tex.get('walk-down-0')! : null
    const heroH = 20
    let heroScale = 1
    if (heroFrame) heroScale = heroH / heroFrame.height
    this.player = this.physics.add.sprite(px, py, heroFrame ? 'fingersnap-demo-walk' : 'hero0', heroFrame ? 'walk-down-0' : undefined)
    this.player.setOrigin(0.5, 1)
    this.player.setScale(heroScale)
    const body = this.player.body as Phaser.Physics.Arcade.Body
    // Body sizes/offsets are in SOURCE pixels (scaled by the sprite's scale),
    // so express the 10x4 world foot-box in source units at the feet.
    body.setSize(10 / heroScale, 4 / heroScale)
    body.setOffset((heroFrame ? heroFrame.width : 16) / 2 - 5 / heroScale, (heroFrame ? heroFrame.height : 16) - 4 / heroScale)
    // Never wander off the rendered map (e.g. a zero-HP gate blocking the exit
    // tile must stop at the boundary, hero visible, no softlock); area exits
    // still trigger inside the bounds.
    body.setCollideWorldBounds(true)
    this.player.setDepth(py)
  }

  private buildNpcs(): void {
    for (const n of this.world.npcs) {
      const x = n.tx * TILE + 8
      const y = n.ty * TILE + TILE
      // Delivered breathing art: two poses at 1.5 fps on a foot-anchored
      // sprite. The old bob tween is intentionally gone — the runtime-pass
      // README warns never to stack a bob on top of breathing (stable feet).
      const anim = `${n.id}-breathing`
      if (this.anims.exists(anim) && this.textures.exists(`${n.id}-idle-0`)) {
        const sprite = this.add.sprite(x, y, `${n.id}-idle-0`)
          .setOrigin(0.5, 1)
          .setDepth(y)
        sprite.play(anim)
        this.npcs.push({ id: n.id, sprite })
      } else {
        // Fallback placeholder: static image with the old restrained bob.
        const sprite = this.add.image(x, y, n.id)
          .setOrigin(0.5, 1)
          .setDepth(y)
        this.npcs.push({ id: n.id, sprite })
        this.tweens.add({
          targets: sprite,
          y: '-=1.5',
          duration: 900 + Math.random() * 400,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut'
        })
      }
    }
  }

  private buildEnemies(state: GameState): void {
    this.bolts = this.physics.add.group()
    for (const spot of this.world.enemies) {
      if (spot.type === 'guardian') continue // guardian is quest-driven
      if (state.defeatedEnemies.includes(spot.id)) continue
      this.spawnEnemy(spot.id, spot.type, spot.tx, spot.ty)
    }
    if (this.world.areaId === 'ruin' && state.quest === 'clue-found') {
      this.spawnGuardian(false)
    }
    this.hpBars = this.add.graphics().setDepth(5000)
  }

  /**
   * Delivered foreground occluders: canopies over existing tree bases (their
   * collisions stay the trees'), arches over area gates, ferns as pure decor.
   * No new collision — occluders are visual only.
   */
  private buildForeground(): void {
    const spots: { frame: string; tx: number; ty: number; w: number }[] = []
    if (this.world.areaId === 'woodland') {
      for (let i = 0; i < this.world.trees.length; i += 9) {
        const t = this.world.trees[i]
        spots.push({ frame: i % 18 === 0 ? 'oak-canopy' : 'pine-canopy', tx: t.tx, ty: t.ty, w: 60 })
      }
      spots.push({ frame: 'leafy-arch', tx: 2, ty: 15, w: 48 })
      spots.push({ frame: 'fern-cluster', tx: 10, ty: 16, w: 28 })
      spots.push({ frame: 'fern-cluster', tx: 30, ty: 23, w: 28 })
    } else if (this.world.areaId === 'ruin') {
      spots.push({ frame: 'stone-arch', tx: 2, ty: 13, w: 48 })
      spots.push({ frame: 'fern-cluster', tx: 12, ty: 19, w: 26 })
      spots.push({ frame: 'fern-cluster', tx: 24, ty: 7, w: 26 })
    } else {
      spots.push({ frame: 'leafy-arch', tx: 1, ty: 12, w: 44 })
      spots.push({ frame: 'fern-cluster', tx: 7, ty: 17, w: 26 })
    }
    for (const s of spots) {
      const footY = s.ty * TILE + TILE
      const image = placeFingersnapOccluder(this, s.frame, s.tx * TILE + 8, footY, s.w)
      this.occluders.push({ image, bounds: image.getBounds(), footY })
    }
  }

  /**
   * Readable exits: a floating destination label and pulsing chevrons on the
   * exit tiles pointing the way out.
   */
  private buildExitSigns(): void {
    for (const exit of this.world.exits) {
      const westEdge = exit.tx === 0
      const midY = (exit.ty + exit.th / 2) * TILE
      const edgeX = westEdge ? exit.tx * TILE + 6 : (exit.tx + 1) * TILE - 6
      const chevron = this.add.image(edgeX, midY, 'mark-chevron')
        .setDepth(5500)
        .setFlipX(westEdge)
        .setAlpha(0.9)
      if (!this.reducedMotion) {
        this.tweens.add({
          targets: chevron,
          x: edgeX + (westEdge ? -4 : 4),
          alpha: 0.45,
          duration: 700,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut'
        })
      }
      // Destination label: high-resolution text so it stays crisp at zoom.
      const name = locations[exit.to].name
      const labelX = westEdge ? exit.tx * TILE + 26 : (exit.tx + 1) * TILE - 26
      this.add.text(labelX, midY - 20, westEdge ? `◂ ${name}` : `${name} ▸`, {
        fontFamily: '"Pixelify Sans", monospace',
        fontSize: '7px',
        color: '#fff3c4',
        stroke: '#2b1d1a',
        strokeThickness: 3,
        resolution: 8
      })
        .setOrigin(westEdge ? 0 : 1, 0.5)
        .setDepth(5501)
    }
  }

  /** Canopies and arches fade so nothing (hero or enemy) hides beneath them. */
  private updateOccluders(dt: number): void {
    if (this.occluders.length === 0) return
    const things: { x: number; y: number }[] = [{ x: this.player.x, y: this.player.y }]
    for (const e of this.enemies) things.push({ x: e.sprite.x, y: e.sprite.y })
    for (const o of this.occluders) {
      const covered = things.some((t) => t.y <= o.footY + 2 && o.bounds.contains(t.x, t.y - 6))
      const target = covered ? 0.38 : 1
      o.image.alpha += (target - o.image.alpha) * Math.min(1, dt * 10)
    }
  }

  // ------------------------------------------------------------- enemies

  private spawnEnemy(id: string, type: EnemyType, tx: number, ty: number): Enemy {
    // Woodland enemies use the delivered slime/mushroom art; the guardian
    // uses the delivered native 24x24 pose textures when present (procedural
    // placeholder otherwise). Every pose shares the same 24x24 texture size
    // and (0.5, 1) origin, so the intended world size and the authored
    // 20x10 foot body are identical across poses.
    const art = type === 'beetle' ? 'beetle' : id === 'wisp-c' ? 'mushroom' : 'slime'
    const frame = type === 'guardian' ? 'guardian0' : `${art}-idle`
    const texKey = type === 'guardian' ? this.guardianPoseTexture('idle', 'guardian0') : 'fingersnap-enemies'
    const displayH = type === 'guardian' ? 24 : type === 'beetle' ? 13 : 14
    const sprite = this.physics.add.sprite(tx * TILE + 8, ty * TILE + TILE, texKey, type === 'guardian' ? undefined : frame)
      .setOrigin(0.5, 1)
    if (type !== 'guardian') {
      const f = this.textures.get('fingersnap-enemies').get(frame)!
      const s = displayH / f.height
      sprite.setScale(s)
      // Source-unit foot box for the scaled sprite (10x4 world px at feet).
      const ebody = sprite.body as Phaser.Physics.Arcade.Body
      ebody.setSize(10 / s, 4 / s)
      ebody.setOffset(f.width / 2 - 5 / s, f.height - 4 / s)
      const anim = `${art}-idle`
      if (this.anims.exists(anim)) sprite.play(anim)
    } else {
      const gbody = sprite.body as Phaser.Physics.Arcade.Body
      // Authored guardian foot body: 20x10 anchored at the texture feet
      // (24x24 texture, offset 2,14 -> rows 14..24). Never inferred from art.
      gbody.setSize(20, 10)
      gbody.setOffset(2, 14)
    }
    const enemy: Enemy = {
      id,
      type,
      sprite,
      hp: ENEMY_TUNING[type].hp,
      maxHp: ENEMY_TUNING[type].hp,
      homeX: tx * TILE + 8,
      homeY: ty * TILE + TILE,
      dirX: 0,
      dirY: 0,
      wanderTimer: Math.random() * 2,
      attackTimer: 2.5,
      state: 'chase',
      stateTimer: 0,
      lungeX: 0,
      lungeY: 0,
      hurtTimer: 0,
      knockTimer: 0,
      detourTimer: 0,
      knockX: 0,
      knockY: 0,
      art,
      dead: false
    }
    // Enemies respect walls, trees and water: a charge can end in a tree.
    // They also stay on the map: an exit gap in the treeline is a way out
    // for the hero, never for a beetle mid-charge.
    this.physics.add.collider(sprite, this.solidGroup)
    ;(sprite.body as Phaser.Physics.Arcade.Body).setCollideWorldBounds(true)
    this.enemies.push(enemy)
    return enemy
  }

  /**
   * Spawn the warden. Announces only when triggered by the clue dialogue —
   * respawns (re-entering mid-fight, reload) stay silent.
   */
  private spawnGuardian(announce: boolean): void {
    if (this.guardianSpawned) return
    if (!this.world.shrine) return
    if (this.session.questStage !== 'clue-found') return
    this.guardianSpawned = true
    this.spawnEnemy('stone-warden', 'guardian', this.world.shrine.tx + 1, this.world.shrine.ty + 3)
    if (announce) {
      bus.emit(EV.toast, { text: 'The air goes cold. The stone warden grinds awake!' })
      if (!this.reducedMotion) this.cameras.main.shake(260, 0.005)
    }
  }

  /**
   * Delivered guardian pose textures (idle/windup/lunge/hurt/defeat), falling
   * back to the procedural placeholders when the runtime pass is absent.
   * Poses are discrete states selected by the combat state machine — never
   * one looping animation. Source art faces right; flipX mirrors it. All
   * frames share the 24x24 texture and (0.5, 1) foot anchor, so switching
   * poses keeps the body and baseline stable.
   */
  private guardianPoseTexture(pose: 'idle' | 'windup' | 'lunge' | 'hurt' | 'defeat', fallback: string): string {
    const key = `guardian-${pose}`
    return this.textures.exists(key) ? key : fallback
  }

  /** The pose matching the guardian's current state-machine state. */
  private guardianStateTexture(enemy: Enemy): string {
    if (enemy.state === 'telegraph') return this.guardianPoseTexture('windup', 'guardian1')
    if (enemy.state === 'lunge') return this.guardianPoseTexture('lunge', 'guardian1')
    return this.guardianPoseTexture('idle', 'guardian0')
  }

  /**
   * Brief hurt pose on a non-lethal hit: only arms a short visual timer that
   * applyGuardianPose consumes. The state machine — including any lunge in
   * progress — and the physics body are untouched, and a dying guardian can
   * never re-select a pose (killEnemy owns the defeat pose).
   */
  private flashGuardianHurt(enemy: Enemy): void {
    if (!this.textures.exists('guardian-hurt')) return
    enemy.hurtTimer = 0.16
  }

  private killEnemy(enemy: Enemy): void {
    enemy.dead = true
    sfx('pop')
    this.session.recordDefeat(enemy.id)
    // Spark burst
    const bx = enemy.sprite.x
    const by = enemy.sprite.y - 6
    const particles = this.add.particles(bx, by, 'spark', {
      speed: { min: 30, max: 90 },
      lifespan: 420,
      quantity: 10,
      scale: { start: 1, end: 0 },
      emitting: false
    })
    particles.explode(10)
    this.time.delayedCall(700, () => particles.destroy())
    if (enemy.type === 'guardian' && this.textures.exists('guardian-defeat')) {
      // Collapsed death pose, held visible and untinted through the dissolve
      // (pose retires only when the sprite is destroyed below).
      enemy.sprite.clearTint()
      enemy.sprite.setTexture('guardian-defeat')
    }
    // Freeze the corpse: a mid-lunge guardian still holds ~250 px/s velocity,
    // and the dynamic body's postUpdate would fight the sink tween. Disable
    // the body so the dissolve tween owns the sprite fully.
    const corpseBody = enemy.sprite.body as Phaser.Physics.Arcade.Body
    corpseBody.setVelocity(0, 0)
    corpseBody.enable = false
    this.tweens.add({
      targets: enemy.sprite,
      alpha: 0,
      y: '+=4',
      scaleY: 0.6,
      duration: 320,
      onComplete: () => enemy.sprite.destroy()
    })
    this.enemies = this.enemies.filter((e) => e !== enemy)
    if (enemy.type === 'guardian') {
      this.session.applyQuestEvent('defeat-guardian')
    }
  }

  /**
   * Imported characters render as a static, layered Habitica avatar with a
   * restrained code-driven bob (no walking sprites are claimed for it). The
   * demo hero keeps its animated placeholder. Fallbacks are labelled.
   * Stale-async guard: a token invalidates older rebuild completions (new
   * rebuild, ride toggle, sync commit, scene shutdown each bump the epoch).
   *
   * Composition: official Habitica layers are drawn on shared canvases —
   * walking layers on a 90px grid, mount layers on a larger 135px canvas with
   * the same art scale. Aligning every layer by CENTER with one uniform scale
   * reproduces the official stacking for the mixed-canvas case; anchoring by
   * the first layer's height would shrink the whole avatar whenever a mount
   * layer happened to come first.
   */
  private avatarBuildToken = 0

  /** Habitica sprite grid (source px) and its on-screen height in the 16px world. */
  private static readonly AVATAR_CANVAS = 90
  private static readonly AVATAR_DISPLAY = 22

  private async buildAvatarVisual(): Promise<void> {
    const profile = this.session.importedProfile
    if (!profile) return
    const token = ++this.avatarBuildToken
    const loaded = await loadWorldAvatar(this, profile, this.riding)
    if (token !== this.avatarBuildToken) return // a newer rebuild superseded this one
    if (this.avatarContainer) {
      this.avatarContainer.destroy()
      this.avatarContainer = null
    }
    this.clearPet()
    if (loaded.fallback) {
      // Restore the visible demo hero — a previous build may have hidden it.
      this.player.setAlpha(1)
      if (!this.avatarFallbackNotified) {
        this.avatarFallbackNotified = true
        bus.emit(EV.toast, { text: 'Your Habitica look isn\u2019t in the art cache yet — Wren stands in for you.' })
      }
      return
    }
    if (loaded.remoteOnly.length > 0 || loaded.failedKeys.length > 0) {
      // Honest partial-cache notice: layers exist upstream but are not in the
      // WebGL-safe local cache (or failed to load) — they are skipped, never
      // invented or fetched cross-origin.
      if (!this.avatarPartialNotified) {
        this.avatarPartialNotified = true
        bus.emit(EV.toast, {
          text: 'A few pieces of your Habitica outfit aren\u2019t in the art cache, so they\u2019re left off.',
          kind: 'info'
        })
      }
    }
    const scale = WorldScene.AVATAR_DISPLAY / WorldScene.AVATAR_CANVAS
    // All layers share one center, half a display-height above the feet.
    const centerY = -WorldScene.AVATAR_DISPLAY / 2
    // Official composition (avatar.vue + sprites.css @789bbe4a): every layer
    // canvas stacks at a SHARED TOP-LEFT origin; mount canvases are shifted
    // +18 grid px DOWN (margin-top) with X unchanged (their extra width
    // extends right only). For this center-anchored stack that places a mount
    // layer's center at (+22.5, +40.5) grid px from the shared center — the
    // rider sits on the wolf's back instead of standing beside it.
    const isMountLayer = (key: string) => {
      const name = key.startsWith('fs-asset-') ? key.slice('fs-asset-'.length) : key
      return name.startsWith('Mount_Body_') || name.startsWith('Mount_Head_')
    }
    const images = loaded.layerKeys.map((k) => {
      const img = this.add.image(0, centerY, k).setOrigin(0.5, 0.5).setScale(scale)
      if (isMountLayer(k)) img.setPosition(22.5 * scale, centerY + 40.5 * scale)
      return img
    })
    this.avatarContainer = this.add.container(this.player.x, this.player.y, images)
    this.player.setAlpha(0) // physics anchor invisible; the container is the body
    this.heroShadow.setAlpha(0.25)
    void this.buildPetFollower(token)
  }

  private clearPet(): void {
    if (this.petSprite) {
      this.petSprite.destroy()
      this.petSprite = null
    }
  }

  /** Selected pet trails the hero (never baked into the layer stack). A
   * petless sync leaves no duplicate or stale follower behind. */
  private async buildPetFollower(token: number): Promise<void> {
    const key = (this.session.importedProfile as { selectedPet?: string | null } | null)?.selectedPet
    const keys = await loadCompanion(this, key, 'pet')
    if (token !== this.avatarBuildToken) return
    if (!keys || keys.length === 0) return // unknown/empty keys: no invented visuals
    this.clearPet()
    this.petSprite = this.add.image(this.player.x - 14, this.player.y - 2, keys[0])
      .setOrigin(0.5, 1)
      .setScale(WorldScene.AVATAR_DISPLAY / WorldScene.AVATAR_CANVAS) // companion grid matches the avatar grid
  }

  /** Mount riding: outdoor toggle; the village is a no-ride zone. Riding is
   * only granted when BOTH mount layers (body + head) actually load — an
   * uncached mount never becomes an invisible speed boost. */
  private async toggleRide(): Promise<void> {
    const mountKey = (this.session.importedProfile as { selectedMount?: string | null } | null)?.selectedMount
    if (!mountKey) {
      bus.emit(EV.toast, { text: 'No mount chosen on Habitica — pick one there to ride here.' })
      return
    }
    if (this.riding) {
      this.riding = false
      void this.buildAvatarVisual()
      bus.emit(EV.toast, { text: 'You hop down.' })
      return
    }
    if (this.world.areaId === 'village') {
      bus.emit(EV.toast, { text: 'Orrin would never forgive hoofprints in the square. Ride outside the gate.' })
      return
    }
    const mountKeys = await loadCompanion(this, mountKey, 'mount')
    if (!mountKeys || mountKeys.length < 2) {
      bus.emit(EV.toast, { text: 'Your mount stayed home this time (its art isn\u2019t cached). On foot it is.' })
      return
    }
    this.riding = true
    void this.buildAvatarVisual()
    bus.emit(EV.toast, { text: 'You saddle up. Faster on the open road!' })
  }

  private onProfileChanged(): void {
    // A sync may have brought embers: ember-spot markers can change.
    this.refreshMarkers()
    this.riding = this.riding && this.world.areaId !== 'village'
    void this.buildAvatarVisual()
  }

  private updateAvatarVisual(time: number): void {
    if (this.avatarContainer) {
      const bob = Math.sin(time * 0.006) * 0.8
      this.avatarContainer.setPosition(this.player.x, this.player.y - 1 + bob)
      this.avatarContainer.depth = this.player.y + 1
    }
    if (this.petSprite) {
      const targetX = this.player.x - 14 * (this.player.flipX ? -1 : 1)
      const t = 0.08
      this.petSprite.x += (targetX - this.petSprite.x) * t
      this.petSprite.y += (this.player.y - 2 - this.petSprite.y) * t
      this.petSprite.setDepth(this.petSprite.y)
    }
    // Auto-dismount entering the village.
    if (this.riding && this.world.areaId === 'village') {
      this.riding = false
      void this.buildAvatarVisual()
      bus.emit(EV.toast, { text: 'You lead your mount through the gate on foot.' })
    }
  }

  private damageEnemy(enemy: Enemy, amount: number, fromX: number, crit = false): void {
    // A dazed beetle (charged into something) is wide open.
    if (enemy.type === 'beetle' && enemy.state === 'stunned') {
      amount *= ENEMY_TUNING.beetle.stunnedTakes
      crit = true
    }
    enemy.hp -= amount
    this.floatText(enemy.sprite.x, enemy.sprite.y - (enemy.type === 'guardian' ? 26 : 16), crit ? `${Math.round(amount)}!` : `${Math.round(amount)}`, crit ? '#ffd24a' : '#fffbef', crit)
    sfx(crit ? 'crit' : 'hit')
    this.hitStop(crit ? 70 : 45)
    enemy.sprite.setTint(0xffe0d0)
    this.time.delayedCall(90, () => {
      if (!enemy.dead && enemy.sprite.active) {
        // A hit during the windup must not erase the telegraph tell for the
        // rest of the telegraph: re-apply it instead of clearing.
        if (enemy.type === 'guardian' && enemy.state === 'telegraph') enemy.sprite.setTint(0xd0e8ff)
        else enemy.sprite.clearTint()
      }
    })
    this.knockEnemy(enemy, fromX)
    if (enemy.hp <= 0) {
      this.killEnemy(enemy)
      return
    }
    if (enemy.type === 'guardian') this.flashGuardianHurt(enemy)
  }

  /**
   * Shove an enemy away from the hit through physics (walls still apply).
   * Hopping slimes are knocked out of their hop; a charging beetle is too
   * heavy to stop, and the warden only rocks back between lunges.
   */
  private knockEnemy(enemy: Enemy, fromX: number): void {
    if (enemy.type === 'beetle' && enemy.state === 'lunge') return
    if (enemy.type === 'guardian' && enemy.state === 'lunge') return
    const dir = new Phaser.Math.Vector2(enemy.sprite.x - fromX, (enemy.sprite.y - this.player.y) * 0.5)
    if (dir.lengthSq() < 0.01) dir.set(this.facing.x, this.facing.y)
    dir.normalize()
    const speed = enemy.type === 'guardian' ? KNOCK.guardian : KNOCK.small
    enemy.knockX = dir.x * speed
    enemy.knockY = dir.y * speed
    enemy.knockTimer = KNOCK.time
    if (enemy.type === 'wisp' && (enemy.state === 'telegraph' || enemy.state === 'lunge')) {
      // Interrupted: the windup is lost, so a quick hit is a real answer.
      enemy.state = 'recover'
      enemy.stateTimer = ENEMY_TUNING.wisp.recover
      enemy.sprite.clearTint()
    }
    if (enemy.type !== 'guardian') this.setEnemyPose(enemy, 'hurt')
    enemy.hurtTimer = 0.22
  }

  /** Small-enemy pose: the idle loop, or a held atlas frame. */
  private setEnemyPose(enemy: Enemy, pose: 'idle' | 'windup' | 'squash' | 'hurt'): void {
    if (enemy.type === 'guardian' || enemy.dead || !enemy.sprite.active) return
    if (pose === 'idle') {
      const anim = `${enemy.art}-idle`
      if (enemy.sprite.anims.currentAnim?.key !== anim || !enemy.sprite.anims.isPlaying) {
        if (this.anims.exists(anim)) enemy.sprite.play(anim)
      }
      return
    }
    enemy.sprite.anims.stop()
    enemy.sprite.setFrame(`${enemy.art}-${pose}`)
  }

  /**
   * Freeze the attack's aim at the player's position now, with a white flash
   * so the lock reads. Returns true the first frame it locks.
   */
  private lockAim(enemy: Enemy, lockAt: number, speed: number, px: number, py: number): boolean {
    if (enemy.stateTimer > lockAt || enemy.lungeX !== 0 || enemy.lungeY !== 0) return false
    const dir = new Phaser.Math.Vector2(px - enemy.sprite.x, py - enemy.sprite.y)
    if (dir.lengthSq() < 0.01) dir.set(enemy.sprite.flipX ? -1 : 1, 0)
    dir.normalize()
    enemy.lungeX = dir.x * speed
    enemy.lungeY = dir.y * speed
    enemy.sprite.setTintFill(0xffffff)
    this.time.delayedCall(70, () => {
      if (!enemy.dead && enemy.sprite.active && enemy.state === 'telegraph') enemy.sprite.setTint(0xffd0c0)
    })
    return true
  }

  /** The tell before a real attack: windup pose, a "!" and a rising tone. */
  private telegraph(enemy: Enemy, seconds: number): void {
    this.setEnemyPose(enemy, 'windup')
    enemy.sprite.setTint(0xffd0c0)
    sfx('windup')
    const bang = this.add.text(enemy.sprite.x, enemy.sprite.y - (enemy.type === 'beetle' ? 18 : 20), '!', {
      fontFamily: '"Pixelify Sans", monospace',
      fontSize: '14px',
      color: '#ffcf4a',
      stroke: '#3a1a10',
      strokeThickness: 4,
      resolution: 3
    }).setOrigin(0.5, 1).setDepth(6100)
    this.tweens.add({ targets: bang, y: bang.y - 4, scale: { from: 0.4, to: 1 }, duration: 140, ease: 'Back.easeOut' })
    this.time.delayedCall(seconds * 1000, () => bang.destroy())
    if (enemy.type === 'beetle' && !this.reducedMotion) {
      // Pawing the ground: a small shiver while it winds up.
      // Rocks on its feet (angle only: position stays owned by physics).
      this.tweens.add({ targets: enemy.sprite, angle: 5, duration: 45, yoyo: true, repeat: Math.floor(seconds * 1000 / 90) - 1, onComplete: () => enemy.sprite.setAngle(0) })
    }
  }

  // ------------------------------------------------------------- combat

  private handleAction(): void {
    if (uiBlocked() || this.cinematic || this.transitioning || performance.now() < uiState.blockedUntil) return
    if (this.currentTarget) {
      // Free village activities stay available at zero HP: talking is fine.
      this.openInteraction(this.currentTarget)
      return
    }
    if (this.session.zeroHpLocked) return // too injured to fight; no auto revival
    this.tryAttack()
  }

  private kit(): CombatKit {
    return withCharm(getCombatKit(this.session.importedProfile), this.session.state.inventory)
  }

  private tryAttack(): void {
    const kit = this.kit()
    if (this.attackCooldown > 0 || this.transitioning) return
    this.attackCooldown = kit.cooldown
    const dir = this.facing.clone().normalize()
    // Mage basic is a ranged bolt (the classless starter keeps its melee
    // slash); every other class strikes in melee reach.
    if (kit.class === 'mage') {
      this.spawnBolt(this.player.x + dir.x * 10, this.player.y - 7, dir, kit.meleeDamage)
      return
    }
    const sx = this.player.x + dir.x * 14
    const sy = this.player.y - 7 + dir.y * 12
    // The aliased slash is a directional crescent (native art faces right):
    // rotate it to the facing like the other FX, instead of the old
    // flip/45-degree heuristic that turned cardinal attacks into diagonals.
    sfx('swing')
    const slash = this.add.image(sx, sy, 'slash')
      .setDepth(this.player.y + 2)
      .setRotation(Math.atan2(dir.y, dir.x))
    this.tweens.add({ targets: slash, alpha: 0, duration: 150, onComplete: () => slash.destroy() })
    this.time.delayedCall(60, () => {
      for (const enemy of [...this.enemies]) {
        const dx = enemy.sprite.x - sx
        const dy = enemy.sprite.y - 6 - sy
        if (dx * dx + dy * dy < ATTACK_RANGE * ATTACK_RANGE) {
          const crit = Math.random() < kit.critChance
          const dmg = crit ? kit.meleeDamage * 2 : kit.meleeDamage
          if (crit) this.sparkBurst(enemy.sprite.x, enemy.sprite.y - 8, 8)
          this.damageEnemy(enemy, dmg, this.player.x, crit)
        }
      }
    })
  }

  private handleCast(): void {
    const kit = this.kit()
    if (uiBlocked() || performance.now() < uiState.blockedUntil || this.transitioning || this.cinematic) return
    if (this.session.zeroHpLocked) return
    if (this.castCooldown > 0 || this.attackCooldown > kit.cooldown) {
      bus.emit(EV.ability, { status: 'cooldown' } satisfies AbilityPayload)
      return
    }
    if (this.session.state.mana < kit.manaCost) {
      sfx('fizzle')
      this.floatText(this.player.x, this.player.y - 24, 'no mana', '#9cc4ff', false)
      bus.emit(EV.ability, { status: 'no-mana' } satisfies AbilityPayload)
      return
    }
    this.castCooldown = 1.0
    sfx('cast')
    bus.emit(EV.ability, { status: 'cast', cooldown: this.castCooldown } satisfies AbilityPayload)
    this.session.setVitals(this.session.state.hp, this.session.state.mana - kit.manaCost)
    const dir = this.facing.clone().normalize()
    switch (kit.signature) {
      case 'bolt': {
        this.spawnBolt(this.player.x + dir.x * 10, this.player.y - 7, dir, kit.signatureDamage)
        break
      }
      case 'cleave': {
        // Wide sweeping arc in front: hits every creature in reach. Per the
        // pack README the delivered cleave canvas is centered on the
        // ATTACKER (visual only); the hit check keeps its own attacker-front
        // cast point, reach, and timing — unchanged.
        const cx = this.player.x + dir.x * 22
        const cy = this.player.y - 6 + dir.y * 18
        if (!this.playEffect('effect-cleave', 'cleave-0', this.player.x, this.player.y - 8, this.player.y + 2, Math.atan2(dir.y, dir.x))) {
          const sweep = this.add.image(cx, cy, 'slash').setScale(2.2).setDepth(this.player.y + 2)
          this.tweens.add({ targets: sweep, alpha: 0, scale: 3, duration: 220, onComplete: () => sweep.destroy() })
        }
        this.cameras.main.shake(90, 0.004)
        this.time.delayedCall(50, () => {
          for (const enemy of [...this.enemies]) {
            const dx = enemy.sprite.x - cx
            const dy = enemy.sprite.y - 6 - cy
            if (dx * dx + dy * dy < 40 * 40) {
              this.damageEnemy(enemy, kit.signatureDamage, this.player.x)
            }
          }
        })
        break
      }
      case 'dash': {
        // Snapstrike: physics-driven dash (colliders apply — never through
        // walls), striking everything along the path at the end. The dash
        // window (dashTime) keeps ordinary movement from cancelling velocity.
        const start = this.player.x
        this.dashTime = 0.15
        this.player.setVelocity(dir.x * 430, dir.y * 430)
        this.time.delayedCall(150, () => {
          this.player.setVelocity(0, 0)
          const travelled = Math.abs(this.player.x - start) > 4
          const sx = this.player.x + dir.x * 10
          const sy = this.player.y - 6
          // Delivered dash-trail animation at the emission point, oriented
          // along the dash (the art trails left behind rightward motion).
          if (!this.playEffect('effect-dash-trail', 'dash-trail-0', sx, sy, this.player.y + 2, Math.atan2(dir.y, dir.x))) {
            const trail = this.add.image(sx, sy, 'slash').setAlpha(0.7).setDepth(this.player.y + 2)
            this.tweens.add({ targets: trail, alpha: 0, duration: 140, onComplete: () => trail.destroy() })
          }
          this.time.delayedCall(30, () => {
            for (const enemy of [...this.enemies]) {
              const dx = enemy.sprite.x - this.player.x
              const dy = enemy.sprite.y - 6 - (this.player.y - 6)
              const reach = travelled ? 34 : 22
              if (dx * dx + dy * dy < reach * reach) {
                const crit = Math.random() < kit.critChance * 2
                this.damageEnemy(enemy, crit ? kit.signatureDamage * 2 : kit.signatureDamage, this.player.x - dir.x * 10, crit)
              }
            }
          })
        })
        break
      }
      case 'heal': {
        // Soothing Snap: damaging pulse around the hero + local self-heal.
        // The delivered pulse animation is centered on the caster; the glow
        // fallback stays for the no-pack path.
        if (!this.playEffect('effect-healing-pulse', 'healing-pulse-0', this.player.x, this.player.y - 8, this.player.y + 2)) {
          const pulse = this.add.image(this.player.x, this.player.y - 8, 'glow')
            .setBlendMode(Phaser.BlendModes.ADD)
            .setScale(0.4)
            .setDepth(this.player.y + 2)
          this.tweens.add({ targets: pulse, scale: 1.6, alpha: 0, duration: 320, onComplete: () => pulse.destroy() })
        }
        for (const enemy of [...this.enemies]) {
          const dx = enemy.sprite.x - this.player.x
          const dy = enemy.sprite.y - 6 - (this.player.y - 8)
          if (dx * dx + dy * dy < 70 * 70) {
            this.damageEnemy(enemy, kit.signatureDamage, this.player.x)
          }
        }
        if (kit.healAmount > 0) {
          this.sparkBurst(this.player.x, this.player.y - 12, 6)
          this.session.setVitals(this.session.state.hp + kit.healAmount, this.session.state.mana)
        }
        break
      }
    }
  }

  private sparkBurst(x: number, y: number, count: number): void {
    const particles = this.add.particles(x, y, 'spark', {
      speed: { min: 30, max: 90 },
      lifespan: 380,
      scale: { start: 1, end: 0 },
      emitting: false
    })
    particles.explode(count)
    this.time.delayedCall(620, () => particles.destroy())
  }

  /** True when the delivered runtime-pass effect animation is available. */
  private effectReady(texture: string, anim: string): boolean {
    return this.textures.exists(texture) && this.anims.exists(anim)
  }

  /**
   * One-shot delivered effect: plays its manifest animation centered on
   * (x, y), rotated to the given angle (native art faces right), and destroys
   * the sprite when done. Purely cosmetic — hit timing, reach, and radii stay
   * code-authored and are never inferred from the effect art.
   * Returns false when the pack is absent so callers can fall back.
   */
  private playEffect(anim: string, texture: string, x: number, y: number, depth: number, angle?: number): boolean {
    if (!this.effectReady(texture, anim)) return false
    const fx = this.add.sprite(x, y, texture).setDepth(depth)
    fx.play(anim)
    if (angle !== undefined) fx.setRotation(angle)
    fx.once('animationcomplete', () => fx.destroy())
    return true
  }

  /**
   * Mage bolt (basic and signature share the projectile): delivered 8x8
   * flicker loop while in flight, rotated to the travel direction, destroyed
   * on hit/expiry by updateBolts. Falls back to the static aliased `bolt`.
   */
  private spawnBolt(x: number, y: number, dir: Phaser.Math.Vector2, damage: number): void {
    const animated = this.effectReady('magic-bolt-0', 'effect-magic-bolt')
    const bolt = this.bolts.create(x, y, animated ? 'magic-bolt-0' : 'bolt') as Phaser.Physics.Arcade.Sprite
    bolt.setDepth(y + 1)
    if (animated) bolt.play('effect-magic-bolt')
    if (dir.x !== 0 || dir.y !== 0) bolt.setRotation(Math.atan2(dir.y, dir.x))
    bolt.setVelocity(dir.x * 240, dir.y * 240)
    bolt.setData('damage', damage)
    bolt.setData('life', 1.2)
  }

  private damagePlayer(amount: number, fromX: number, fromY = this.player.y): void {
    if (this.iframes > 0 || this.transitioning) return
    const state = this.session.state
    // kit.mitigation is a FRACTION (0..0.45, shared combat contract), not a
    // flat subtraction: damage scales down multiplicatively, always >= 1.
    const mitigated = Math.max(1, Math.round(amount * (1 - this.kit().mitigation)))
    this.session.setVitals(state.hp - mitigated, state.mana)
    this.iframes = CONTACT_IFRAMES
    this.player.setTint(0xff9080)
    this.time.delayedCall(160, () => this.player.clearTint())
    this.floatText(this.player.x, this.player.y - 24, `-${mitigated}`, '#ff8a70', false)
    sfx('hurt')
    if (!this.reducedMotion) this.cameras.main.shake(120, 0.006)
    // A brief blink while invulnerable shows the grace window. The imported
    // avatar container is the visible body when present (player alpha 0).
    const body = this.avatarContainer ?? this.player
    if (!this.reducedMotion) {
      this.tweens.add({
        targets: body,
        alpha: { from: 0.35, to: 1 },
        duration: 110,
        repeat: 3,
        yoyo: true,
        onComplete: () => body.setAlpha(1)
      })
    }
    // Knocked back through physics (never into a wall); the dash window
    // stops ordinary movement from cancelling the shove.
    const away = new Phaser.Math.Vector2(this.player.x - fromX, this.player.y - fromY)
    if (away.lengthSq() < 0.01) away.set(-this.facing.x, -this.facing.y)
    away.normalize()
    this.player.setVelocity(away.x * KNOCK.player, away.y * KNOCK.player)
    this.dashTime = Math.max(this.dashTime, KNOCK.time)
    if (this.session.state.hp <= 0) this.defeatRecovery()
  }

  /** Defeat: a short collapse beat, then wake at the village well. */
  private defeatRecovery(): void {
    this.transitioning = true
    // Tell the UI first: it holds the bars while the hero collapses, then
    // shows the recovered vitals once the screen is dark.
    bus.emit(EV.defeat, { phase: 'falling' })
    this.session.defeat()
    sfx('defeat')
    this.player.setVelocity(0, 0)
    this.tweens.add({ targets: this.avatarContainer ?? this.player, scaleY: (this.avatarContainer ?? this.player).scaleY * 0.6, duration: 380, ease: 'Quad.easeIn' })
    this.player.setTint(0x8a7a9a)
    // force: a fade-in still running (scene just started) must not swallow
    // this fade, or 'camerafadeoutcomplete' never fires and we soft-lock.
    this.cameras.main.fade(1100, 12, 12, 20, true)
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.scene.restart({ fromDefeat: true })
    })
  }

  /** Damage numbers and small callouts, crisp at any zoom. */
  private floatText(x: number, y: number, text: string, color: string, big: boolean): void {
    const t = this.add.text(Math.round(x), Math.round(y), text, {
      fontFamily: '"Pixelify Sans", monospace',
      fontSize: big ? '10px' : '8px',
      color,
      stroke: '#2b1d1a',
      strokeThickness: 3,
      resolution: 8
    }).setOrigin(0.5, 1).setDepth(7000)
    if (this.reducedMotion) {
      this.time.delayedCall(550, () => t.destroy())
      return
    }
    t.setScale(big ? 1.5 : 1.2)
    this.tweens.add({ targets: t, scale: 1, duration: 120, ease: 'Back.easeOut' })
    this.tweens.add({ targets: t, y: y - 14, alpha: 0, delay: 220, duration: 520, ease: 'Quad.easeOut', onComplete: () => t.destroy() })
  }

  /** A few frames of freeze on impact so hits land with weight. */
  private hitStop(ms: number): void {
    if (this.reducedMotion || this.physics.world.isPaused) return
    this.physics.world.pause()
    this.time.delayedCall(ms, () => this.physics.world.resume())
  }

  // ------------------------------------------------------------- interaction

  private openInteraction(target: Interactable): void {
    let payload: Dialogue
    try {
      payload = this.isEmberSpot(target.id)
        ? emberDialogue(target.id, this.session.state, { connected: this.session.vitalsSource === 'imported' })
        : dialogueFor(target.id, this.session.questStage)
    } catch (err) {
      console.warn('[fingersnap] no dialogue available for', target.id, err)
      return
    }
    uiState.dialogueOpen = true
    heardAt.add(`${target.id}@${this.session.questStage}`)
    this.refreshMarkers()
    sfx('open')
    bus.emit(EV.dialogue, {
      id: target.id,
      speaker: payload.speaker,
      lines: payload.lines,
      event: payload.event,
      choices: payload.choices
    })
  }

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
    this.refreshLanternVisuals()
    if (event === 'find-clue' && this.world.areaId === 'ruin') this.spawnGuardian(true)
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
      this.player.setTint(0xffe2a8)
      this.time.delayedCall(260, () => this.player.clearTint())
      this.sparkBurst(this.player.x, this.player.y - 10, 10)
      this.floatText(this.player.x, this.player.y - 24, 'Rested', '#ffd27a', false)
      bus.emit(EV.toast, { text: 'Warm and rested. Health and mana restored.', icon: 'ember' })
    } else if (spend.kind === 'road-lantern') {
      const lp = this.lightProps.find((l) => l.id === spend.id)
      this.refreshLanternVisuals()
      if (lp) {
        const bloom = this.add.image(lp.gx, lp.gy, 'glow').setBlendMode(Phaser.BlendModes.ADD).setDepth(4002).setScale(0.2)
        this.tweens.add({ targets: bloom, scale: 2.4, alpha: 0, duration: 900, ease: 'Quad.easeOut', onComplete: () => bloom.destroy() })
        this.sparkBurst(lp.gx, lp.gy, 10)
      }
      bus.emit(EV.toast, { text: 'The road lantern is lit. Rest in its light to recover.', icon: 'lantern' })
    } else {
      const spot = this.world.emberSpots.find((e) => e.id === 'chest')
      if (spot) this.sparkBurst(spot.tx * TILE + 8, spot.ty * TILE + 6, 14)
      bus.emit(EV.toast, { text: `Found: ${itemInfo(CHARM_ITEM).name}. Your strikes find the gaps more often.`, icon: 'ember' })
    }
    this.refreshMarkers()
    this.lastPrompt = null
  }

  /** Standing in a lit road lantern's light (and out of a fight) mends you. */
  private lanternRestRate(): number {
    for (const lp of this.lightProps) {
      if (!(ROAD_LANTERNS as readonly string[]).includes(lp.id) || !isLit(this.session.state, lp.id as RoadLanternId)) continue
      if (Math.hypot(this.player.x - lp.gx, this.player.y - (lp.gy + 18)) > 44) continue
      const threatened = this.enemies.some((e) => !e.dead && Math.hypot(e.sprite.x - this.player.x, e.sprite.y - this.player.y) < 90)
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
      this.refreshLanternVisuals()
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
      this.sparkBurst(target.gx, target.gy, 16)
      finish()
    })
    this.time.delayedCall(panMs + 2300, () => {
      cam.pan(this.player.x, this.player.y, panMs, 'Sine.easeInOut')
      // Return to the zoom for the CURRENT viewport (it may have resized).
      if (!this.reducedMotion) cam.zoomTo(this.zoomFor(this.scale.height), panMs, 'Sine.easeInOut')
      this.time.delayedCall(panMs + 50, () => {
        cam.startFollow(this.player, true, 0.12, 0.12)
        this.cinematic = false
        bus.emit(EV.cinematic, { active: false })
      })
    })
  }

  /**
   * Lit-lantern visuals depend on quest progress. The atlas props stay in
   * place; lighting adds an additive glow anchored at the lamp.
   */
  private refreshLanternVisuals(): void {
    const stage = this.session.questStage
    if (this.lightProps.length === 0) return
    const shrineLit = stage === 'lantern-lit' || stage === 'complete'
    const villageLit = stage === 'complete'
    for (const lp of this.lightProps) {
      const isShrine = lp.id === 'shrine'
      const shouldGlow = isShrine
        ? shrineLit
        : lp.id === 'village'
          ? villageLit
          : (ROAD_LANTERNS as readonly string[]).includes(lp.id) && isLit(this.session.state, lp.id as RoadLanternId)
      // The delivered art is drawn lit; dim it until the flame is relit so
      // lighting it is a visible change, not just an added halo.
      if (shouldGlow) lp.sprite.clearTint()
      else lp.sprite.setTint(0x8a849c)
      if (shouldGlow && !lp.glow) {
        lp.glow = this.add.image(lp.gx, lp.gy, 'glow')
          .setBlendMode(Phaser.BlendModes.ADD)
          .setScale(isShrine ? 1.4 : 1.1)
          .setDepth(4001)
        this.tweens.add({
          targets: lp.glow,
          alpha: 0.72,
          duration: isShrine ? 900 : 1100,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut'
        })
      }
    }
  }

  // ------------------------------------------------------------- transitions

  private checkExits(): void {
    if (this.transitioning) return
    // Zero-HP gates expeditions only from the village; a legacy zero-HP save
    // found outside may travel home freely (nothing heals en route).
    if (this.session.zeroHpLocked && this.world.areaId === 'village') return
    const tx = Math.floor(this.player.x / TILE)
    const ty = Math.floor(this.player.y / TILE)
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

  // ------------------------------------------------------------- zoom

  private zoomFor(h: number): number {
    return Phaser.Math.Clamp(Math.round((h / 280) * 2) / 2, 1.5, 5)
  }

  private applyZoom(_w: number, h: number): void {
    this.cameras.main.setZoom(this.zoomFor(h))
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
    this.attackCooldown = Math.max(0, this.attackCooldown - dt)
    this.castCooldown = Math.max(0, this.castCooldown - dt)
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt)
    this.iframes = Math.max(0, this.iframes - dt)
    this.session.tickPlaySeconds(dt)

    // While a sync persistence owns the save file the world freezes its
    // resource/combat mutations: the committed snapshot must never revert a
    // mid-flight enemy hit, regen tick, or position write. The panel closes
    // normally; this gate only covers the brief disk write.
    if (uiBlocked() || this.transitioning || this.cinematic || this.session.persistenceInFlight) {
      this.player.setVelocity(0, 0)
      this.player.anims.stop()
      this.keyHint?.setVisible(false)
      this.updateEnemyBars()
      this.updateOccluders(dt)
      return
    }

    this.movePlayer(dt)
    this.updateEnemies(dt)
    this.updateBolts(dt)
    this.updateDiscoveries()
    this.checkExits()
    this.updatePrompt()
    this.updateEnemyBars()
    this.updateOccluders(dt)
    this.updateDepth()
    this.updateAvatarVisual(time)

    this.positionTimer += dt
    if (this.positionTimer > 1) {
      this.positionTimer = 0
      this.session.state.position = { x: Math.round(this.player.x), y: Math.round(this.player.y) }
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
    if (this.worldLive()) this.handleCast()
  }

  private onRideKey(): void {
    if (this.worldLive()) void this.toggleRide()
  }

  private onDodgeKey(): void {
    if (this.worldLive()) this.tryDodge()
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

  /**
   * Dodge roll: a quick burst the way you're heading (or facing), with a
   * short window of invulnerability. Physics-driven, so walls still stop it.
   */
  private tryDodge(towards?: Phaser.Math.Vector2): void {
    if (uiBlocked() || this.cinematic || this.transitioning || this.session.persistenceInFlight) return
    if (this.dodgeCooldown > 0 || this.dashTime > 0) return
    const dir = towards ?? this.inputVector()
    if (dir.lengthSq() < 0.01) dir.set(this.facing.x, this.facing.y)
    dir.normalize()
    const speed = this.riding ? DODGE.speed * 1.2 : DODGE.speed
    this.player.setVelocity(dir.x * speed, dir.y * speed)
    this.dashTime = DODGE.time
    this.iframes = Math.max(this.iframes, DODGE.iframes)
    this.dodgeCooldown = DODGE.cooldown
    sfx('roll')
    bus.emit(EV.rolled, { cooldown: DODGE.cooldown })
    const body = this.avatarContainer ?? this.player
    if (!this.reducedMotion) {
      const sy = body.scaleY
      this.tweens.add({ targets: body, scaleY: sy * 0.75, duration: DODGE.time * 500, yoyo: true, onComplete: () => body.setScale(body.scaleX, sy) })
      body.setAlpha(0.65)
      this.time.delayedCall(DODGE.iframes * 1000, () => body.setAlpha(1))
    }
    // A puff of dust where you left.
    const dust = this.add.particles(this.player.x, this.player.y - 2, 'spark', {
      speed: { min: 10, max: 35 },
      lifespan: 300,
      quantity: 5,
      scale: { start: 0.7, end: 0 },
      tint: 0xc8b28a,
      emitting: false
    }).setDepth(this.player.y - 1)
    dust.explode(5)
    this.time.delayedCall(400, () => dust.destroy())
  }

  private movePlayer(dt: number): void {
    let dx = 0
    let dy = 0
    if (this.cursors.left.isDown || this.wasd.A.isDown) dx -= 1
    if (this.cursors.right.isDown || this.wasd.D.isDown) dx += 1
    if (this.cursors.up.isDown || this.wasd.W.isDown) dy -= 1
    if (this.cursors.down.isDown || this.wasd.S.isDown) dy += 1
    dx += touchVec.x
    dy += touchVec.y
    const len = Math.hypot(dx, dy)
    if (len > 1) {
      dx /= len
      dy /= len
    }
    // During the shadowstep dash window the dash velocity owns the body —
    // ordinary movement (including the idle 0,0) must not cancel it.
    this.dashTime = Math.max(0, this.dashTime - dt)
    if (this.dashTime <= 0) {
      this.player.setVelocity(dx * (this.riding ? 155 : PLAYER_SPEED), dy * (this.riding ? 155 : PLAYER_SPEED))
    }
    if (len > 0.1) {
      this.facing.set(dx, dy).normalize()
      // Delivered 4-direction walk animations; keep facing when idle.
      const anim = Math.abs(dx) >= Math.abs(dy)
        ? dx < 0 ? 'demo-walk-left' : 'demo-walk-right'
        : dy < 0 ? 'demo-walk-up' : 'demo-walk-down'
      if (this.player.anims.currentAnim?.key !== anim) this.player.play(anim, true)
    } else {
      this.player.anims.stop()
    }
    // Local stamina + rest regeneration, by provenance:
    // - Mana is local and bounded: it returns slowly everywhere and is never
    //   reset by sync or reload (explicitly described in the panel).
    // - HP regen only when the shared policy allows it (demo vitals, in the
    //   village). Imported vitals get NO passive refill anywhere.
    const state = this.session.state
    // Lit road lanterns are ember-bought rest spots: mana for everyone, HP
    // for demo heroes (still local only — Habitica is never touched).
    const rest = this.lanternRestRate()
    const mana = Math.min(state.maxMana, state.mana + (5 + 6 * rest) * dt)
    let hp = state.hp
    // HP only for demo vitals: imported health mirrors Habitica (approved
    // policy: no passive HP refill for imported heroes, lanterns included).
    if (rest > 0 && state.hp > 0 && passiveRegenAllowed(this.session.vitalsSource)) hp = Math.min(state.maxHp, hp + 2 * dt)
    if (
      passiveRegenAllowed(this.session.vitalsSource) &&
      this.world.areaId === 'village' &&
      state.hp > 0
    ) {
      hp = Math.min(state.maxHp, state.hp + 1.2 * dt)
    }
    this.session.setVitals(hp, mana)
  }

  private updateEnemies(dt: number): void {
    const px = this.player.x
    const py = this.player.y - 8
    for (const enemy of [...this.enemies]) {
      if (enemy.dead) continue
      const ex = enemy.sprite.x
      const ey = enemy.sprite.y - 6
      const dist = Math.hypot(px - ex, py - ey)
      const body = enemy.sprite.body as Phaser.Physics.Arcade.Body
      if (enemy.knockTimer > 0) {
        // Shoved: physics owns the body for a beat, the AI waits.
        enemy.knockTimer -= dt
        body.setVelocity(enemy.knockX, enemy.knockY)
        enemy.stateTimer -= dt
        if (enemy.knockTimer <= 0) {
          body.setVelocity(0, 0)
          if (enemy.type !== 'guardian' && enemy.state !== 'telegraph' && enemy.state !== 'stunned') this.setEnemyPose(enemy, 'idle')
        }
      } else if (enemy.type === 'wisp') {
        this.updateHopper(enemy, dt, dist, px, py)
      } else if (enemy.type === 'beetle') {
        this.updateBeetle(enemy, dt, dist, px, py)
      } else {
        this.updateGuardian(enemy, dt, dist, px, py)
      }
      // Contact damage: attacks hit hard; a bump only stings.
      let reach = 12
      let dmg: number = ENEMY_TUNING[enemy.type].contact
      if (enemy.type === 'guardian' && enemy.state === 'lunge') {
        reach = 18
        dmg = ENEMY_TUNING.guardian.lunge
      } else if (enemy.type === 'wisp' && enemy.state === 'lunge') {
        reach = 14
        dmg = ENEMY_TUNING.wisp.hop
      } else if (enemy.type === 'beetle' && enemy.state === 'lunge') {
        reach = 15
        dmg = ENEMY_TUNING.beetle.charge
      } else if (enemy.type === 'beetle' && enemy.state === 'stunned') {
        dmg = 0
      }
      if (dmg > 0 && dist < reach) this.damagePlayer(dmg, ex, enemy.sprite.y)
      enemy.sprite.setDepth(enemy.sprite.y)
    }
  }

  /** Idle wandering near home, used by small enemies out of aggro range. */
  private wander(enemy: Enemy, dt: number, speed: number): void {
    const body = enemy.sprite.body as Phaser.Physics.Arcade.Body
    enemy.wanderTimer -= dt
    if (enemy.wanderTimer <= 0) {
      enemy.wanderTimer = 1 + Math.random() * 1.6
      const angle = Math.random() * Math.PI * 2
      enemy.dirX = Math.cos(angle)
      enemy.dirY = Math.sin(angle)
    }
    const blocked = body.blocked.left || body.blocked.right || body.blocked.up || body.blocked.down
    const home = new Phaser.Math.Vector2(enemy.homeX - enemy.sprite.x, enemy.homeY - enemy.sprite.y)
    if (blocked && enemy.detourTimer <= 0) {
      // Walking into a tree (now that enemies collide): slide sideways for a
      // moment instead of pushing into it forever.
      const side = home.lengthSq() > 0.01 ? home.clone().normalize() : new Phaser.Math.Vector2(enemy.dirX, enemy.dirY)
      const sign = Math.random() < 0.5 ? 1 : -1
      enemy.dirX = -side.y * sign
      enemy.dirY = side.x * sign
      enemy.detourTimer = 0.6
    }
    enemy.detourTimer = Math.max(0, enemy.detourTimer - dt)
    body.setVelocity(enemy.dirX * speed, enemy.dirY * speed)
    if (home.length() > 90 && enemy.detourTimer <= 0) body.setVelocity(home.x * 0.5, home.y * 0.5)
    if (Math.abs(enemy.dirX) > 0.2) enemy.sprite.setFlipX(enemy.dirX < 0)
  }

  /**
   * Slimes and mushrooms: shuffle closer, then a telegraphed hop at where
   * you stood when the windup ended. Step aside (or roll) and it lands short.
   */
  private updateHopper(enemy: Enemy, dt: number, dist: number, px: number, py: number): void {
    const t = ENEMY_TUNING.wisp
    const body = enemy.sprite.body as Phaser.Physics.Arcade.Body
    enemy.attackTimer -= dt
    enemy.stateTimer -= dt
    switch (enemy.state) {
      case 'chase': {
        if (dist >= t.aggro) {
          this.wander(enemy, dt, 26)
          break
        }
        const dir = new Phaser.Math.Vector2(px - enemy.sprite.x, py - enemy.sprite.y).normalize()
        if (dist > t.hopRange * 0.7) body.setVelocity(dir.x * t.chase, dir.y * t.chase)
        else body.setVelocity(0, 0)
        if (Math.abs(dir.x) > 0.2) enemy.sprite.setFlipX(dir.x < 0)
        if (enemy.attackTimer <= 0 && dist < t.hopRange) {
          enemy.state = 'telegraph'
          enemy.stateTimer = t.windup
          enemy.lungeX = 0
          enemy.lungeY = 0
          body.setVelocity(0, 0)
          this.telegraph(enemy, t.windup)
        }
        break
      }
      case 'telegraph': {
        body.setVelocity(0, 0)
        this.lockAim(enemy, t.lock, t.hopSpeed, px, py)
        if (enemy.stateTimer <= 0) {
          // A shove can skip the lock frame; never launch without an aim.
          this.lockAim(enemy, Infinity, t.hopSpeed, px, py)
          enemy.state = 'lunge'
          enemy.stateTimer = t.hopTime
          enemy.sprite.clearTint()
          this.setEnemyPose(enemy, 'idle')
          if (!this.reducedMotion) {
            this.tweens.add({ targets: enemy.sprite, scaleY: enemy.sprite.scaleY * 1.25, scaleX: enemy.sprite.scaleX * 0.85, duration: t.hopTime * 500, yoyo: true })
          }
        }
        break
      }
      case 'lunge': {
        body.setVelocity(enemy.lungeX, enemy.lungeY)
        if (enemy.stateTimer <= 0) {
          enemy.state = 'recover'
          enemy.stateTimer = t.recover
          body.setVelocity(0, 0)
          this.setEnemyPose(enemy, 'squash')
        }
        break
      }
      default: {
        // recover: squashed and open for a moment after landing.
        body.setVelocity(0, 0)
        if (enemy.stateTimer <= 0) {
          enemy.state = 'chase'
          enemy.attackTimer = t.cooldown * (0.8 + Math.random() * 0.5)
          this.setEnemyPose(enemy, 'idle')
        }
      }
    }
  }

  /**
   * Beetles: plod toward you, paw the ground, then charge in a straight line
   * locked at the end of the windup. A charge that hits a tree or wall leaves
   * the beetle dazed and taking extra damage.
   */
  private updateBeetle(enemy: Enemy, dt: number, dist: number, px: number, py: number): void {
    const t = ENEMY_TUNING.beetle
    const body = enemy.sprite.body as Phaser.Physics.Arcade.Body
    enemy.attackTimer -= dt
    enemy.stateTimer -= dt
    switch (enemy.state) {
      case 'chase': {
        if (dist >= t.aggro) {
          this.wander(enemy, dt, 18)
          break
        }
        const dir = new Phaser.Math.Vector2(px - enemy.sprite.x, py - enemy.sprite.y).normalize()
        // Keep a charging distance: approach from afar, back off up close.
        if (dist > t.keepAway + 16) body.setVelocity(dir.x * t.walk, dir.y * t.walk)
        else if (dist < t.keepAway - 16) body.setVelocity(-dir.x * t.walk * 0.7, -dir.y * t.walk * 0.7)
        else body.setVelocity(0, 0)
        if (Math.abs(dir.x) > 0.2) enemy.sprite.setFlipX(dir.x < 0)
        if (enemy.attackTimer <= 0 && dist < t.chargeRange) {
          enemy.state = 'telegraph'
          enemy.stateTimer = t.windup
          enemy.lungeX = 0
          enemy.lungeY = 0
          body.setVelocity(0, 0)
          this.telegraph(enemy, t.windup)
        }
        break
      }
      case 'telegraph': {
        body.setVelocity(0, 0)
        if (enemy.lungeX === 0 && enemy.lungeY === 0) {
          const dir = new Phaser.Math.Vector2(px - enemy.sprite.x, py - enemy.sprite.y)
          if (Math.abs(dir.x) > 4) enemy.sprite.setFlipX(dir.x < 0)
        }
        this.lockAim(enemy, t.lock, t.chargeSpeed, px, py)
        if (enemy.stateTimer <= 0) {
          this.lockAim(enemy, Infinity, t.chargeSpeed, px, py)
          enemy.state = 'lunge'
          enemy.stateTimer = t.chargeTime
          enemy.sprite.clearTint()
          this.setEnemyPose(enemy, 'squash')
          sfx('swing')
        }
        break
      }
      case 'lunge': {
        body.setVelocity(enemy.lungeX, enemy.lungeY)
        const crashed = body.blocked.left || body.blocked.right || body.blocked.up || body.blocked.down
        if (crashed) {
          enemy.state = 'stunned'
          enemy.stateTimer = t.stun
          body.setVelocity(0, 0)
          this.setEnemyPose(enemy, 'hurt')
          sfx('hit')
          if (!this.reducedMotion) this.cameras.main.shake(90, 0.004)
          this.floatText(enemy.sprite.x, enemy.sprite.y - 18, 'Dazed!', '#ffe08a', false)
          this.sparkBurst(enemy.sprite.x, enemy.sprite.y - 8, 6)
        } else if (enemy.stateTimer <= 0) {
          enemy.state = 'recover'
          enemy.stateTimer = t.recover
          body.setVelocity(0, 0)
          this.setEnemyPose(enemy, 'idle')
        }
        break
      }
      case 'stunned': {
        body.setVelocity(0, 0)
        if (!this.reducedMotion) enemy.sprite.setAngle(Math.sin(enemy.stateTimer * 30) * 6)
        if (enemy.stateTimer <= 0) {
          enemy.sprite.setAngle(0)
          enemy.state = 'chase'
          enemy.attackTimer = t.cooldown
          this.setEnemyPose(enemy, 'idle')
        }
        break
      }
      default: {
        body.setVelocity(0, 0)
        if (enemy.stateTimer <= 0) {
          enemy.state = 'chase'
          enemy.attackTimer = t.cooldown * (0.8 + Math.random() * 0.4)
        }
      }
    }
  }

  private updateGuardian(enemy: Enemy, dt: number, dist: number, px: number, py: number): void {
    const body = enemy.sprite.body as Phaser.Physics.Arcade.Body
    enemy.attackTimer -= dt
    enemy.stateTimer -= dt
    enemy.hurtTimer = Math.max(0, enemy.hurtTimer - dt)
    const tune = ENEMY_TUNING.guardian
    switch (enemy.state) {
      case 'chase': {
        if (dist > 30) {
          const dir = new Phaser.Math.Vector2(px - enemy.sprite.x, py - enemy.sprite.y).normalize()
          body.setVelocity(dir.x * 50, dir.y * 50)
          enemy.sprite.setFlipX(dir.x < 0)
        } else {
          body.setVelocity(0, 0)
        }
        if (enemy.attackTimer <= 0 && dist < 150) {
          enemy.state = 'telegraph'
          enemy.lungeX = 0
          enemy.lungeY = 0
          enemy.stateTimer = tune.telegraph
          enemy.sprite.setTint(0xd0e8ff)
        }
        break
      }
      case 'telegraph': {
        body.setVelocity(0, 0)
        if (enemy.stateTimer <= 0) {
          const dir = new Phaser.Math.Vector2(px - enemy.sprite.x, py - enemy.sprite.y).normalize()
          enemy.lungeX = dir.x * tune.lungeSpeed
          enemy.lungeY = dir.y * tune.lungeSpeed
          enemy.state = 'lunge'
          enemy.stateTimer = 0.34
          enemy.sprite.clearTint()
          if (dir.x !== 0) enemy.sprite.setFlipX(dir.x < 0)
        }
        break
      }
      case 'lunge': {
        body.setVelocity(enemy.lungeX, enemy.lungeY)
        if (enemy.stateTimer <= 0) {
          enemy.state = 'recover'
          enemy.stateTimer = 0.55
          body.setVelocity(0, 0)
        }
        break
      }
      case 'recover': {
        body.setVelocity(0, 0)
        if (enemy.stateTimer <= 0) {
          enemy.state = 'chase'
          enemy.attackTimer = enemy.hp < enemy.maxHp / 2 ? tune.cooldown * 0.7 : tune.cooldown
        }
        break
      }
    }
    // Pose is selected ONCE, after the state update, so the hurt pose is
    // never stomped by per-frame state writes and the lunge pose survives
    // until the state actually changes.
    this.applyGuardianPose(enemy)
  }

  /**
   * Single guardian pose selector: hurt wins while its timer is running, then
   * the pose of the current state-machine state. setTexture fires only on
   * change, so the 24x24 texture, the (0.5, 1) foot anchor, and the authored
   * foot body stay stable across pose switches. Dead guardians are skipped —
   * killEnemy owns the defeat pose through the dissolve.
   */
  private applyGuardianPose(enemy: Enemy): void {
    if (enemy.dead || !enemy.sprite.active) return
    const pose = enemy.hurtTimer > 0
      ? this.guardianPoseTexture('hurt', 'guardian0')
      : this.guardianStateTexture(enemy)
    if (enemy.sprite.texture.key !== pose) enemy.sprite.setTexture(pose)
  }

  private updateBolts(dt: number): void {
    for (const boltObj of [...this.bolts.getChildren()] as Phaser.Physics.Arcade.Sprite[]) {
      const life = (boltObj.getData('life') as number) - dt
      boltObj.setData('life', life)
      let hit = false
      for (const enemy of [...this.enemies]) {
        const dx = enemy.sprite.x - boltObj.x
        const dy = enemy.sprite.y - 6 - boltObj.y
        if (dx * dx + dy * dy < 14 * 14) {
          this.damageEnemy(enemy, boltObj.getData('damage') as number, boltObj.x)
          hit = true
          break
        }
      }
      if (hit || life <= 0) boltObj.destroy()
    }
  }

  private updateDiscoveries(): void {
    for (const spot of this.world.discoverySpots) {
      const d = Math.hypot(this.player.x - (spot.tx * TILE + 8), this.player.y - 8 - (spot.ty * TILE + 8))
      if (d < 24) this.session.recordDiscovery(spot.id, spot.label)
    }
  }

  private updatePrompt(): void {
    // Nearest interactable within reach
    let best: Interactable | null = null
    let bestDist = 34
    for (const it of this.interactables) {
      const d = Math.hypot(this.player.x - it.x, this.player.y - 8 - (it.y - 8))
      if (d < bestDist) {
        bestDist = d
        best = it
      }
    }
    if (best !== this.currentTarget) {
      this.currentTarget = best
      this.refreshMarkers()
    }
    // Recomputed every frame: the wording follows quest progress even while
    // the hero stands still next to the target.
    const label = best ? this.promptLabel(best) : null
    if (label !== this.lastPrompt) {
      this.lastPrompt = label
      const payload: PromptPayload = { label }
      bus.emit(EV.prompt, payload)
    }
    if (this.keyHint) {
      if (best) {
        const bob = this.reducedMotion ? 0 : Math.round(Math.sin(this.time.now * 0.008) * 1)
        this.keyHint.setPosition(best.x, best.y - this.markerOffset(best.id) + bob).setVisible(true)
      } else {
        this.keyHint.setVisible(false)
      }
    }
  }

  private updateEnemyBars(): void {
    this.hpBars.clear()
    for (const enemy of this.enemies) {
      const boss = enemy.type === 'guardian'
      // Small creatures only show a bar once hurt — less clutter, and no
      // bars floating over foliage for enemies the player hasn't met.
      if (!boss && enemy.hp >= enemy.maxHp) continue
      const w = boss ? 30 : 16
      const h = boss ? 4 : 3
      const x = Math.round(enemy.sprite.x - w / 2)
      const y = Math.round(enemy.sprite.y - (boss ? 31 : 19))
      const pct = Math.max(0, enemy.hp / enemy.maxHp)
      this.hpBars.fillStyle(0x2b1d1a, 0.9)
      this.hpBars.fillRect(x - 1, y - 1, w + 2, h + 2)
      this.hpBars.fillStyle(0x5a3a32, 1)
      this.hpBars.fillRect(x, y, w, h)
      this.hpBars.fillStyle(boss ? 0xe8734f : 0xf2c14e, 1)
      this.hpBars.fillRect(x, y, Math.max(0, Math.round(pct * w)), h)
      this.hpBars.fillStyle(0xffffff, 0.35)
      this.hpBars.fillRect(x, y, Math.max(0, Math.round(pct * w)), 1)
    }
  }

  private updateDepth(): void {
    this.player.setDepth(this.player.y)
    this.heroShadow.setPosition(this.player.x, this.player.y - 1)
    for (const npc of this.npcs) npc.sprite.setDepth(npc.sprite.y + 1)
  }
}
