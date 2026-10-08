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
import { buildGround } from '../area/terrain'
import { buildSolids, clearSolidTile, type Solids } from '../area/collision'
import { buildProps } from '../area/props'
import { TileArt } from '../area/tile-art'
import { buildForeground, updateOccluders as updateAreaOccluders, type Occluder } from '../area/foreground'
import { buildExitSigns } from '../area/exits'
import { lanternRestRate, refreshLanternVisuals, type LightProp } from '../area/lanterns'
import { bus, EV, listen, type DialogueClosedPayload, type RelocatePayload } from '../events'
import { prefersReducedMotion } from '../sfx'
import { heroScreen, uiBlocked, uiState } from '../input'
import { canvasRatio } from '../viewport'
import { TILE, tileAt, tileCenter, tileMid } from '../../lib/tile'
import type { Session } from '../session'
import { hasAreaKind, type WorldData } from '../worlds'
import { maybeNudgePip } from '../nudges' // P1 onboarding
import { AvatarVisual } from '../entities/avatar'
import { Hero } from '../entities/hero'
import { EnemySystem } from '../entities/enemies'
import { Projectiles } from '../entities/projectiles'
import { Interactables } from '../entities/interactables'
import { WorldTalk } from '../entities/world-talk'
import { PaperPickups } from '../entities/papers'
import { ItemPickups } from '../entities/item-pickups'
import { Gathering } from '../entities/gathering'
import { RepairsLayer } from '../entities/repairs'
import { OffHandVisual } from '../entities/off-hand'
import { Effects } from '../entities/fx'
import { Npcs } from '../entities/npcs'
import { createRemotePlayers, type RemotePlayers } from '../entities/remote-players'
import { Thoughts } from '../entities/thoughts'
import { presence } from '../presence'
import { presenceAreaFor } from '../../lib/presence-client'
import { HomesteadLayer } from '../entities/homesteads'
import { emitResidents } from '../residents'
import { villageFor } from '../village'
import { VillageLayer } from '../entities/village-life'
import { Touches } from '../entities/touches'
import { ROOM_ENTRY, homeRoomArea, parseHomeRoom } from '../cottage'
import { parseHomeArea } from '../../lib/homestead'
import { homeLights } from '../../lib/homestead-land'
import { homesteadsFor } from '../homestead'
import { prepareHomeLand } from '../homeland'
import { isSafeArea } from '../../lib/habitica/sync'
import {
  OUTER_REGION_ID,
  WILDS_AREA,
  fromRegionPosition,
  inRegion,
  isWildsArea,
  parseChunkArea,
  regionOfState,
  toRegionPosition,
  wildsArrivalPosition,
  wildsReturnTile,
} from '../wilds/regions'
import { prepareWilds, setActiveWildsRegion, wildsEpoch } from '../wilds/store'
import { GoalGuide } from '../entities/goal-guide'
import { heldNow } from '../held'
import { goalTarget } from '../guide-pin'
import { QUEST_ACTION } from '../../content/quests/index.ts'
import { LIBRARY_ACTION } from '../../content/residents.ts'
import { openLibrary } from '../library-open.ts'
import { WildsEntities } from '../wilds/entities'
import { setSyncSafety } from '../sync-safety'
import { onSceneEnd } from '../scene-end'
import { exposeWorldHooks } from './world-dev-hooks'
import { Unmoored } from '../entities/unmoored'
import { WorldActions } from './world-actions'
import { emitPortraits } from '../portraits'
import { WorldCamera } from './world-camera'
import { Turning } from './world-turning'
import { playLanternBeat } from '../entities/lantern-beat'
import { WorldControls } from './world-controls'
import { presenceMoments } from '../entities/presence-moments'
import { arrive } from './world-arrival'
import { buildRoomArt, type RoomArt } from '../area/room-art'
import { RoomSpots, LAMP_MARK, LIBRARY } from '../room-spots'
import { ResidentCycle, residentIn } from '../resident-cycle'
import { Doors } from '../entities/doors'
import { HouseLights } from '../entities/house-lights'
import { PipWalkOn } from '../entities/pip-walk-on'
import { facingFor, roomArrival } from '../room-kind'
import { tileKey } from '../../lib/tile'

interface SceneData {
  entry?: { tx: number; ty: number }
  /** Which way the hero faces arriving (through a door or up a stair: away from where they came in). */
  facing?: { x: number; y: number }
  fromDefeat?: boolean
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
  /** Collisions for terrain tiles and prop footprints (area/collision; a cleared tile opens). */
  private solids!: Solids
  /** Tile-anchored sprites (a felled tree removes its own). */
  private tileArt = new TileArt<Phaser.GameObjects.Image>()
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
  /** Keys, the belt and the mouse (./world-controls.ts). */
  private controls!: WorldControls
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
  /** A village room's art and lights (null outdoors and in a cottage). */
  private roomArt: RoomArt | null = null
  /** The residents on their hour (../resident-cycle.ts), and the lit windows outside. */
  private cycle: ResidentCycle | null = null
  private houseLights: HouseLights | null = null
  /** Pip running up with Mara's message (the opening). */
  private pipWalkOn: PipWalkOn | null = null
  /** Which way to face arriving (SceneData.facing). */
  private pendingFacing: { x: number; y: number } | null = null

  constructor() {
    super('World')
  }

  init(data: SceneData): void {
    this.transitioning = false
    this.holdingFade = false
    this.fadeHold++
    this.pendingEntry = data?.entry ?? null
    this.pendingDefeatToast = data?.fromDefeat === true
    this.pendingFacing = data?.facing ?? null
    this.pendingTurned = data?.turned === true
  }

  /** The scene was rebuilt by a live Turning (show what happened). */
  private pendingTurned = false
  /** The outer Wilds shifting under you (./world-turning.ts). */
  private turning!: Turning

  private pendingEntry: { tx: number; ty: number } | null = null
  private pendingDefeatToast = false
  /** Zoom and framing (./world-camera.ts). */
  private camera!: WorldCamera
  /** The drift's sway (entities/unmoored.ts). */
  private unmoored!: Unmoored
  /** What a conversation's chosen action does (./world-actions.ts). */
  private actions!: WorldActions

  create(): void {
    this.session = this.registry.get('session') as Session
    const state = this.session.state
    const arrival = arrive(this.session, { entry: this.pendingEntry, turned: this.pendingTurned })
    this.pendingEntry = arrival.entry
    this.world = arrival.world
    const wildsEntry = arrival.wildsEntry
    const turnedAway = arrival.turnedAway
    this.wilds = null
    this.occluders = []
    this.cinematic = false
    this.captureReleased = false
    this.reducedMotion = prefersReducedMotion()
    this.fx = new Effects(this, this.reducedMotion)
    this.unmoored = new Unmoored(this, { session: this.session, world: this.world, reducedMotion: this.reducedMotion })

    // Area construction from WorldData (a new area kind is data + a small
    // builder — see the registry in src/game/worlds.ts).
    const groundPainting = buildGround(this, this.world)
    const solids = buildSolids(this, this.world)
    this.solids = solids
    this.tileArt = new TileArt()
    const props = buildProps(this, this.world, solids.group, this.tileArt)
    this.lightProps = props.lights
    // The foreground (canopies that fade) is built before anything can fell a
    // piece: a felling replayed for this stay (Gathering) takes its canopy too.
    this.occluders = buildForeground(this, this.world, this.tileArt)

    // Entities
    // Everything the action button can be used on registers here (entities/interactables).
    this.interactables = new Interactables(this, { reducedMotion: this.reducedMotion })
    const papers = new PaperPickups(this, { world: this.world, session: this.session, fx: this.fx, reducedMotion: this.reducedMotion, interactables: this.interactables })
    new WorldTalk({ world: this.world, session: this.session, village: villageFor(this.session), interactables: this.interactables, papers })
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
        restRate: () => lanternRestRate(this.lightProps, this.session.state, this.hero.sprite, this.enemies.enemies),
        transitioning: () => this.transitioning,
        cinematic: () => this.cinematic,
        onDefeat: () => this.defeatRecovery()
      },
      wildsEntry ? wildsEntry.tile : this.pendingEntry
    )
    if (this.pendingFacing) this.hero.facing.set(this.pendingFacing.x, this.pendingFacing.y)
    // The save names where the hero really stands from the first frame: a
    // saved spot that's blocked (a fresh game's default, a tile built over)
    // puts the hero on the area's spawn, and until the first position sample
    // a second later any save would still write the old spot.
    const saved = { ...state.position }
    this.notePosition()
    if (Math.hypot(state.position.x - saved.x, state.position.y - saved.y) > 1) this.session.saveSoon()
    // Arriving in another area, or another Wilds region, reaches the server in a report (design 2.2).
    this.session.link?.arrived()
    this.avatar = new AvatarVisual(this, { session: this.session, world: this.world, hero: () => this.hero, reducedMotion: this.reducedMotion })
    this.offHand = new OffHandVisual(this, this.session, () => this.hero, () => this.avatar)
    this.npcs = new Npcs(this, this.world)
    this.interactables.setAway((id) => this.npcs.away(id))
    this.interactables.setGone((id) => this.npcs.gone(id))
    this.projectiles = new Projectiles(this, this.fx, () => this.enemies)
    this.enemies = new EnemySystem(
      this,
      {
        world: this.world,
        session: this.session,
        fx: this.fx,
        reducedMotion: this.reducedMotion,
        solidGroup: this.solids.group,
        hero: () => this.hero
      },
      state
    )
    this.interactables.register(this.enemies, [this.enemies.warden.speakPoint()])
    // Village life (calendar, festivals, notice boards, project changes) everywhere.
    new VillageLayer(this, { world: this.world, session: this.session, reducedMotion: this.reducedMotion, interactables: this.interactables })
    // Small world touches: smell the flowers, sit on a bench, read the signs.
    new Touches({ world: this.world, interactables: this.interactables, hero: () => this.hero, fx: this.fx })
    // Things lying about to pick up (a world's; the server keeps who took what).
    const pickups = new ItemPickups(this, { world: this.world, session: this.session, fx: this.fx, reducedMotion: this.reducedMotion, interactables: this.interactables })
    // The workable pieces (trees, boulders, stumps, patches) — wilds chunks,
    // the woods, and homestead land; nowhere else (there's nothing to work).
    this.gathering = new Gathering(this, {
      world: this.world,
      session: this.session,
      fx: this.fx,
      reducedMotion: this.reducedMotion,
      hero: () => this.hero,
      interactables: this.interactables,
      notePosition: () => this.notePosition(),
      clearSolid: (tx, ty) => clearSolidTile(this, this.world, this.solids, tx, ty),
      spritesAt: (tx, ty) => this.tileArt.at(tx, ty),
      fell: (tx, ty) => {
        const gone = this.tileArt.fell(tx, ty)
        if (gone.length) this.occluders = this.occluders.filter((o) => !gone.includes(o.image))
      }
    })
    // The village's broken things, mended with the right part (shared per world).
    const repairs = new RepairsLayer(this, { world: this.world, session: this.session, fx: this.fx, reducedMotion: this.reducedMotion, interactables: this.interactables })
    // Rooms (docs/design/indoors.md 2.7): the front doors out here, and
    // inside a village room its art, light pools and spots.
    new Doors({ world: this.world, interactables: this.interactables, enter: (room) => this.goIn(room) })
    this.roomArt = buildRoomArt(this, this.world, {
      reducedMotion: this.reducedMotion,
      // A resident's hearth is banked while they're out; the library's reading lamp burns once its oil is paid.
      lit: (kind) =>
        kind === 'hearth' ? residentIn(this.world.areaId) : kind === 'lamp' && this.world.areaId === LIBRARY ? this.session.state.flags.includes(LAMP_MARK) : true,
      propState: (art) => (art === 'reading-table' && this.session.state.flags.includes(LAMP_MARK) ? 'lit' : null)
    })
    new RoomSpots({ world: this.world, session: this.session, interactables: this.interactables, hero: () => this.hero, present: (id) => this.npcs.npcs.some((n) => n.id === id && n.present) })
    const homeRoom = parseHomeRoom(this.world.areaId)
    this.homesteads = null
    if (this.world.areaId === 'commons' || parseHomeArea(this.world.areaId) !== null || homeRoom !== null) {
      this.homesteads = new HomesteadLayer(this, {
        world: this.world,
        session: this.session,
        fx: this.fx,
        reducedMotion: this.reducedMotion,
        solidGroup: this.solids.group,
        interactables: this.interactables,
        hero: () => this.hero.sprite,
        sitter: () => this.hero,
        room: homeRoom !== null ? { gate: homeRoom } : null,
        enterRoom: (gate) => this.goIn(homeRoomArea(gate)),
        rebuild: () => this.rebuildArea()
      })
    }
    this.actions = new WorldActions({
      scene: this,
      session: this.session,
      world: this.world,
      fx: this.fx,
      hero: () => this.hero,
      lightProps: () => this.lightProps,
      homesteads: () => this.homesteads,
      wilds: () => this.wilds,
      notePosition: () => this.notePosition(),
      refresh: () => {
        this.refreshMarkers()
        this.interactables.invalidatePrompt()
      }
    })
    buildExitSigns(this, this.world, this.reducedMotion)
    this.physics.add.collider(this.hero.sprite, this.solids.group)
    // The residents stand where their hour puts them; a change you watch is walked.
    const cycle = (this.cycle = new ResidentCycle(this, {
      world: this.world,
      npcs: this.npcs,
      reducedMotion: this.reducedMotion,
      block: (tx, ty, on) => {
        for (const body of this.solids.props.get(tileKey(tx, ty)) ?? []) (body.body as Phaser.Physics.Arcade.StaticBody).enable = on
      },
      onScreen: (x, y) => this.cameras.main.worldView.contains(x, y)
    }))
    const lights = (this.houseLights = new HouseLights(this, { world: this.world, reducedMotion: this.reducedMotion }))
    this.pipWalkOn = new PipWalkOn(this, { world: this.world, npcs: this.npcs, hero: () => this.hero.sprite })
    cycle.onChange(() => {
      this.roomArt?.refresh()
      lights.refresh()
      this.interactables.invalidatePrompt()
    })

    // The Wilds layer: camps, nodes, chests, POIs and lanterns (null in the
    // curated areas). The region read refreshes in the background; entities
    // render from the store and follow its changes.
    if (wildsEntry) {
      this.wilds = new WildsEntities(this, {
        world: this.world,
        session: this.session,
        fx: this.fx,
        enemies: this.enemies,
        reducedMotion: this.reducedMotion,
        interactables: this.interactables,
        hero: () => this.hero.sprite
      })
      void prepareWilds(this.session, 60_000)
    }

    // Arcade's world bounds default to the canvas size, which is larger than
    // small maps — without this the hero can walk off the map edge.
    this.physics.world.setBounds(0, 0, this.world.widthPx, this.world.heightPx)
    this.cameras.main.startFollow(this.hero.sprite, true, 0.12, 0.12)
    this.camera = new WorldCamera(this, this.world)
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
    this.controls = new WorldControls(this, {
      session: this.session,
      hero: () => this.hero,
      avatar: () => this.avatar,
      interactables: this.interactables,
      gathering: () => this.gathering,
      reducedMotion: this.reducedMotion,
      live: () => this.worldLive(),
      act: () => this.handleAction()
    })
    this.events.once('shutdown', () => {
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
    emitPortraits(this)
    const unlisten = listen({
      [EV.quest]: () => this.refreshMarkers(),
      [EV.profileChanged]: () => this.onProfileChanged(),
      [EV.worldRefresh]: () => this.onWorldRefresh(),
      [EV.relocate]: (p) => this.onRelocate(p),
      [EV.notePosition]: () => this.notePosition(),
      [EV.dialogueClosed]: (p) => this.onDialogueClosed(p)
    })
    this.events.once('shutdown', () => {
      unlisten()
      // Epoch bump: in-flight avatar/companion loads must not add objects to a
      // dead scene or fight a rebuilt scene's own composition. Hero combat
      // timing and the avatar's carried state ride out the restart.
      this.hero.carry()
      this.avatar.invalidate()
    })
    // Remote players (phase 6 presence): join this area's room and draw the
    // others in it. A room (a cottage, the mill) is its own presence room.
    const feed = presence()
    this.presenceArea = presenceAreaFor(this.world.areaId)
    feed?.setArea(this.presenceArea)
    this.remotePlayers = createRemotePlayers(this, feed, this.presenceArea)
    this.events.once('shutdown', () => this.remotePlayers.clear())
    presenceMoments(this, { session: this.session, world: this.world, enemies: this.enemies, hero: () => this.hero.sprite })
    this.goalGuide = new GoalGuide(this, {
      world: this.world,
      goal: () => goalTarget(this.session),
      npcAt: (id) => {
        const n = this.npcs.npcs.find((x) => x.id === id)
        return n ? { x: n.sprite.x, y: n.sprite.y - 8 } : null
      },
      spotAt: (id) => {
        const it = this.interactables.list.find((x) => x.id === id)
        return it ? { x: it.x, y: it.y - 8 } : null
      },
      wardenAt: () => {
        const w = this.enemies.warden.wardenView()
        return w.state === 'active' && w.visible ? { x: w.x, y: w.y - 8 } : null
      },
      enemyAt: (id) => {
        const e = this.enemies.enemies.find((x) => x.id === id && !x.dead)
        return e ? { x: e.sprite.x, y: e.sprite.y - 8 } : null
      },
      placeKind: () => this.homesteads?.placeKind ?? null,
      guidePoint: (where) => this.homesteads?.guidePoint(where) ?? null,
      reducedMotion: this.reducedMotion
    })
    // Passing thoughts above the hero (flavour lines; cleans up on shutdown).
    new Thoughts(this, this.hero.sprite, { reducedMotion: this.reducedMotion, hidden: () => this.cinematic, offsetY: -32 })
    void this.avatar.build() // imported layered avatar (if any)

    // Sync safety for the UI's sync gate (src/game/sync-safety.ts), while this scene lives.
    const dropSafety = setSyncSafety(() => {
      const px = this.hero.sprite.x
      const py = this.hero.sprite.y
      return {
        areaId: this.world.areaId,
        transitioning: this.transitioning,
        dialogueOpen: uiState.dialogueOpen,
        enemiesNear: this.enemies.enemies.some((e) => Math.hypot(e.sprite.x - px, e.sprite.y - py) < 200)
      }
    })
    onSceneEnd(this, dropSafety)
    // Playtest hooks (docs/playtest.md), dev builds only.
    if (import.meta.env.DEV) exposeWorldHooks(this, { papers, pickups, repairs })

    if (this.pendingDefeatToast) {
      this.pendingDefeatToast = false
      bus.emit(EV.defeat, { phase: 'woke' })
    }

    // The Turning: an ended epoch (a claim refused, or the clock passing the
    // wick's end while we stand here) shifts the outer Wilds under us.
    this.turning = new Turning(this, {
      session: this.session,
      world: this.world,
      reducedMotion: this.reducedMotion,
      hero: () => this.hero,
      unmoored: this.unmoored,
      moving: () => this.transitioning,
      hold: () => {
        this.transitioning = true
      }
    })
    if (this.pendingTurned || turnedAway) {
      const live = this.pendingTurned
      this.pendingTurned = false
      this.time.delayedCall(600, () => this.turning.note(live))
    }
  }

  // ------------------------------------------------------------- update loop

  /** The scene is stopped for a reload's final save (see update). */
  private reloadHeld = false

  update(time: number, delta: number): void {
    // Saving for a reload (Session.settle): everything stops, physics, timers
    // and tweens included, so no hit, loot or step lands after the final save.
    if (this.session.reloading !== this.reloadHeld) {
      this.reloadHeld = this.session.reloading
      if (this.reloadHeld) {
        this.hero.halt()
        this.physics.world.pause()
        this.tweens.pauseAll()
      } else {
        this.physics.world.resume()
        this.tweens.resumeAll()
      }
      this.time.paused = this.reloadHeld
    }
    if (this.reloadHeld) return
    const dt = Math.min(delta / 1000, 0.05)
    this.camera.keepFramed()
    // The hero's spot on the canvas in CSS px, every frame (panels and
    // transitions too): "hold to walk" steers by it, and title cards keep clear of it.
    const view = this.cameras.main.worldView
    const toCss = this.cameras.main.zoom / canvasRatio()
    heroScreen.x = (this.hero.sprite.x - view.x) * toCss
    heroScreen.y = (this.hero.sprite.y - 8 - view.y) * toCss
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

    this.unmoored.update(time, dt)

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

    this.hero.move(dt, this.controls.vector())
    this.enemies.update(dt)
    this.goalGuide.update(dt, this.hero.sprite, this.worldLive())
    this.projectiles.update(dt)
    this.wilds?.update()
    this.turning.update(dt)
    this.updateDiscoveries()
    this.checkExits()
    maybeNudgePip(this.session, this.world, this.hero.sprite) // P1 onboarding: Pip's one-off gate line
    // One target for the action button: the highest rank in reach (the
    // Wilds' claims, the warden's naming), then the nearest.
    this.interactables.update(this.hero.sprite, this.time.now)
    this.controls.update()
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
    // Not while a move began this frame (an exit, above): the save already
    // names the destination, and this spot belongs to the area being left.
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
    if (this.transitioning) return
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
    const body = this.hero.sprite.body as Phaser.Physics.Arcade.Body
    const moving = !this.transitioning && Math.hypot(body.velocity.x, body.velocity.y) > 5
    feed.position({ x: this.hero.sprite.x, y: this.hero.sprite.y, facing: this.hero.facing, moving })
  }

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

  private handleAction(): void {
    if (uiBlocked() || this.cinematic || this.transitioning || this.homesteads?.placing || performance.now() < uiState.blockedUntil) return
    // Whatever the prompt is on (free activities stay available at zero HP).
    if (this.interactables.activate()) return
    if (this.session.zeroHpLocked) return // too injured to fight; no auto revival
    // A tool in hand swings too, weakly (you're never helpless).
    this.hero.tryAttack({ tool: heldNow().kind !== 'weapon' })
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
    // A refused prediction (a defeat, the warden's settling) shows again.
    this.enemies.reconcile(this.session.state)
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
      this.moveTo({ position: r ? undefined : wildsArrivalPosition(wildsEpoch()), save: false }, {}, { inDark: () => prepareWilds(this.session, 60_000) })
      return
    }
    if (p.area === this.world.areaId) {
      this.hero.sprite.setPosition(p.x, p.y)
      this.hero.sprite.setVelocity(0, 0)
      return
    }
    this.moveTo({ save: false }, {})
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

  // ------------------------------------------------------------- interaction

  private onDialogueClosed(payload: DialogueClosedPayload): void {
    uiState.dialogueOpen = false
    uiState.blockedUntil = performance.now() + 220
    // A quest step's offer (`quest:<quest>:<step>`) or talk (`<quest>:<step>`) is the session's.
    if (payload?.action?.startsWith(QUEST_ACTION)) void this.session.reachRef(payload.action.slice(QUEST_ACTION.length))
    // Elara's shelves and donations (`library:shelf`, `library:donate`): the library panel.
    else if (payload?.action?.startsWith(LIBRARY_ACTION)) openLibrary({ focus: payload.action.slice(LIBRARY_ACTION.length) === 'donate' ? 'donate' : 'shelf' })
    else if (payload?.action) this.actions.apply(payload.action)
    if (payload?.event?.includes(':')) {
      void this.session.reachRef(payload.event)
      return
    }
    const event = payload?.event as QuestEvent | undefined
    if (!event) return
    // The clue is journaled under the shared content id (the step's
    // prediction, reachStep, also carries it, once).
    if (event === 'find-clue') this.session.recordDiscovery('old-route-marker', 'The Closure Mark')
    if (event === 'light-lantern' || event === 'return-village') {
      playLanternBeat(this, {
        event,
        session: this.session,
        lightProps: this.lightProps,
        fx: this.fx,
        hero: this.hero.sprite,
        reducedMotion: this.reducedMotion,
        setCinematic: (on) => {
          this.cinematic = on
        }
      })
      return
    }
    this.session.applyQuestEvent(event)
    refreshLanternVisuals(this, this.lightProps, this.session.questStage, this.session.state)
    if (event === 'find-clue' && this.world.areaId === 'ruin') this.enemies.warden.spawnGuardian(true)
  }

  // ------------------------------------------------------------- transitions

  private checkExits(): void {
    if (this.transitioning) return
    // Zero-HP gates expeditions only from the village; a legacy zero-HP save
    // found outside may travel home freely (nothing heals en route).
    // The Commons counts as home: a hurt hero may walk there to rest.
    const locked = this.session.zeroHpLocked && safeArea(this.world.areaId)
    const tx = tileAt(this.hero.sprite.x)
    const ty = tileAt(this.hero.sprite.y)
    for (const exit of this.world.exits) {
      if (locked && !safeArea(exit.to)) continue
      if (tx >= exit.tx && tx < exit.tx + exit.tw && ty >= exit.ty && ty < exit.ty + exit.th) {
        if (!canEnter(exit.to)) {
          this.overgrown(exit)
          return
        }
        // Out through a doorway or up a stair: arrive facing on, away from it.
        this.transitionTo(exit.to, exit.entry, exit.side && exit.kind && exit.kind !== 'edge' ? facingFor({ side: exit.side, kind: exit.kind }) : undefined)
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

  private transitionTo(area: AreaId, entry: { tx: number; ty: number }, facing?: { x: number; y: number }): void {
    if (!canEnter(area)) return
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
            return { tx: tileAt(r.x), ty: tileAt(r.y) }
          })()
      const position = targetChunk ? toRegionPosition(dest.cx, dest.cy, tileMid(entry.tx), tileMid(entry.ty)) : wildsArrivalPosition(epoch)
      // The region must be loaded before the chunk builds (shared epoch).
      this.moveTo({ area: WILDS_AREA, position }, { entry: arrivalTile }, { inDark: () => prepareWilds(this.session, 60_000) })
      return
    }
    if (leavingWilds) delete state.wildsRegion
    if (leavingWilds && area === 'commons') {
      // The agreed handoff: back through the north arch.
      const tile = wildsReturnTile()
      entry = { tx: tile.tx, ty: tile.ty }
    }
    // A homestead's land is the server's: fetched while the screen is dark.
    this.moveTo({ area, position: tileCenter(entry.tx, entry.ty) }, { entry, ...(facing ? { facing } : {}) }, { inDark: () => prepareHomeLand(String(area)) })
  }

  /**
   * Go in at a front door (a village room, or a cottage): an ordinary area
   * change into the room, arriving at its `@` facing in.
   */
  private goIn(room: string): void {
    if (this.transitioning) return
    const entry = parseHomeRoom(room) !== null ? ROOM_ENTRY : roomArrival(room)
    if (!entry) return
    this.transitionTo(room, entry, { x: 0, y: -1 })
  }

  /** The map changed under us (the lane grew, land was cleared): rebuild it where we stand. */
  private rebuildArea(): void {
    if (this.transitioning) return
    const entry = { tx: tileAt(this.hero.sprite.x), ty: tileAt(this.hero.sprite.y) }
    this.moveTo({ position: { x: Math.round(this.hero.sprite.x), y: Math.round(this.hero.sprite.y) }, save: false }, { entry }, { fadeMs: null })
  }

  /**
   * Defeat: a short collapse beat, then wake at the village well. In the
   * Wilds the defeat is reported first (a fallen-hero lantern), before
   * recovery touches vitals.
   */
  private defeatRecovery(): void {
    // Tell the UI first: it holds the bars while the hero collapses, then
    // shows the recovered vitals once the screen is dark.
    bus.emit(EV.defeat, { phase: 'falling' })
    // Connected, the fall is one operation from where the hero fell (sampled
    // now, not a second ago); in the Wilds its answer places the lantern.
    this.notePosition()
    this.session.defeat()
    this.hero.sprite.setVelocity(0, 0)
    this.tweens.add({ targets: this.avatar.container ?? this.hero.sprite, scaleY: (this.avatar.container ?? this.hero.sprite).scaleY * 0.6, duration: 380, ease: 'Quad.easeIn' })
    this.hero.sprite.setTint(0x8a7a9a)
    // The scene wakes once the fall is queued and its recovery shown.
    this.moveTo({ save: false }, { fromDefeat: true }, { fadeMs: 1100, inDark: () => this.session.falling ?? undefined })
  }

  /**
   * Leave this build of the scene: the save says where to (and is saved
   * soon, unless `save` is false), the screen fades, and the scene restarts
   * with `data`. `inDark` runs once the screen is dark (loading the Wilds
   * region); a promise holds the restart until it settles. `fadeMs: null`
   * restarts on the next tick without a fade (a rebuild in place).
   */
  private moveTo(
    to: { area?: AreaId; position?: { x: number; y: number }; save?: boolean },
    data: SceneData,
    opts: { fadeMs?: number | null; inDark?: () => unknown } = {}
  ): void {
    this.transitioning = true
    const state = this.session.state
    if (to.area !== undefined) state.area = to.area
    if (to.position) state.position = to.position
    if (to.save ?? true) this.session.saveSoon()
    const go = () => {
      const pending = opts.inDark?.()
      if (pending instanceof Promise) void pending.finally(() => this.scene.restart(data))
      else this.scene.restart(data)
    }
    const fadeMs = opts.fadeMs === undefined ? 240 : opts.fadeMs
    if (fadeMs === null) {
      this.time.delayedCall(0, go)
      return
    }
    // force: a fade-in still running (scene just started) must not swallow
    // this fade, or 'camerafadeoutcomplete' never fires and we soft-lock.
    this.cameras.main.fade(fadeMs, 12, 12, 20, true)
    this.cameras.main.once('camerafadeoutcomplete', go)
  }

  // ------------------------------------------------------------- world upkeep

  private updateDiscoveries(): void {
    for (const spot of this.world.discoverySpots) {
      const d = Math.hypot(this.hero.sprite.x - tileMid(spot.tx), this.hero.sprite.y - 8 - tileMid(spot.ty))
      if (d < 24) this.session.recordDiscovery(spot.id, spot.label)
    }
  }
}
