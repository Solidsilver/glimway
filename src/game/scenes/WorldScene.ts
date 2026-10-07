/**
 * WorldScene — orchestration only: lifecycle (create/update/shutdown), area
 * transitions, camera and zoom, input dispatch, wiring to the session and
 * the event bus, and the scripted beats. Its playtest hooks live in
 * ./world-dev-hooks.ts (dev builds only).
 *
 * Area construction lives in src/game/area/ (from WorldData produced by
 * src/game/worlds.ts). Entities — hero, avatar, enemies, projectiles, NPCs,
 * interactables, effects — live in src/game/entities/. Remote players
 * (entities/remote-players.ts) are drawn from the presence feed
 * (src/game/presence.ts).
 */
import Phaser from 'phaser'
import type { AreaId, QuestEvent } from '../../lib/state'
import { itemInfo } from '../../content/world'
import { buildGround } from '../area/terrain'
import { buildSolids, solidBox, type SolidRun } from '../area/collision'
import { buildProps } from '../area/props'
import { buildForeground, updateOccluders as updateAreaOccluders, type Occluder } from '../area/foreground'
import { buildExitSigns } from '../area/exits'
import { refreshLanternVisuals, type LightProp } from '../area/lanterns'
import { bus, EV, type DialogueClosedPayload, type RelocatePayload } from '../events'
import { prefersReducedMotion, sfx } from '../sfx'
import { heroScreen, touchVec, uiBlocked, uiState } from '../input'
import { TILE } from '../textures'
import type { Session } from '../session'
import { buildArea, hasAreaKind, type WorldData } from '../worlds'
import { CHARM_ITEM, ROAD_LANTERNS, isLit, type EmberSpend, type RoadLanternId } from '../../lib/embers'
import { yieldLine } from '../../lib/gathering'
import { sellerFor } from '../../lib/items'
import { maybeNudgePip } from '../nudges' // P1 onboarding
import { AvatarVisual } from '../entities/avatar'
import { Hero } from '../entities/hero'
import { EnemySystem } from '../entities/enemies'
import { Projectiles } from '../entities/projectiles'
import { Interactables } from '../entities/interactables'
import { PaperPickups } from '../entities/papers'
import { ItemPickups } from '../entities/item-pickups'
import { Gathering } from '../entities/gathering'
import { RepairsLayer } from '../entities/repairs'
import { OffHandVisual } from '../entities/off-hand'
import { itemsFor } from '../items'
import { keepsakeSpeaker, keepsakeThanks, parseKeepsakeAction } from '../keepsakes'
import { echoCampSpeaker, echoForKeepsake } from '../../content/echoes'
import { echoSettled } from '../../lib/wilds/stories'
import { foundToast, paperById } from '../../content/papers'
import { Effects } from '../entities/fx'
import { HEIRLOOMS, HEIRLOOM_IDS, type HeirloomId, ADA_OIL_REPLIES, countAdaOilGifts } from '../../content/heirlooms'
import { heirloomBeat, sayHeirloomRefusal } from '../heirloom-beats'
import { NPC_NAMES, Npcs } from '../entities/npcs'
import { createRemotePlayers, showEmoteBubble, type RemotePlayers } from '../entities/remote-players'
import { Thoughts } from '../entities/thoughts'
import { presence } from '../presence'
import { presenceAreaFor } from '../../lib/presence-client'
import type { EmotePayload } from '../events'
import { hasWitnessed, isWitnessBeat, keepsWitness, witnessCopy, witnessFlag, witnessMoment } from '../../content/witness'
import { HomesteadLayer } from '../entities/homesteads'
import { COMMONS_RESIDENT_PORTRAITS, commonsDataUrl, commonsIconUrls } from '../commons-pass'
import { ITEM_ART_FALLBACK, itemIcon, itemIconUrls } from '../items-pass'
import { emitResidents } from '../residents'
import { villageFor } from '../village'
import { VillageLayer } from '../entities/village-life'
import { Touches } from '../entities/touches'
import { buildRoom, ROOM_ENTRY } from '../cottage'
import { homeArea, parseHomeArea } from '../../lib/homestead'
import { homeLights } from '../../lib/homestead-land'
import { homesteadsFor } from '../homestead'
import { isSafeArea } from '../../lib/habitica/sync'
import { ui } from '../../ui/store.svelte'
import { COMMONS_FROM_WILDS } from '../commons'
import {
  OUTER_REGION_ID,
  WILDS_AREA,
  WILDS_REGION_ID,
  fromRegionPosition,
  inRegion,
  isWildsArea,
  parseChunkArea,
  regionOfState,
  toRegionPosition,
  wildsArrivalPosition,
  wildsReturnTile,
  wildsSceneEntry,
} from '../wilds/regions'
import { ensureWildsAreaKinds, outerTurned, prepareWilds, resetWildsRegion, setActiveWildsRegion, wildsEpoch } from '../wilds/store'
import { SEASON_SHIFT_NOTICE } from '../../content/expansion-writing'
import { TURNED_SINCE_LINE, TURNING_TITLE } from '../../content/echoes'
import { TURNED_FLAG, calendarFind } from '../../lib/wilds/stories'
import { seasonMark } from '../../lib/wilds/outer'
import { loadWilds } from '../../lib/wilds/data'
import { playInsets } from '../viewport'
import { GoalGuide } from '../entities/goal-guide'
import { held, heldNow, setHeld, trackBelt, type HeldPayload } from '../held'
import { kindForKey, stepKind } from '../../lib/belt'
import { pinnedProgress } from '../guide-pin'
import type { GuideWhere } from '../../content/guides'
import { MAX_SCREEN_SCALE } from '../atlas-plan'
import { densityOf } from '../density'
import { grantPaper } from '../papers'
import { WildsEntities, type WildsAction } from '../wilds/entities'
import { setSyncSafety } from '../sync-safety'
import { exposeWorldHooks } from './world-dev-hooks'

/** How long a waiting warden rests for someone else's naming before it remembers its pose. */
const WITNESS_REST_MS = 4200

interface SceneData {
  entry?: { tx: number; ty: number }
  fromDefeat?: boolean
  /** Inside a homestead's cottage: which gate's, and the doorstep outside it. */
  room?: { gate: number; doorstep: { tx: number; ty: number } }
  /** Rebuilt by the Turning: the outer Wilds just shifted under the player. */
  turned?: boolean
}

/** Keyboard focus is on a control in the placement tray. */
function trayFocused(): boolean {
  const el = typeof document !== 'undefined' ? document.activeElement : null
  return !!el && el !== document.body && !!el.closest?.('[data-testid="placement-tray"]')
}

/** Areas where the zero-HP lock still lets you walk (home to rest): the village, the Commons, homesteads. */
const safeArea = (area: string) => isSafeArea(area)

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
  /** The solid tiles' merged runs and per-tile prop bodies (a cleared tile opens). */
  private solidRuns: SolidRun[] = []
  private solidProps = new Map<string, Phaser.Physics.Arcade.Image[]>()
  /** Tile-anchored sprites (a felled tree removes its own). */
  private scenerySprites = new Map<string, Phaser.GameObjects.Image[]>()
  /** Gathering: the workable pieces of this area (null where there are none). */
  private gathering: Gathering | null = null
  /** Atlas-prop lanterns that can glow when lit (area/lanterns owns visuals). */
  private lightProps: LightProp[] = []
  /** Foreground canopies/arches that fade when something walks beneath. */
  private occluders: Occluder[] = []
  private interactables!: Interactables
  /** Where the quest goal is: the HUD's needle and the off-screen glint (src/game/entities/goal-guide.ts). */
  private goalGuide!: GoalGuide
  private hero!: Hero
  private npcs!: Npcs
  private enemies!: EnemySystem
  private projectiles!: Projectiles
  private avatar!: AvatarVisual
  private offHand: OffHandVisual | null = null
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys
  private wasd!: Record<string, Phaser.Input.Keyboard.Key>
  private actionKeys!: Record<string, Phaser.Input.Keyboard.Key>
  private transitioning = false
  /** Dark while the ground's transitions are painted (a first visit; see create). */
  private holdingFade = false
  /** Which scene build's hold is current (a restart starts a new one). */
  private fadeHold = 0
  private reducedMotion = false
  private captureReleased = false
  private cinematic = false
  private positionTimer = 0
  /** Dev: take the position sample every frame (a playtest of the exit race). */
  private devSampleEveryFrame = false
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
    this.holdingFade = false
    this.fadeHold++
    this.pendingEntry = data?.entry ?? null
    this.pendingDefeatToast = data?.fromDefeat === true
    this.room = data?.room ?? null
    this.pendingTurned = data?.turned === true
  }

  /** The scene was rebuilt by a live Turning (show what happened). */
  private pendingTurned = false
  /** Seconds until the next "has the outer Wilds turned?" check. */
  private turningCheck = 0

  private pendingEntry: { tx: number; ty: number } | null = null
  private pendingDefeatToast = false
  private deepTangleTimer = 0
  private lamplightTimer = 0
  private easingTimer = 0
  private unmooredVeil: Phaser.GameObjects.Rectangle | null = null
  private unmooredEdges: Phaser.GameObjects.Rectangle[] = []

  create(): void {
    this.session = this.registry.get('session') as Session
    const state = this.session.state
    // A cottage is a view on its homestead: the save keeps saying `home:<gate>`.
    if (this.room && state.area !== homeArea(this.room.gate)) this.room = null
    // Wilds: the save's region (the Tangle, or past the crossing) is the one
    // this scene plays in; resolve the region-wide position into its chunk
    // area and a chunk-local arrival tile (see src/game/wilds/regions.ts).
    if (isWildsArea(state.area)) setActiveWildsRegion(regionOfState(state))
    // Back in the outer Wilds after they turned: the place you left is gone,
    // so you arrive at the region's entrance in the new epoch.
    let turnedAway = false
    if (isWildsArea(state.area) && regionOfState(state) === OUTER_REGION_ID) {
      const season = wildsEpoch().season
      if (state.outerSeason && state.outerSeason !== season) {
        turnedAway = !this.pendingTurned
        state.position = wildsArrivalPosition(wildsEpoch())
      }
      state.outerSeason = season
    }
    // Homestead lands read the session's homestead state (world, cleared tiles, desolation).
    homesteadsFor(this.session)
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
    this.world = this.room ? buildRoom(this.room.gate, this.room.doorstep) : wildsEntry ? buildArea(wildsEntry.areaId) : buildArea(state.area)
    this.occluders = []
    this.cinematic = false
    this.captureReleased = false
    this.reducedMotion = prefersReducedMotion()
    this.fx = new Effects(this, this.reducedMotion)

    // Area construction from WorldData (a new area kind is data + a small
    // builder — see the registry in src/game/worlds.ts).
    const groundPainting = buildGround(this, this.world)
    const solids = buildSolids(this, this.world)
    this.solidGroup = solids.group
    this.solidRuns = solids.runs
    this.solidProps = solids.props
    const props = buildProps(this, this.world, this.solidGroup)
    this.lightProps = props.lights
    this.scenerySprites = props.sprites

    // Entities
    const papers = new PaperPickups(this, { world: this.world, session: this.session, fx: this.fx, reducedMotion: this.reducedMotion })
    this.interactables = new Interactables(this, { world: this.world, session: this.session, reducedMotion: this.reducedMotion, papers, village: villageFor(this.session) })
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
    this.avatar = new AvatarVisual(this, { session: this.session, world: this.world, hero: () => this.hero, reducedMotion: this.reducedMotion })
    this.offHand = new OffHandVisual(this, this.session, () => this.hero)
    this.npcs = new Npcs(this, this.world)
    this.interactables.setAway((id) => this.npcs.away(id))
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
    // Small world touches: smell the flowers, sit on a bench, read the signs.
    this.interactables.setExtra(new Touches({ world: this.world, interactables: this.interactables, hero: () => this.hero, fx: this.fx }))
    // Things lying about to pick up (a world's; the server keeps who took what).
    const pickups = new ItemPickups(this, { world: this.world, session: this.session, fx: this.fx, reducedMotion: this.reducedMotion, interactables: this.interactables })
    this.interactables.setExtra(pickups)
    // The workable pieces (trees, boulders, stumps, patches) — wilds chunks,
    // the woods, and homestead land; nowhere else (there's nothing to work).
    this.gathering = new Gathering(this, {
      world: this.world,
      session: this.session,
      fx: this.fx,
      reducedMotion: this.reducedMotion,
      hero: () => this.hero,
      notePosition: () => this.notePosition(),
      clearSolid: (tx, ty) => this.clearSolidTile(tx, ty),
      spritesAt: (tx, ty) => this.scenerySprites.get(`${tx},${ty}`) ?? [],
      fell: (tx, ty) => {
        for (const img of this.scenerySprites.get(`${tx},${ty}`) ?? []) img.destroy()
        this.scenerySprites.delete(`${tx},${ty}`)
      }
    })
    // The village's broken things, mended with the right part (shared per world).
    const repairs = new RepairsLayer(this, { world: this.world, session: this.session, fx: this.fx, reducedMotion: this.reducedMotion, interactables: this.interactables })
    this.interactables.setExtra(repairs)
    this.homesteads = null
    if (this.world.areaId === 'commons' || parseHomeArea(this.world.areaId) !== null || this.room) {
      this.homesteads = new HomesteadLayer(this, {
        world: this.world,
        session: this.session,
        fx: this.fx,
        reducedMotion: this.reducedMotion,
        solidGroup: this.solidGroup,
        interactables: this.interactables,
        hero: () => this.hero.sprite,
        sitter: () => this.hero,
        room: this.room ? { gate: this.room.gate } : null,
        enterRoom: (gate, doorstep) => this.enterRoom(gate, doorstep),
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
    // A restarted scene keeps its fields: last area's fade images are gone.
    this.edgeFade = []
    this.applyZoom(this.scale.width, this.scale.height)
    const onResize = (size: Phaser.Structs.Size) => this.applyZoom(size.width, size.height)
    this.scale.on('resize', onResize)
    this.events.once('shutdown', () => this.scale.off('resize', onResize))
    // A first visit paints the ground's transitions off the main thread
    // (src/game/area/terrain.ts): stay dark until they're in (a second at
    // most), so the area never shows without its edges.
    if (groundPainting) {
      const cam = this.cameras.main
      cam.fadeOut(1, 12, 12, 20)
      this.holdingFade = true
      // Only a newer scene build cancels this hold (a paused scene still lifts it).
      const token = ++this.fadeHold
      const show = () => {
        if (token !== this.fadeHold || !this.holdingFade) return
        this.holdingFade = false
        // Already leaving (a warp or an exit during the hold): its fade-out
        // must finish, or the scene never restarts (fadeIn always forces).
        if (!this.transitioning) cam.fadeIn(280, 12, 12, 20)
      }
      void groundPainting.then(show, show)
      this.time.delayedCall(1200, show)
    } else this.cameras.main.fadeIn(280, 12, 12, 20)

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
    // What's in hand (src/game/held.ts): number keys and the wheel pick from
    // the belt; the mouse uses it where you point.
    const stopBelt = trackBelt(this.session)
    kb.on('keydown', this.onBeltKey, this)
    this.input.on('wheel', this.onBeltWheel, this)
    this.input.on('pointerdown', this.onWorldPointer, this)
    this.input.mouse?.disableContextMenu()
    bus.on(EV.held, this.onHeldChanged, this)
    this.events.once('shutdown', () => {
      stopBelt()
      kb.off('keydown', this.onBeltKey, this)
      this.input.off('wheel', this.onBeltWheel, this)
      this.input.off('pointerdown', this.onWorldPointer, this)
      bus.off(EV.held, this.onHeldChanged, this)
    })
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
    emitResidents(this.session)
    this.session.startAutosave()
    refreshLanternVisuals(this, this.lightProps, this.session.questStage, this.session.state)
    this.interactables.buildMarkers()
    this.emitPortraits()
    bus.on(EV.quest, this.refreshMarkers, this)
    this.events.once('shutdown', () => bus.off(EV.quest, this.refreshMarkers, this))
    bus.on(EV.profileChanged, this.onProfileChanged, this)
    bus.on(EV.worldRefresh, this.onWorldRefresh, this)
    bus.on(EV.relocate, this.onRelocate, this)
    bus.on(EV.notePosition, this.notePosition, this)
    this.events.once('shutdown', () => {
      bus.off(EV.profileChanged, this.onProfileChanged, this)
      bus.off(EV.worldRefresh, this.onWorldRefresh, this)
      bus.off(EV.relocate, this.onRelocate, this)
      bus.off(EV.notePosition, this.notePosition, this)
      // Epoch bump: in-flight avatar/companion loads must not add objects to a
      // dead scene or fight a rebuilt scene's own composition. Hero combat
      // timing and the avatar's carried state ride out the restart.
      this.hero.carry()
      this.avatar.invalidate()
    })
    // Remote players (phase 6 presence): join this area's room and draw the
    // others in it. A cottage is part of its homestead's room, but its map is
    // not: inside, nobody is drawn and we stand at our door for the others.
    const feed = presence()
    this.presenceArea = presenceAreaFor(this.room ? homeArea(this.room.gate) : this.world.areaId)
    feed?.setArea(this.presenceArea)
    this.remotePlayers = createRemotePlayers(this, feed, this.presenceArea, !!this.room)
    bus.on(EV.emote, this.onOwnEmote, this)
    bus.on(EV.witness, this.onWitness, this)
    this.events.once('shutdown', () => {
      this.remotePlayers.clear()
      bus.off(EV.emote, this.onOwnEmote, this)
      bus.off(EV.witness, this.onWitness, this)
    })
    this.goalGuide = new GoalGuide(this, {
      world: this.world,
      stage: () => this.session.questStage,
      npcAt: (id) => {
        const n = this.npcs.npcs.find((x) => x.id === id)
        return n ? { x: n.sprite.x, y: n.sprite.y - 8 } : null
      },
      spotAt: (id) => {
        const it = this.interactables.list.find((x) => x.id === id)
        return it ? { x: it.x, y: it.y - 8 } : null
      },
      wardenAt: () => {
        const w = this.enemies.wardenView()
        return w.state === 'active' && w.visible ? { x: w.x, y: w.y - 8 } : null
      },
      placeKind: () => this.homesteads?.placeKind ?? (this.room ? 'cottage' : null),
      guidePoint: (where) => this.homesteads?.guidePoint(where) ?? null,
      pinnedStep: () => this.guideStep(),
      reducedMotion: this.reducedMotion
    })
    // Passing thoughts above the hero (flavour lines; cleans up on shutdown).
    new Thoughts(this, this.hero.sprite, { reducedMotion: this.reducedMotion, hidden: () => this.cinematic, offsetY: -32 })
    void this.avatar.build() // imported layered avatar (if any)

    // Sync safety for the UI's sync gate (src/game/sync-safety.ts).
    setSyncSafety(() => {
      const px = this.hero.sprite.x
      const py = this.hero.sprite.y
      return {
        areaId: this.world.areaId,
        transitioning: this.transitioning,
        dialogueOpen: uiState.dialogueOpen,
        enemiesNear: this.enemies.enemies.some((e) => Math.hypot(e.sprite.x - px, e.sprite.y - py) < 200)
      }
    })
    // Playtest hooks (docs/playtest.md), dev builds only.
    if (import.meta.env.DEV) exposeWorldHooks(this, { papers, pickups, repairs })

    if (this.pendingDefeatToast) {
      this.pendingDefeatToast = false
      bus.emit(EV.defeat, { phase: 'woke' })
    }

    // The Turning: an ended epoch (a claim refused, or the clock passing the
    // wick's end while we stand here) shifts the outer Wilds under us.
    bus.on(EV.turning, this.onTurning, this)
    bus.on(EV.clock, this.onClock, this)
    const onClearUnmoored = (p: { instant: boolean }) => this.onClearUnmoored(p)
    bus.on('game:clear-unmoored', onClearUnmoored)
    const offAll = () => {
      bus.off(EV.turning, this.onTurning, this)
      bus.off(EV.clock, this.onClock, this)
      bus.off('game:clear-unmoored', onClearUnmoored)
      this.clearUnmooredVisuals()
    }
    this.events.once('shutdown', offAll)
    this.events.once('destroy', offAll)

    if (this.pendingTurned || turnedAway) {
      const live = this.pendingTurned
      this.pendingTurned = false
      this.time.delayedCall(600, () => this.noteTurning(live))
    }
  }

  // ------------------------------------------------------------- the Turning

  private inOuterWilds(): boolean {
    return parseChunkArea(this.world.areaId)?.region === OUTER_REGION_ID
  }

  private onTurning(): void {
    this.triggerUnmoored()
    if (this.inOuterWilds()) this.playTurning()
  }

  private onClock(): void {
    this.turningCheck = 0
  }

  /** Once a second in the outer Wilds: has its epoch ended? */
  private checkTurning(dt: number): void {
    if (!this.inOuterWilds()) return
    this.turningCheck -= dt
    if (this.turningCheck > 0) return
    this.turningCheck = 1
    if (outerTurned(this.session)) this.playTurning()
  }

  /**
   * "The Wilds shift": the screen pales and shakes, the canon notice is
   * posted, and the player comes to at the outer region's entrance in the
   * new epoch (guests: the calendar's next wick; connected: the server's).
   */
  private playTurning(): void {
    if (this.transitioning) return
    this.transitioning = true
    this.hero.halt()
    const cam = this.cameras.main
    const cx = cam.width / 2
    const cy = cam.height / 2
    const veil = this.add.rectangle(cx, cy, cam.width * 2, cam.height * 2, 0xdfe8ec, 0).setScrollFactor(0).setDepth(9000)
    const title = this.add
      .text(cx, cy - 6, TURNING_TITLE, { fontFamily: '"Pixelify Sans", monospace', fontSize: '12px', color: '#2b2238', resolution: 8 })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(9001)
      .setAlpha(0)
    const notice = this.add
      .text(cx, cy + 10, SEASON_SHIFT_NOTICE, { fontFamily: 'Nunito, sans-serif', fontSize: '6px', color: '#4a4058', resolution: 8, align: 'center', wordWrap: { width: Math.min(220, cam.width / cam.zoom - 24) } })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(9001)
      .setAlpha(0)
    if (!this.reducedMotion) cam.shake(900, 0.006)
    sfx('settle')
    this.tweens.add({ targets: veil, fillAlpha: 0.92, duration: this.reducedMotion ? 200 : 900 })
    this.tweens.add({ targets: [title, notice], alpha: 1, duration: 500, delay: 300 })
    this.time.delayedCall(this.reducedMotion ? 1200 : 1900, () => {
      resetWildsRegion(OUTER_REGION_ID)
      const state = this.session.state
      state.area = WILDS_AREA
      state.wildsRegion = OUTER_REGION_ID
      void prepareWilds(this.session, 0).finally(() => {
        // The entrance of the region as it is now.
        state.position = wildsArrivalPosition(wildsEpoch(OUTER_REGION_ID))
        state.outerSeason = wildsEpoch(OUTER_REGION_ID).season
        this.session.saveSoon()
        this.scene.restart({ turned: true })
      })
    })
  }

  /** You saw the outer Wilds turn: the canon notice, and what a Turning gives. */
  private noteTurning(live: boolean): void {
    const s = this.session
    s.addFlag(TURNED_FLAG)
    bus.emit(EV.toast, { text: live ? SEASON_SHIFT_NOTICE : `${TURNED_SINCE_LINE} ${SEASON_SHIFT_NOTICE}`, icon: 'map' })
    const ctx = { flags: s.state.flags, late: s.state.quest === 'complete', mark: seasonMark(wildsEpoch(OUTER_REGION_ID).season) }
    const paper = calendarFind('turning', ctx)
    if (paper) this.time.delayedCall(1400, () => grantPaper(s, paper))
    this.triggerUnmoored()
  }

  triggerUnmoored(): void {
    ui.unmoored = true
    if (!ui.unmooredEasing) this.lamplightTimer = 0
    if (!this.session.state.flags.includes('unmoored:felt')) {
      this.session.addFlag('unmoored:felt')
      emitResidents(this.session)
      bus.emit(EV.toast, { text: 'New in your journal: The Drift’s Sway', icon: 'scroll', kind: 'gain', gain: { to: 'journal', label: 'The Drift’s Sway' } })
    }
  }

  onClearUnmoored(p: { instant: boolean }): void {
    if (!ui.unmoored) return
    if (p.instant) {
      this.clearUnmoored()
    } else {
      ui.unmooredEasing = true
      this.easingTimer = 45
    }
  }

  clearUnmoored(): void {
    if (!ui.unmoored && !ui.unmooredEasing) return
    ui.unmoored = false
    ui.unmooredEasing = false
    this.lamplightTimer = 0
    this.deepTangleTimer = 0
    this.easingTimer = 0
    this.clearUnmooredVisuals()
    if (!this.session.state.flags.includes('unmoored:cleared')) {
      this.session.addFlag('unmoored:cleared')
      emitResidents(this.session)
      bus.emit(EV.toast, { text: 'New in your journal: Finding the Anchor', icon: 'scroll', kind: 'gain', gain: { to: 'journal', label: 'Finding the Anchor' } })
    }
  }

  private updateUnmooredVisuals(time: number, _dt: number): void {
    const cam = this.cameras.main
    if (!cam) return
    const factor = ui.unmooredEasing ? Math.max(0, this.easingTimer / 45) : 1.0

    if (this.reducedMotion) {
      if (!this.unmooredVeil) {
        this.unmooredVeil = this.add.rectangle(cam.centerX, cam.centerY, cam.width * 2, cam.height * 2, 0xa8b4c0, 0.18 * factor).setScrollFactor(0).setDepth(8500)
      } else {
        this.unmooredVeil.setPosition(cam.centerX, cam.centerY).setSize(cam.width * 2, cam.height * 2).setAlpha(0.18 * factor)
      }
      cam.setRotation(0)
      return
    }

    if (!this.unmooredVeil) {
      this.unmooredVeil = this.add.rectangle(cam.centerX, cam.centerY, cam.width * 2, cam.height * 2, 0xd0dbe6, 0.12 * factor).setScrollFactor(0).setDepth(8500)
    } else {
      this.unmooredVeil.setPosition(cam.centerX, cam.centerY).setSize(cam.width * 2, cam.height * 2).setAlpha((0.12 + Math.sin(time * 0.0015) * 0.04) * factor)
    }

    if (this.unmooredEdges.length === 0) {
      const ex = (cam.width / 2) * (1 - 1 / cam.zoom)
      const ey = (cam.height / 2) * (1 - 1 / cam.zoom)
      const top = this.add.rectangle(cam.centerX, ey + 14 / cam.zoom, cam.width * 2, 28 / cam.zoom, 0x8fa4b8, 0.22).setScrollFactor(0).setDepth(8501)
      const bottom = this.add.rectangle(cam.centerX, cam.height - ey - 14 / cam.zoom, cam.width * 2, 28 / cam.zoom, 0x8fa4b8, 0.22).setScrollFactor(0).setDepth(8501)
      const left = this.add.rectangle(ex + 14 / cam.zoom, cam.centerY, 28 / cam.zoom, cam.height * 2, 0x8fa4b8, 0.22).setScrollFactor(0).setDepth(8501)
      const right = this.add.rectangle(cam.width - ex - 14 / cam.zoom, cam.centerY, 28 / cam.zoom, cam.height * 2, 0x8fa4b8, 0.22).setScrollFactor(0).setDepth(8501)
      this.unmooredEdges = [top, bottom, left, right]
    } else {
      const edgeAlpha = (0.2 + Math.sin(time * 0.0022) * 0.08) * factor
      const ex = (cam.width / 2) * (1 - 1 / cam.zoom)
      const ey = (cam.height / 2) * (1 - 1 / cam.zoom)
      this.unmooredEdges[0].setPosition(cam.centerX, ey + 14 / cam.zoom).setSize(cam.width * 2, 28 / cam.zoom).setAlpha(edgeAlpha)
      this.unmooredEdges[1].setPosition(cam.centerX, cam.height - ey - 14 / cam.zoom).setSize(cam.width * 2, 28 / cam.zoom).setAlpha(edgeAlpha)
      this.unmooredEdges[2].setPosition(ex + 14 / cam.zoom, cam.centerY).setSize(28 / cam.zoom, cam.height * 2).setAlpha(edgeAlpha)
      this.unmooredEdges[3].setPosition(cam.width - ex - 14 / cam.zoom, cam.centerY).setSize(28 / cam.zoom, cam.height * 2).setAlpha(edgeAlpha)
    }

    const sway = Math.sin(time * 0.0018) * 0.007 * factor
    cam.setRotation(sway)
  }

  private clearUnmooredVisuals(): void {
    if (this.cameras?.main) {
      this.cameras.main.setRotation(0)
    }
    if (this.unmooredVeil) {
      this.unmooredVeil.destroy()
      this.unmooredVeil = null
    }
    for (const r of this.unmooredEdges) {
      r.destroy()
    }
    this.unmooredEdges = []
  }

  // ------------------------------------------------------------- update loop

  update(time: number, delta: number): void {
    const dt = Math.min(delta / 1000, 0.05)
    this.keepFramed()
    // The hero's spot on the canvas, every frame (panels and transitions too):
    // "hold to walk" steers by it, and title cards keep clear of it.
    const view = this.cameras.main.worldView
    heroScreen.x = (this.hero.sprite.x - view.x) * this.cameras.main.zoom
    heroScreen.y = (this.hero.sprite.y - 8 - view.y) * this.cameras.main.zoom
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

    const chunk = parseChunkArea(this.world.areaId)
    const tangleEntry = loadWilds().regions.find((region) => region.id === WILDS_REGION_ID)
    const inDeepTangle = !!(
      chunk && tangleEntry && chunk.region === WILDS_REGION_ID &&
      Math.abs(chunk.cx - tangleEntry.entryX) + Math.abs(chunk.cy - tangleEntry.entryY) >= loadWilds().deepTangleManhattanDistance
    )
    if (inDeepTangle) {
      this.deepTangleTimer += dt
      if (this.deepTangleTimer >= 240) {
        this.triggerUnmoored()
        this.deepTangleTimer = 0
      }
    } else {
      this.deepTangleTimer = 0
    }

    if (ui.unmoored) {
      if (isSafeArea(this.world.areaId)) {
        this.lamplightTimer += dt
        if (this.lamplightTimer >= 120) {
          this.clearUnmoored()
        }
      } else {
        this.lamplightTimer = 0
      }

      if (ui.unmooredEasing) {
        this.easingTimer -= dt
        if (this.easingTimer <= 0) {
          this.clearUnmoored()
        }
      }
      this.updateUnmooredVisuals(time, dt)
    } else {
      this.clearUnmooredVisuals()
    }

    // While a sync persistence owns the save file the world freezes its
    // resource/combat mutations: the committed snapshot must never revert a
    // mid-flight enemy hit, regen tick, or position write. The panel closes
    // normally; this gate only covers the brief disk write.
    this.homesteads?.update(dt)
    // Others keep walking while a panel or dialogue holds the screen.
    this.remotePlayers.update(dt)
    this.npcs.update(dt, this.hero.sprite, uiBlocked() || this.transitioning || this.cinematic)
    this.samplePresence()
    if (uiBlocked() || this.transitioning || this.cinematic || this.session.persistenceInFlight || this.homesteads?.placing) {
      this.hero.halt()
      // Still breathing while a conversation or panel holds the screen.
      this.avatar.update(time)
      this.interactables.hideKeyHint()
      this.goalGuide.update(dt, this.hero.sprite, false)
      this.gathering?.updateHint(dt, this.hero.sprite, false, false)
      this.enemies.updateEnemyBars()
      this.updateOccluders(dt)
      return
    }

    this.hero.move(dt, this.inputVector())
    this.enemies.update(dt)
    this.goalGuide.update(dt, this.hero.sprite, this.worldLive())
    this.projectiles.update(dt)
    this.wilds?.update()
    this.checkTurning(dt)
    this.updateDiscoveries()
    this.checkExits()
    maybeNudgePip(this.session, this.world, this.hero.sprite) // P1 onboarding: Pip's one-off gate line
    const speak = this.enemies.speakTarget()
    const wildsAction: WildsAction | null = this.wilds?.promptAction(this.hero.sprite) ?? null
    // Gathering proposes only when its piece is nearer than the nearest
    // interactable (a pickup or a person right there outranks the woods).
    const gatherAction = this.gathering?.promptAction(this.hero.sprite, this.interactables.nearest(this.hero.sprite)) ?? null
    const action = wildsAction ?? gatherAction ?? (speak ? { label: 'Speak the naming', verb: 'Speak', ...speak } : null)
    this.interactables.updatePrompt(this.hero.sprite, this.time.now, action)
    // Where the prompt's thing stands (a click on it does what E would).
    const it = this.interactables.currentTarget
    this.promptAt = action ? { x: action.x, y: action.y } : it ? { x: it.x, y: it.y - 8 } : null
    // The wrong tool in hand by something workable: a faint hint after a moment.
    const hx = this.hero.sprite.x
    const hy = this.hero.sprite.y
    const creatureNear = this.enemies.enemies.some((e) => !e.dead && Math.hypot(e.sprite.x - hx, e.sprite.y - hy) < 200)
    this.gathering?.updateHint(dt, this.hero.sprite, creatureNear, true)
    this.enemies.updateEnemyBars()
    this.updateOccluders(dt)
    this.updateDepth()
    this.avatar.update(time)
    this.offHand?.update(time)

    this.positionTimer += dt
    // In a cottage the save keeps the doorstep (set on the way in). Nor while
    // a move began this frame (an exit, above): the save already names the
    // destination, and this spot belongs to the area being left.
    if (this.positionTimer > 1 || this.devSampleEveryFrame) {
      this.positionTimer = 0
      this.notePosition()
    }
  }

  /**
   * Write where the hero stands into the save, now (the frame loop does it
   * once a second; a gather or a planting does it first, so the server
   * measures reach from where the hero really is).
   */
  private notePosition(): void {
    if (this.room || this.transitioning) return
    // Wilds: saved progress is region-wide pixels (one convention for
    // saves, reloads, claims and defeat reports).
    this.session.state.position = this.wildsEntryNow()
      ? this.wildsPosition(Math.round(this.hero.sprite.x), Math.round(this.hero.sprite.y))
      : { x: Math.round(this.hero.sprite.x), y: Math.round(this.hero.sprite.y) }
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
  /**
   * Someone standing near reached a story beat (the server relayed it from
   * its record of their progress): the moment on screen, a lantern over
   * them, and a journal line, once per beat and traveler. Your story doesn't
   * move. Your own waiting warden rests a moment, then remembers its pose.
   */
  private onWitness(p: { beat: string; habiticaId: string; name: string }): void {
    const s = this.session
    if (!s.link || !p || !isWitnessBeat(p.beat) || !p.habiticaId) return
    if (hasWitnessed(s.state.flags, p.beat, p.habiticaId)) return
    // The line is kept for the first few travelers of each beat; the moment shows every time.
    const flag = witnessFlag(p.beat, p.habiticaId, p.name)
    if (flag && keepsWitness(s.state.flags, p.beat)) {
      s.addFlag(flag)
      emitResidents(s)
    }
    bus.emit(EV.toast, { text: witnessMoment(p.beat, p.name), icon: 'lantern' })
    bus.emit(EV.emote, { habiticaId: p.habiticaId, id: 'lantern' } satisfies EmotePayload)
    if (p.beat === 'warden' && this.world.areaId === 'ruin') {
      this.enemies.witnessRest(WITNESS_REST_MS, () => bus.emit(EV.toast, { text: witnessCopy.wardenRises, icon: 'lantern' }))
    }
  }

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

  /** The pinned guide's current step, re-read twice a second (it reads the item and home models). */
  private guideStepAt = -1
  private guideStepCache: { where: GuideWhere | null } | null = null
  private guideStep(): { where: GuideWhere | null } | null {
    const now = this.time.now
    if (now - this.guideStepAt < 500 && this.guideStepAt >= 0) return this.guideStepCache
    this.guideStepAt = now
    const p = pinnedProgress(this.session)
    this.guideStepCache = p && !p.done && !p.locked && p.current !== null ? { where: p.steps[p.current].where } : null
    return this.guideStepCache
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
    // The warden standing open after a lunge, within reach: speak it the naming.
    if (this.enemies.speakNaming()) return
    // Wilds claims (harvest, camp, chest, POI, lantern) outrank talking.
    if (this.wilds?.handleAction()) return
    // Gathering (chop, break, dig) outranks talking: the woods come first.
    if (this.gathering?.handleAction()) return
    if (this.interactables.currentTarget) {
      // Free village activities stay available at zero HP: talking is fine.
      this.interactables.open(this.interactables.currentTarget)
      return
    }
    if (this.session.zeroHpLocked) return // too injured to fight; no auto revival
    // A tool in hand swings too, weakly (you're never helpless).
    this.hero.tryAttack({ tool: heldNow().kind !== 'weapon' })
  }

  // ------------------------------------------------------------- the hand

  /** Where the current prompt's thing stands (null: no prompt). */
  private promptAt: { x: number; y: number } | null = null
  private wheelAcc = 0
  private wheelAt = 0

  /** Keys 1…9 take the belt's slot in hand (not while the emote picker, a panel or a talk has the keys). */
  private onBeltKey(e: KeyboardEvent): void {
    const m = /^Digit([1-9])$/.exec(e.code)
    // A digit the UI already used (an emote picked from the picker) isn't for the belt.
    if (!m || e.repeat || e.ctrlKey || e.metaKey || e.altKey || (e as KeyboardEvent & { fsConsumed?: boolean }).fsConsumed) return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (ui.emoteOpen || !this.worldLive()) return
    const kind = kindForKey(held.belt, Number(m[1]))
    if (kind) setHeld(kind)
  }

  /** The wheel steps along the belt (one step per notch; a trackpad's flick counts once). */
  private onBeltWheel(_p: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number): void {
    if (!this.worldLive() || held.belt.length < 2) return
    const now = performance.now()
    if (now - this.wheelAt > 300) this.wheelAcc = 0
    this.wheelAcc += dy
    if (Math.abs(this.wheelAcc) < 40 || now - this.wheelAt < 120) return
    this.wheelAt = now
    setHeld(stepKind(held.belt, heldNow().kind, this.wheelAcc > 0 ? 1 : -1))
    this.wheelAcc = 0
  }

  /**
   * The mouse on the world (desktop; touches go to the touch controls). Left:
   * what the prompt's thing would do when you click it, or the held tool on
   * the piece under the cursor, or talk to the person or sign there, or a
   * swing toward the cursor. Right: talk to or use what's under the cursor.
   */
  private onWorldPointer(p: Phaser.Input.Pointer): void {
    const ev = p.event as PointerEvent | MouseEvent | TouchEvent
    if ('pointerType' in ev && ev.pointerType && ev.pointerType !== 'mouse') return
    if (typeof TouchEvent !== 'undefined' && ev instanceof TouchEvent) return
    if (!this.worldLive()) return
    const at = { x: p.worldX, y: p.worldY }
    const hero = this.hero.sprite
    const onPrompt = !!this.promptAt && Math.hypot(at.x - this.promptAt.x, at.y - this.promptAt.y) <= 18
    // A person, sign or pickup under the cursor and within reach.
    const thing = this.interactables.list.find(
      (it) => Math.hypot(at.x - it.x, at.y - (it.y - 8)) <= 14 && Math.hypot(hero.x - it.x, hero.y - 8 - (it.y - 8)) <= 40
    )
    if (p.button === 2) {
      if (onPrompt) this.handleAction()
      else if (thing) this.interactables.open(thing)
      return
    }
    if (p.button !== 0) return
    if (onPrompt) return this.handleAction()
    if (this.gathering?.workAt(at, hero)) return
    if (thing) return this.interactables.open(thing)
    if (this.session.zeroHpLocked) return
    this.hero.tryAttack({ tool: heldNow().kind !== 'weapon', toward: at })
  }

  /** Something else in hand: the prompt follows at once, and the tool shows over the hero for a moment. */
  private lastHeld = heldNow().kind
  private onHeldChanged(p: HeldPayload): void {
    this.interactables.invalidatePrompt()
    if (p.kind === this.lastHeld) return
    this.lastHeld = p.kind
    if (!this.sys.isActive()) return
    sfx('click')
    const slot = p.belt.find((s) => s.kind === p.kind)
    if (!slot?.itemDef) return
    let key = itemIcon(slot.itemDef)
    if (!this.textures.exists(key)) key = ITEM_ART_FALLBACK
    if (!this.textures.exists(key)) return
    const img = this.add.image(this.hero.sprite.x, this.hero.sprite.y - 30, key).setOrigin(0.5, 1).setDepth(5000)
    if (img.height > 12) img.setScale(12 / img.height)
    this.tweens.add({ targets: img, y: img.y - (this.reducedMotion ? 0 : 6), alpha: 0, delay: 350, duration: 450, onComplete: () => img.destroy() })
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
    emitResidents(this.session)
  }

  /** My homestead's lamps on this land (the light that holds the ground). */
  private myLights(): { x: number; y: number; radius: number }[] {
    if (parseHomeArea(this.world.areaId) === null) return []
    const mine = homesteadsFor(this.session).mine
    if (!mine) return []
    return homeLights(
      mine.items.filter((i) => i.itemDef === 'lantern-post' && i.scene === 'outdoor' && i.x !== null && i.y !== null) as { x: number; y: number }[]
    )
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
      const r = inRegion(p.x, p.y, regionOfState(this.session.state)) ? fromRegionPosition(p.x, p.y) : null
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
        // Dense textures (../density.ts): read their texels, `k` a world px.
        const k = frame ? 1 : densityOf(tex)
        const w = f.cutWidth * k
        const h = f.cutHeight * k
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(src, f.cutX * k, f.cutY * k, w, h, 0, 0, w, h)
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
        // The portrait stays world-px sized (the UI sizes it by its natural size).
        const size = Math.ceil(Math.max(bw, cropH) / k) + 2
        const o = document.createElement('canvas')
        o.width = size
        o.height = size
        const octx = o.getContext('2d')!
        octx.imageSmoothingEnabled = k > 1
        octx.imageSmoothingQuality = 'high'
        const dx = Math.floor((size - bw / k) / 2)
        const dy = bust ? size - cropH / k : Math.floor((size - bh / k) / 2)
        octx.drawImage(c, minX, minY, bw, cropH, dx, dy, bw / k, cropH / k)
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
    // Commons pass: the residents' delivered busts (64 px), and the UI icons.
    for (const [name, frame] of Object.entries(COMMONS_RESIDENT_PORTRAITS)) {
      const url = commonsDataUrl(this, frame)
      if (url) out[name] = url
    }
    bus.emit(EV.portraits, out)
    bus.emit(EV.artIcons, { ...commonsIconUrls(this), ...itemIconUrls(this) })
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
    if (action.startsWith('keep:return:')) {
      const parsed = parseKeepsakeAction(action)
      if (parsed) this.returnKeepsake(parsed.def, parsed.target)
      return
    }
    if (action.startsWith('echo:settle:')) {
      // A settle picked in an Echo camp conversation (the keep's offer keeps the lamp open).
      this.wilds?.settleEcho(action.slice('echo:settle:'.length))
      return
    }
    if (action.startsWith('heirloom:grant:')) {
      const id = action.slice('heirloom:grant:'.length)
      this.grantHeirloom(id)
      return
    }
    if (action === 'ada:oil') {
      this.giveAdaOil()
      return
    }
    if (action.startsWith('buy:')) {
      const [, seller, good] = action.split(':')
      if (seller && good) this.marketBuy(seller, good)
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
   * A keepsake given back at the end of a conversation (docs/items/
   * overview.md, "Returning keepsakes"): the thanks wait for the server's
   * yes — the return is a keyed mutation, and a refusal leaves the keepsake
   * with you and says so. On a yes the resident speaks their thanks and the
   * paper's own toast marks the find.
   */
  private returnKeepsake(def: string, target: string): void {
    const items = itemsFor(this.session)
    void items.returnKeepsake(def, target).then((r) => {
      if (!this.sys.isActive()) return
      if (!r.ok) {
        bus.emit(EV.toast, { text: r.text, kind: 'error' })
        return
      }
      const returned = r.value.returned ?? def
      const thanks = keepsakeThanks(returned)
      if (thanks.length) {
        bus.emit(EV.dialogue, { id: 'keep-return', speaker: keepsakeSpeaker(target), lines: thanks })
      } else {
        // A keep with no living owner, left at its Echo camp: the echo
        // answers in its own register (the camp's voice once settled).
        const left = echoForKeepsake(returned)
        if (left) {
          bus.emit(EV.dialogue, {
            id: 'echo-keepsake-left',
            speaker: echoCampSpeaker(left.echo.member, echoSettled(this.session.state.flags, left.echo.member)),
            lines: [...left.keep.leave]
          })
          emitResidents(this.session)
        }
      }
      if (r.value.paper) {
        const paper = paperById(r.value.paper)
        if (paper) bus.emit(EV.toast, { text: foundToast(paper), icon: 'scroll', kind: 'gain', gain: { to: 'journal', label: paper.title } })
      }
    })
  }

  private grantHeirloom(id: string): void {
    const items = itemsFor(this.session)
    if (!this.session.link || !(HEIRLOOM_IDS as readonly string[]).includes(id)) return
    // The server measures reach from where you stand: that rides along now,
    // not the spot noted before the conversation opened.
    this.notePosition()
    void items.grantHeirloom(id).then((r) => {
      if (!this.sys.isActive()) return
      if (!r.ok) {
        // The giver says why, in the conversation.
        sayHeirloomRefusal(id as HeirloomId, r.code)
        return
      }
      const h = HEIRLOOMS[id as HeirloomId]
      if (h) bus.emit(EV.toast, { text: h.toast, icon: 'bag', kind: 'gain', gain: { to: 'bag', itemDef: h.id, qty: 1 } })
      emitResidents(this.session)
    })
  }

  /** Buying from a seller (a resident's kitchen door, or the day's market stall). */
  private marketBuy(seller: string, good: string): void {
    const items = itemsFor(this.session)
    if (!this.session.link) return
    // The server checks you stand by the seller: where you stand now rides along.
    this.notePosition()
    void items.buy(seller, good).then((r) => {
      if (!this.sys.isActive()) return
      if (!r.ok) {
        bus.emit(EV.toast, { text: r.text, kind: 'error' })
        return
      }
      // The seller's own words for what changed hands.
      const bought = r.value.bought
      const line = bought ? sellerFor(bought.seller)?.goods.find((g) => g.item === bought.itemDef)?.line : undefined
      if (bought) bus.emit(EV.toast, { text: line ?? `Bought: ${yieldLine([{ itemDef: bought.itemDef, qty: bought.qty }])}.`, icon: 'bag', art: `icon-${bought.itemDef}` })
    })
  }

  private giveAdaOil(): void {
    const items = itemsFor(this.session)
    if (!this.session.link) return
    // Ada checks you stand by her window: where you stand now rides along.
    this.notePosition()
    void items.giveAdaOil().then((r) => {
      if (!this.sys.isActive()) return
      if (!r.ok) {
        bus.emit(EV.toast, { text: r.text, kind: 'error' })
        return
      }
      const count = r.value.adaOilCount ?? countAdaOilGifts(this.session.state.flags)
      if (count >= 3) {
        // The third flask: the spade, offered only if it can be handed over now.
        const beat = heirloomBeat(this.session, 'ada-garden-spade', 'Take Ada’s garden spade')
        if (beat) {
          bus.emit(EV.dialogue, {
            id: 'ada-spade-grant',
            speaker: HEIRLOOMS['ada-garden-spade'].speaker,
            lines: beat.lines,
            choices: beat.choices.length ? [...beat.choices, { text: 'Not yet' }] : undefined
          })
        }
      } else {
        const reply = ADA_OIL_REPLIES[count] ?? ['Good oil for the window. Thank you.']
        bus.emit(EV.dialogue, {
          id: 'ada-oil-thanks',
          speaker: 'Ada',
          lines: [...reply]
        })
      }
    })
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
      if (!this.reducedMotion) cam.zoomTo(this.zoomFor(this.scale.width, this.scale.height), panMs, 'Sine.easeInOut')
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
    const locked = this.session.zeroHpLocked && (safeArea(this.world.areaId) || !!this.room)
    const tx = Math.floor(this.hero.sprite.x / TILE)
    const ty = Math.floor(this.hero.sprite.y / TILE)
    for (const exit of this.world.exits) {
      if (locked && !safeArea(exit.to)) continue
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
    bus.emit(EV.toast, { text: 'The way is overgrown. Brambles and fallen iron-oak — nobody has cleared it yet.', icon: 'map', kind: 'thought' })
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
      const dest = targetChunk ?? parseChunkArea(WILDS_AREA)!
      // Which region the save is in now (over the crossing, or back).
      if (dest.region === OUTER_REGION_ID) state.wildsRegion = OUTER_REGION_ID
      else delete state.wildsRegion
      setActiveWildsRegion(dest.region)
      const epoch = wildsEpoch(dest.region)
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
    if (leavingWilds) delete state.wildsRegion
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
   * Walk into a cottage. The save stays on the homestead's land, on the
   * doorstep, and the scene rebuilds as the room.
   */
  private enterRoom(gate: number, doorstep: { tx: number; ty: number }): void {
    if (this.transitioning) return
    this.transitioning = true
    const state = this.session.state
    state.area = homeArea(gate)
    state.position = { x: (doorstep.tx + 0.5) * TILE, y: (doorstep.ty + 0.5) * TILE }
    this.session.saveSoon()
    this.cameras.main.fade(240, 12, 12, 20, true)
    this.cameras.main.once('camerafadeoutcomplete', () => {
      this.scene.restart({ entry: ROOM_ENTRY, room: { gate, doorstep } })
    })
  }

  /** The map changed under us (the lane grew, land was cleared): rebuild it where we stand. */
  private rebuildArea(): void {
    if (this.transitioning || this.room) return
    this.transitioning = true
    this.session.state.position = { x: Math.round(this.hero.sprite.x), y: Math.round(this.hero.sprite.y) }
    const entry = { tx: Math.floor(this.hero.sprite.x / TILE), ty: Math.floor(this.hero.sprite.y / TILE) }
    this.time.delayedCall(0, () => this.scene.restart({ entry }))
  }

  /**
   * A worked piece leaves open ground (a broken boulder, a dug stump): the
   * tile opens in the solid grid, its run body is split or dropped, and any
   * prop body there goes with it. Scenery-only: regrows on the next visit.
   */
  private clearSolidTile(tx: number, ty: number): void {
    // A prop's own body first (the woods' rocks are props on open ground).
    for (const body of this.solidProps.get(`${tx},${ty}`) ?? []) {
      this.solidGroup.remove(body)
      body.destroy()
    }
    this.solidProps.delete(`${tx},${ty}`)
    if (!this.world.solid[ty]?.[tx]) return
    this.world.solid[ty][tx] = false
    const i = this.solidRuns.findIndex((r) => r.y === ty && tx >= r.x0 && tx <= r.x1)
    if (i >= 0) {
      const run = this.solidRuns.splice(i, 1)[0]
      this.solidGroup.remove(run.body)
      run.body.destroy()
      for (const [x0, x1] of [
        [run.x0, tx - 1],
        [tx + 1, run.x1]
      ] as const) {
        if (x1 < x0) continue
        const body = solidBox(this, (x0 + (x1 - x0 + 1) / 2) * TILE, ty * TILE + TILE / 2, (x1 - x0 + 1) * TILE, TILE)
        this.solidGroup.add(body)
        this.solidRuns.push({ x0, x1, y: ty, body })
      }
    }
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

  /**
   * World pixels to screen pixels. Phones show about 12 tiles across the
   * short side (390×844 and 844×390 both get 2×: one phone, one game,
   * whichever way it's held); from a 600 px short side up, the old rule
   * (the height over 280, in half steps) holds, and the tile count ramps
   * between the two so no size jumps.
   */
  private zoomFor(w: number, h: number): number {
    const short = Math.min(w, h)
    if (short >= 600) return Phaser.Math.Clamp(Math.round((h / 280) * 2) / 2, 1.5, MAX_SCREEN_SCALE)
    const tiles = 12 + (Phaser.Math.Clamp(short, 440, 600) - 440) * (5.5 / 160)
    return Phaser.Math.Clamp(Math.round((short / (tiles * TILE)) * 2) / 2, 1.5, MAX_SCREEN_SCALE)
  }

  private applyZoom(w: number, h: number): void {
    this.cameras.main.setZoom(this.zoomFor(w, h))
    this.frameCamera()
  }

  /** What the camera was last framed for (playInsets.rev, zoom, size). */
  private framedFor = ''
  private followOffset = { x: 0, y: 0 }
  private edgeFade: Phaser.GameObjects.Image[] = []

  /**
   * Fit the camera to the map and to the screen the interface leaves open
   * (src/game/viewport.ts): the bounds reach past each map edge by the
   * inset there, and the follow offset centres the hero in the open
   * rectangle. Near an edge the map scrolls a little into the backdrop and
   * the hero stays clear of the HUD and the thumbs. A map smaller than the
   * open rectangle (a cottage room) sits centred in it.
   */
  private frameCamera(): void {
    const cam = this.cameras.main
    const z = cam.zoom
    const W = cam.width
    const H = cam.height
    this.framedFor = `${playInsets.rev}:${z}:${W}x${H}`
    // Leave at least 40% of the view open on each axis: past that, both
    // insets on the axis shrink in proportion.
    const fit = (a: number, b: number, view: number): [number, number] => {
      const k = Math.min(1, (view * 0.6) / Math.max(1, a + b))
      return [a * k, b * k]
    }
    const [left, right] = fit(playInsets.left, playInsets.right, W)
    const [top, bottom] = fit(playInsets.top, playInsets.bottom, H)
    const axis = (size: number, view: number, a: number, b: number): [number, number] => {
      const open = (view - a - b) / z
      if (size >= open) return [-a / z, size + (a + b) / z]
      return [-a / z - (open - size) / 2, view / z]
    }
    const [bx, bw] = axis(this.world.widthPx, W, left, right)
    const [by, bh] = axis(this.world.heightPx, H, top, bottom)
    cam.setBounds(bx, by, bw, bh)
    this.followOffset = { x: (left - right) / (2 * z), y: (top - bottom) / (2 * z) }
    cam.setFollowOffset(this.followOffset.x, this.followOffset.y)
    this.layEdgeFade(left || right || top || bottom ? 1 : 0)
  }

  /** Re-frame when the insets, the zoom or the size changed (cheap: one string compare a frame). */
  private keepFramed(): void {
    const cam = this.cameras.main
    if (this.framedFor !== `${playInsets.rev}:${cam.zoom}:${cam.width}x${cam.height}`) this.frameCamera()
    // startFollow elsewhere (placement, the lantern beat) resets the offset.
    else if (cam.followOffset.x !== this.followOffset.x || cam.followOffset.y !== this.followOffset.y) cam.setFollowOffset(this.followOffset.x, this.followOffset.y)
  }

  /**
   * A soft shadow just inside the map's edges, so where the camera shows the
   * backdrop past an edge the map ends in a fade, not a hard line.
   */
  private layEdgeFade(alpha: number): void {
    if (!this.textures.exists('edge-fade')) {
      const t = this.textures.createCanvas('edge-fade', 1, 16)!
      const ctx = t.getContext()
      const g = ctx.createLinearGradient(0, 0, 0, 16)
      g.addColorStop(0, 'rgba(36,31,49,0.6)')
      g.addColorStop(1, 'rgba(36,31,49,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 1, 16)
      t.refresh()
    }
    if (this.edgeFade.length === 0) {
      const mw = this.world.widthPx
      const mh = this.world.heightPx
      const D = 10
      const mk = (x: number, y: number, w: number, angle: number) =>
        this.add.image(x, y, 'edge-fade').setOrigin(0.5, 0).setDisplaySize(w, D).setAngle(angle).setDepth(6000)
      this.edgeFade = [
        mk(mw / 2, 0, mw, 0), // top: dark at the edge, fading down
        mk(mw / 2, mh, mw, 180),
        mk(0, mh / 2, mh, -90),
        mk(mw, mh / 2, mh, 90)
      ]
    }
    for (const img of this.edgeFade) img.setAlpha(alpha)
  }

  // ------------------------------------------------------------- world upkeep

  private updateDiscoveries(): void {
    for (const spot of this.world.discoverySpots) {
      const d = Math.hypot(this.hero.sprite.x - (spot.tx * TILE + 8), this.hero.sprite.y - 8 - (spot.ty * TILE + 8))
      if (d < 24) this.session.recordDiscovery(spot.id, spot.label)
    }
  }
}
