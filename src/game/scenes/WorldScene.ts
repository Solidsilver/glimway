import Phaser from 'phaser'
import type { AreaId, GameState, QuestEvent } from '../../lib/state'
import { dialogueFor } from '../../content/world'
import { placeFingersnapOccluder } from '../expansion'
import { bus, EV, type PromptPayload } from '../events'
import { touchVec, uiBlocked, uiState } from '../input'
import { TERRAIN, TILE } from '../textures'
import type { Session } from '../session'
import { buildArea, type EnemyType, type InteractId, type WorldData } from '../worlds'
import { getCombatKit, type CombatKit } from '../../lib/combat'
import { passiveRegenAllowed } from '../../lib/habitica/sync'
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
  state: 'chase' | 'telegraph' | 'lunge' | 'recover'
  stateTimer: number
  lungeX: number
  lungeY: number
  /** Remaining hurt-pose window (seconds); visual only. */
  hurtTimer: number
  dead: boolean
}

interface Interactable {
  id: InteractId
  x: number
  y: number
  label: string
}

const NPC_NAMES: Record<string, string> = {
  mara: 'Mara',
  orrin: 'Orrin',
  pip: 'Pip'
}

const PLAYER_SPEED = 110
const ATTACK_RANGE = 26
const CONTACT_IFRAMES = 1.1

/** Cozy-demo combat tuning: forgiving hit-and-recover rhythm. */
const ENEMY_TUNING = {
  wisp: { hp: 10, contact: 1, chase: 40, aggro: 90 },
  guardian: { hp: 44, contact: 2, lunge: 3, lungeSpeed: 250, telegraph: 0.65, cooldown: 3.2 }
} as const

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
  private lightProps: { sprite: Phaser.GameObjects.Image; gx: number; gy: number; glow: Phaser.GameObjects.Image | null }[] = []
  private positionTimer = 0

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

    this.buildGround()
    this.buildSolids()
    this.buildProps()
    this.buildInteractables()
    this.buildPlayer(state, this.pendingEntry)
    this.buildNpcs()
    this.buildEnemies(state)
    this.buildForeground()
    this.physics.add.collider(this.player, this.solidGroup)

    this.cameras.main.setBounds(0, 0, this.world.widthPx, this.world.heightPx)
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12)
    this.applyZoom(this.scale.width, this.scale.height)
    this.scale.on('resize', (size: Phaser.Structs.Size) => this.applyZoom(size.width, size.height))
    this.cameras.main.fadeIn(280, 12, 12, 20)

    // Input
    const kb = this.input.keyboard!
    kb.addCapture('SPACE,UP,DOWN,LEFT,RIGHT,W,A,S,D,E,F,M')
    this.cursors = kb.createCursorKeys()
    this.wasd = kb.addKeys('W,A,S,D') as Record<string, Phaser.Input.Keyboard.Key>
    this.actionKeys = kb.addKeys('E,SPACE,F,M') as Record<string, Phaser.Input.Keyboard.Key>
    bus.on(EV.action, this.handleAction, this)
    bus.on(EV.cast, this.handleCast, this)
    bus.on(EV.dialogueClosed, this.onDialogueClosed, this)
    this.events.once('shutdown', () => {
      bus.off(EV.action, this.handleAction, this)
      bus.off(EV.cast, this.handleCast, this)
      bus.off(EV.dialogueClosed, this.onDialogueClosed, this)
      this.scale.off('resize')
    })

    this.session.emitArea()
    this.session.emitStats()
    this.session.emitQuest()
    this.session.startAutosave()
    this.refreshLanternVisuals()
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
    ;(window as unknown as { __fsEnemies?: () => Array<{ x: number; y: number; state: string; hp: number; texture: string; body: { w: number; h: number }; flipX: boolean }> }).__fsEnemies =
      () => this.enemies.map((e) => {
        const b = e.sprite.body as Phaser.Physics.Arcade.Body
        return {
          x: e.sprite.x,
          y: e.sprite.y,
          state: e.state,
          hp: e.hp,
          texture: e.sprite.texture.key,
          body: { w: Math.round(b.width), h: Math.round(b.height) },
          flipX: e.sprite.flipX,
          tint: '0x' + e.sprite.tintTopLeft.toString(16).padStart(6, '0')
        }
      })
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
      bus.emit(EV.toast, {
        text: 'You come to by the village well. (Demo recovery — Habitica health rules come later.)'
      })
      bus.emit(EV.defeat, {})
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
      if (p.frame === 'lantern-post' || p.frame === 'lantern-shrine') {
        this.lightProps.push({ sprite: img, gx: x, gy: y - p.h * 0.72, glow: null })
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
      this.interactables.push({ id: 'clue', x: this.world.mural.tx * TILE + 8, y: this.world.mural.ty * TILE + TILE, label: 'Study the mural' })
    }
    if (this.world.shrine) {
      this.interactables.push({ id: 'lantern', x: this.world.shrine.tx * TILE + 8, y: this.world.shrine.ty * TILE + TILE, label: 'The old lantern' })
    }
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
      placeFingersnapOccluder(this, s.frame, s.tx * TILE + 8, s.ty * TILE + TILE, s.w)
    }
  }

  // ------------------------------------------------------------- enemies

  private spawnEnemy(id: string, type: EnemyType, tx: number, ty: number): Enemy {
    // Woodland enemies use the delivered slime/mushroom art; the guardian
    // uses the delivered native 24x24 pose textures when present (procedural
    // placeholder otherwise). Every pose shares the same 24x24 texture size
    // and (0.5, 1) origin, so the intended world size and the authored
    // 20x10 foot body are identical across poses.
    const isMushroom = id === 'wisp-c'
    const frame = type === 'guardian' ? 'guardian0' : isMushroom ? 'mushroom-idle' : 'slime-idle'
    const texKey = type === 'guardian' ? this.guardianPoseTexture('idle', 'guardian0') : 'fingersnap-enemies'
    const displayH = type === 'guardian' ? 24 : 14
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
      const anim = isMushroom ? 'mushroom-idle' : 'slime-idle'
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
      hp: type === 'wisp' ? ENEMY_TUNING.wisp.hp : ENEMY_TUNING.guardian.hp,
      maxHp: type === 'wisp' ? ENEMY_TUNING.wisp.hp : ENEMY_TUNING.guardian.hp,
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
      dead: false
    }
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
    if (announce) bus.emit(EV.toast, { text: 'The air goes cold. A stone warden uncoils from the dark!' })
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
      bus.emit(EV.toast, { text: 'The shade dissolves into motes of light.' })
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
        bus.emit(EV.toast, { text: 'Placeholder avatar — official layers unavailable for this character.' })
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
          text: 'Some Habitica layers are not in the local art cache — they are skipped from this avatar.',
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
      bus.emit(EV.toast, { text: 'No mount selected on this character.' })
      return
    }
    if (this.riding) {
      this.riding = false
      void this.buildAvatarVisual()
      bus.emit(EV.toast, { text: 'You dismount.' })
      return
    }
    if (this.world.areaId === 'village') {
      bus.emit(EV.toast, { text: 'No riding in the village — mount up outside the gates.' })
      return
    }
    const mountKeys = await loadCompanion(this, mountKey, 'mount')
    if (!mountKeys || mountKeys.length < 2) {
      bus.emit(EV.toast, { text: 'Your mount is not available here (its art is not cached) — you stay on foot.' })
      return
    }
    this.riding = true
    void this.buildAvatarVisual()
    bus.emit(EV.toast, { text: 'You mount up. (Faster travel, outdoors.)' })
  }

  private onProfileChanged(): void {
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
      bus.emit(EV.toast, { text: 'You dismount at the village gates.' })
    }
  }

  private damageEnemy(enemy: Enemy, amount: number, fromX: number): void {
    enemy.hp -= amount
    enemy.sprite.setTint(0xffe0d0)
    this.time.delayedCall(90, () => {
      if (!enemy.dead && enemy.sprite.active) {
        // A hit during the windup must not erase the telegraph tell for the
        // rest of the telegraph: re-apply it instead of clearing.
        if (enemy.type === 'guardian' && enemy.state === 'telegraph') enemy.sprite.setTint(0xd0e8ff)
        else enemy.sprite.clearTint()
      }
    })
    const knock = enemy.type === 'wisp' ? 26 : 8
    enemy.sprite.x += Math.sign(enemy.sprite.x - fromX) * knock
    if (enemy.hp <= 0) {
      this.killEnemy(enemy)
      return
    }
    if (enemy.type === 'guardian') this.flashGuardianHurt(enemy)
  }

  // ------------------------------------------------------------- combat

  private handleAction(): void {
    if (uiBlocked() || performance.now() < uiState.blockedUntil) return
    if (this.currentTarget) {
      // Free village activities stay available at zero HP: talking is fine.
      this.openInteraction(this.currentTarget)
      return
    }
    if (this.session.zeroHpLocked) return // too injured to fight; no auto revival
    this.tryAttack()
  }

  private kit(): CombatKit {
    return getCombatKit(this.session.importedProfile)
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
          this.damageEnemy(enemy, dmg, this.player.x)
        }
      }
    })
  }

  private handleCast(): void {
    const kit = this.kit()
    if (uiBlocked() || performance.now() < uiState.blockedUntil || this.transitioning) return
    if (this.session.zeroHpLocked) return
    if (this.castCooldown > 0 || this.attackCooldown > kit.cooldown) return
    if (this.session.state.mana < kit.manaCost) {
      bus.emit(EV.toast, { text: `Not enough mana for ${kit.signatureName} (${kit.manaCost} needed).` })
      return
    }
    this.castCooldown = 1.0
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
                this.damageEnemy(enemy, crit ? kit.signatureDamage * 2 : kit.signatureDamage, this.player.x - dir.x * 10)
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

  private damagePlayer(amount: number, fromX: number): void {
    if (this.iframes > 0 || this.transitioning) return
    const state = this.session.state
    // kit.mitigation is a FRACTION (0..0.45, shared combat contract), not a
    // flat subtraction: damage scales down multiplicatively, always >= 1.
    const mitigated = Math.max(1, Math.round(amount * (1 - this.kit().mitigation)))
    this.session.setVitals(state.hp - mitigated, state.mana)
    this.iframes = CONTACT_IFRAMES
    this.player.setTint(0xff9080)
    this.time.delayedCall(120, () => this.player.clearTint())
    const dir = Math.sign(this.player.x - fromX) || 1
    this.player.x += dir * 6
    if (this.session.state.hp <= 0) this.defeatRecovery()
  }

  /** Demo-only defeat recovery: wake at the village well with restored health. */
  private defeatRecovery(): void {
    this.transitioning = true
    this.session.defeat()
    this.cameras.main.fadeOut(320, 12, 12, 20)
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.scene.restart({ fromDefeat: true })
    })
  }

  // ------------------------------------------------------------- interaction

  private openInteraction(target: Interactable): void {
    let payload: { speaker: string; lines: string[]; event?: QuestEvent }
    try {
      payload = dialogueFor(target.id, this.session.questStage)
    } catch (err) {
      console.warn('[fingersnap] no dialogue available for', target.id, err)
      return
    }
    uiState.dialogueOpen = true
    bus.emit(EV.dialogue, {
      id: target.id,
      speaker: payload.speaker,
      lines: payload.lines,
      event: payload.event
    })
  }

  private onDialogueClosed = (payload: { event?: string }): void => {
    uiState.dialogueOpen = false
    uiState.blockedUntil = performance.now() + 220
    const event = payload?.event as QuestEvent | undefined
    if (!event) return
    // The clue is journaled under the shared content id (advanceQuest also
    // carries it; addUnique keeps it single-entry).
    if (event === 'find-clue') this.session.recordDiscovery('old-route-marker', 'the painted lanterns')
    this.session.applyQuestEvent(event)
    this.refreshLanternVisuals()
    if (event === 'find-clue' && this.world.areaId === 'ruin') this.spawnGuardian(true)
  }

  /**
   * Lit-lantern visuals depend on quest progress. The atlas props stay in
   * place; lighting adds an additive glow anchored at the lamp.
   */
  private refreshLanternVisuals(): void {
    const stage = this.session.questStage
    if (this.lightProps.length === 0) return
    // lightProps[0] = village lantern post (village), last = shrine (ruin)
    const shrineLit = stage === 'lantern-lit' || stage === 'complete'
    const villageLit = stage === 'complete'
    for (const lp of this.lightProps) {
      const isShrine = this.world.shrine !== null && Math.abs(lp.gx - (this.world.shrine.tx * TILE + 8)) < 1
      const shouldGlow = isShrine ? shrineLit : villageLit
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
    this.cameras.main.fadeOut(240, 12, 12, 20)
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.scene.restart({ entry })
    })
  }

  // ------------------------------------------------------------- zoom

  private applyZoom(_w: number, h: number): void {
    const base = Math.round((h / 280) * 2) / 2
    const zoom = Phaser.Math.Clamp(base, 1.5, 5)
    this.cameras.main.setZoom(zoom)
  }

  // ------------------------------------------------------------- update loop

  update(time: number, delta: number): void {
    const dt = Math.min(delta / 1000, 0.05)
    this.attackCooldown = Math.max(0, this.attackCooldown - dt)
    this.castCooldown = Math.max(0, this.castCooldown - dt)
    this.iframes = Math.max(0, this.iframes - dt)
    this.session.tickPlaySeconds(dt)

    // While a sync persistence owns the save file the world freezes its
    // resource/combat mutations: the committed snapshot must never revert a
    // mid-flight enemy hit, regen tick, or position write. The panel closes
    // normally; this gate only covers the brief disk write.
    if (uiBlocked() || this.transitioning || this.session.persistenceInFlight) {
      this.player.setVelocity(0, 0)
      this.updateEnemyBars()
      return
    }

    this.handleKeyboardActions()
    this.movePlayer(dt)
    this.updateEnemies(dt)
    this.updateBolts(dt)
    this.updateDiscoveries()
    this.checkExits()
    this.updatePrompt()
    this.updateEnemyBars()
    this.updateDepth()
    this.updateAvatarVisual(time)

    this.positionTimer += dt
    if (this.positionTimer > 1) {
      this.positionTimer = 0
      this.session.state.position = { x: Math.round(this.player.x), y: Math.round(this.player.y) }
    }
  }

  private handleKeyboardActions(): void {
    const now = performance.now()
    if (now < uiState.blockedUntil) return
    const justDown = (key: Phaser.Input.Keyboard.Key) => Phaser.Input.Keyboard.JustDown(key)
    if ((this.actionKeys.E && justDown(this.actionKeys.E)) || (this.actionKeys.SPACE && justDown(this.actionKeys.SPACE))) {
      this.handleAction()
    }
    if (this.actionKeys.F && justDown(this.actionKeys.F)) this.handleCast()
    if (this.actionKeys.M && justDown(this.actionKeys.M)) void this.toggleRide()
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
    const mana = Math.min(state.maxMana, state.mana + 5 * dt)
    let hp = state.hp
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
      const ex = enemy.sprite.x
      const ey = enemy.sprite.y - 6
      const dist = Math.hypot(px - ex, py - ey)
      if (enemy.type === 'wisp') {
        this.updateWisp(enemy, dt, dist, px, py)
      } else {
        this.updateGuardian(enemy, dt, dist, px, py)
      }
      // Contact damage
      const reach = enemy.type === 'guardian' && enemy.state === 'lunge' ? 18 : 13
      const dmg = enemy.type === 'guardian'
        ? enemy.state === 'lunge' ? ENEMY_TUNING.guardian.lunge : ENEMY_TUNING.guardian.contact
        : ENEMY_TUNING.wisp.contact
      if (dist < reach) this.damagePlayer(dmg, ex)
      enemy.sprite.setDepth(enemy.sprite.y)
    }
  }

  private updateWisp(enemy: Enemy, dt: number, dist: number, px: number, py: number): void {
    const body = enemy.sprite.body as Phaser.Physics.Arcade.Body
    if (dist < ENEMY_TUNING.wisp.aggro) {
      const dir = new Phaser.Math.Vector2(px - enemy.sprite.x, py - enemy.sprite.y).normalize()
      body.setVelocity(dir.x * ENEMY_TUNING.wisp.chase, dir.y * ENEMY_TUNING.wisp.chase)
    } else {
      enemy.wanderTimer -= dt
      if (enemy.wanderTimer <= 0) {
        enemy.wanderTimer = 1 + Math.random() * 1.6
        const angle = Math.random() * Math.PI * 2
        enemy.dirX = Math.cos(angle)
        enemy.dirY = Math.sin(angle)
      }
      body.setVelocity(enemy.dirX * 26, enemy.dirY * 26)
      // Drift home
      const home = new Phaser.Math.Vector2(enemy.homeX - enemy.sprite.x, enemy.homeY - enemy.sprite.y)
      if (home.length() > 90) body.setVelocity(home.x * 0.5, home.y * 0.5)
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
      const label = best ? best.label : null
      if (label !== this.lastPrompt) {
        this.lastPrompt = label
        const payload: PromptPayload = { label }
        bus.emit(EV.prompt, payload)
      }
    }
  }

  private updateEnemyBars(): void {
    this.hpBars.clear()
    for (const enemy of this.enemies) {
      const w = 22
      const x = enemy.sprite.x - w / 2
      const y = enemy.sprite.y - (enemy.type === 'guardian' ? 30 : 22)
      this.hpBars.fillStyle(0x241f31, 0.8)
      this.hpBars.fillRect(x - 1, y - 1, w + 2, 5)
      this.hpBars.fillStyle(0x7fe0e8, 1)
      this.hpBars.fillRect(x, y, Math.max(0, (enemy.hp / enemy.maxHp) * w), 3)
    }
  }

  private updateDepth(): void {
    this.player.setDepth(this.player.y)
    this.heroShadow.setPosition(this.player.x, this.player.y - 1)
    for (const npc of this.npcs) npc.sprite.setDepth(npc.sprite.y + 1)
  }
}
