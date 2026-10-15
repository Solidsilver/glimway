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
import { clearMapPosition, publishMapPosition } from '../map-position'
import { canvasRatio } from '../viewport'
import { TILE, tileAt, tileCenter, tileMid } from '../../lib/tile'
import type { Session } from '../session'
import { hasAreaKind, type WorldData } from '../worlds'
import { maybeNudgePip } from '../nudges' // P1 onboarding
import { heldNow } from '../held'
import { AvatarVisual } from '../entities/avatar'
import { Petting } from '../entities/petting'
import { Hero } from '../entities/hero'
import { EnemySystem } from '../entities/enemies'
import { Projectiles } from '../entities/projectiles'
import { Interactables } from '../entities/interactables'
import { WorldTalk } from '../entities/world-talk'
import { PaperPickups } from '../entities/papers'
import { ItemPickups } from '../entities/item-pickups'
import { Gathering } from '../entities/gathering'
import { Fishing, fishingPose } from '../entities/fishing'
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
import { commonsLane, fixedPlaceOf } from '../wilds/fixed'
import { FixedLife } from '../wilds/fixed-life'
import { isSafeArea } from '../../lib/habitica/sync'
import { fingerInBracken } from '../../lib/quests'
import { OUTDOORS_AREA, isWildsArea, chunkOfPixel, chunkKey } from '../wilds/coords'
import { contentPosition } from '../../lib/location'
import { holdOnSafe, stopAtEdge } from '../safe-barrier'
import { prepareWilds } from '../wilds/store'
import { WildsWindow } from '../wilds/window'
import { waitingFixedAt } from '../wilds/wilds-world'
import { WildsPaths } from '../wilds/paths'
import { WildsMarks } from '../wilds/marks'
import { watchRumour } from '../rumour-watch'
import { loadWilds } from '../../lib/wilds/data'
import { displayArea, setWildsLand } from '../../content/world'
import { landName } from '../wilds/ground-view'
import { GoalGuide } from '../entities/goal-guide'
import { goalTarget } from '../guide-pin'
import { QUEST_ACTION } from '../../content/quests/index.ts'
import { LIBRARY_ACTION } from '../../content/residents.ts'
import { openLibrary } from '../library-open.ts'
import { WildsEntities } from '../wilds/entities'
import { enemiesNearForSync, setSyncSafety } from '../sync-safety'
import { onSceneEnd } from '../scene-end'
import { exposeWorldHooks } from './world-dev-hooks'
import { playHold, runFrame, type WorldFrame } from './world-frame'
import { perfWatch } from '../perf'
import { Unmoored } from '../entities/unmoored'
import { WorldActions } from './world-actions'
import { emitPortraits } from '../portraits'
import { isYardRoom } from '../yard-talk'
import { WorldCamera } from './world-camera'
import { Turning } from './world-turning'
import { playLanternBeat } from '../entities/lantern-beat'
import { WorldControls, swingHeld } from './world-controls'
import { presenceMoments } from '../entities/presence-moments'
import { arrive } from './world-arrival'
import { buildRoomArt, type RoomArt } from '../area/room-art'
import { RoomSpots, LAMP_MARK, LIBRARY, spotWanted } from '../room-spots'
import { ResidentCycle, residentIn, residentPlace } from '../resident-cycle'
import { elaraDeskState, hoistState, spongeBowlState } from '../prop-states'
import { Doors } from '../entities/doors'
import { HouseLights } from '../entities/house-lights'
import { PipWalkOn } from '../entities/pip-walk-on'
import { facingFor, roomArrival, warmAt, type Footprint } from '../room-kind'
import { tileKey } from '../../lib/tile'

interface SceneData {
  entry?: { tx: number; ty: number }
  /** Which way the hero faces arriving (through a door or up a stair: away from where they came in). */
  facing?: { x: number; y: number }
  fromDefeat?: boolean
  /** Rebuilt after a Turning (kept for the scripted beats; the open map turns in place). */
  turned?: boolean
}

/** Keyboard focus is on a control in the placement tray. */
function trayFocused(): boolean {
  const el = typeof document !== 'undefined' ? document.activeElement : null
  return !!el && el !== document.body && !!el.closest?.('[data-testid="placement-tray"]')
}

/** Areas where the zero-HP lock still lets you walk (home to rest): the village, the Commons, homesteads. */
const safeArea = (area: string, x: number, y: number) => isSafeArea(area, { x, y })

/** Can the scene go here? Every registered area (the open map, `outdoors`, among them). */
function canEnter(area: string): boolean {
  return hasAreaKind(area)
}

export class WorldScene extends Phaser.Scene {
  private session!: Session
  private world!: WorldData
  private fx!: Effects
  private remotePlayers!: RemotePlayers
  private petting!: Petting
  /** Wilds entities for the open map's attached chunks (null in curated areas). */
  private wilds: WildsEntities | null = null
  /** The open map's moving window (null in curated areas): src/game/wilds/window.ts. */
  private window: WildsWindow | null = null
  /** Clearing, laying and lifting paths on the open map (null in curated areas). */
  private paths: WildsPaths | null = null
  /** Way signs, finders' names and first finds on the open map (null in curated areas). */
  private marks: WildsMarks | null = null
  /** The drift's line is said once a scene build (open-map.md 2.6). */
  private driftSaid = false
  /** Which of the open map's places the HUD names now. */
  private shownPlace = ''
  /** Collisions for terrain tiles and prop footprints (area/collision; a cleared tile opens). */
  private solids!: Solids
  /** Tile-anchored sprites (a felled tree removes its own). */
  private tileArt = new TileArt<Phaser.GameObjects.Image>()
  /** Gathering: the workable pieces of this area (null where there are none). */
  private gathering: Gathering | null = null
  /** Fishing: the banks of this area's waters (the mill pond; null where there are none). */
  private fishing: Fishing | null = null
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
  /** Dev: waypoints (world px) the hero walks through, as if steered (the open map's walking playtest). */
  private devWalk: { x: number; y: number }[] | null = null
  /** This area's presence room (null where presence doesn't reach). */
  private presenceArea: string | null = null
  /** The Commons/cottage homestead layer (null elsewhere). */
  private homesteads: HomesteadLayer | null = null
  /** A village room's art and lights (null outdoors and in a cottage). */
  private roomArt: RoomArt | null = null
  /** The signpost's lost east finger, lying where the finger-wisp sits (Brackenwood, the opening). */
  private finger: Phaser.GameObjects.Image | null = null
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
    const arrival = arrive(this.session, { entry: this.pendingEntry })
    this.pendingEntry = arrival.entry
    this.world = arrival.world
    const open = this.world.open
    this.wilds = null
    this.window = null
    this.paths = null
    this.marks = null
    this.driftSaid = false
    this.occluders = []
    this.cinematic = false
    this.safeSpot = null
    this.fixedSpot = null
    this.fixedWait = 0
    this.commonsWaitSaid = false
    this.captureReleased = false
    this.reducedMotion = prefersReducedMotion()
    this.fx = new Effects(this, this.reducedMotion)
    this.unmoored = new Unmoored(this, { session: this.session, world: this.world, reducedMotion: this.reducedMotion, hero: () => this.hero?.sprite ?? { x: 0, y: 0 } })

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
    const talk = new WorldTalk({ world: this.world, session: this.session, village: villageFor(this.session), interactables: this.interactables, papers })
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
        warm: () => warmAt(this.world, this.hero.sprite.x, this.hero.sprite.y),
        transitioning: () => this.transitioning,
        cinematic: () => this.cinematic,
        onDefeat: () => this.defeatRecovery()
      },
      this.pendingEntry
    )
    this.waitingFixed = !!open && waitingFixedAt(this.hero.sprite.x, this.hero.sprite.y)
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
    this.avatar = new AvatarVisual(this, { session: this.session, world: this.world, hero: () => this.hero, reducedMotion: this.reducedMotion, live: () => this.worldLive(), baySpot: (mount) => this.homesteads?.baySpot(mount) ?? null })
    this.offHand = new OffHandVisual(this, this.session, () => this.hero, () => this.avatar)
    this.npcs = new Npcs(this, this.world, open ? this.solids.group : undefined)
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
    const village = new VillageLayer(this, { world: this.world, session: this.session, reducedMotion: this.reducedMotion, interactables: this.interactables, schedule: (job) => this.window?.builds.add(job), unschedule: (job) => this.window?.builds.drop(job) })
    // Small world touches: smell the flowers, sit on a bench, read the signs.
    const touches = new Touches({ world: this.world, interactables: this.interactables, hero: () => this.hero, fx: this.fx })
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
      clearSolid: (tx, ty) => (this.window ? this.window.clearSolid(tx, ty) : clearSolidTile(this, this.world, this.solids, tx, ty)),
      spritesAt: (tx, ty) => this.tileArt.at(tx, ty),
      fell: (tx, ty) => {
        const gone = this.tileArt.fell(tx, ty)
        if (gone.length) this.occluders = this.occluders.filter((o) => !gone.includes(o.image))
      }
    })
    // The banks of this area's waters (docs/design/crafts.md 5): the mill pond.
    this.fishing = new Fishing(this, {
      world: this.world,
      session: this.session,
      fx: this.fx,
      reducedMotion: this.reducedMotion,
      hero: () => this.hero,
      interactables: this.interactables,
      notePosition: () => this.notePosition(),
      live: () => this.worldLive()
    })
    // The village's broken things, mended with the right part (shared per world).
    const repairs = new RepairsLayer(this, { world: this.world, session: this.session, fx: this.fx, reducedMotion: this.reducedMotion, interactables: this.interactables })
    // Rooms (docs/design/indoors.md 2.7): the front doors out here, and
    // inside a village room its art, light pools and spots.
    new Doors({ world: this.world, interactables: this.interactables, enter: (room) => this.goIn(room) })
    // A spot on the piece, or on the floor just in front of it, that the current quest marks.
    const pointed = (f: Footprint) =>
      Object.entries(this.world.room?.def.spots ?? {}).some(
        ([id, s]) => s.tx >= f.tx && s.tx < f.tx + f.tw && s.ty >= f.ty && s.ty <= f.ty + f.th && spotWanted(id, this.session)
      )
    this.roomArt = buildRoomArt(this, this.world, {
      reducedMotion: this.reducedMotion,
      // A resident's hearth is banked while they're out; the reading lamp (on the library's table) burns once its oil is paid.
      lit: (light) => {
        if (light.kind === 'hearth') return residentIn(this.world.areaId)
        const table = this.world.areaId === LIBRARY ? this.world.room?.props.find((p) => p.art === 'reading-table') : undefined
        const onTable = !!table && light.tx >= table.tx && light.tx < table.tx + table.tw && light.ty >= table.ty && light.ty < table.ty + table.th
        return !onTable || this.session.state.flags.includes(LAMP_MARK)
      },
      propState: (f) => this.pieceState(f, pointed),
      pointed
    })
    new RoomSpots({ world: this.world, session: this.session, interactables: this.interactables, hero: () => this.hero, present: (id) => this.npcs.npcs.some((n) => n.id === id && n.present) })
    const homeRoom = parseHomeRoom(this.world.areaId)
    this.homesteads = null
    // On the open map, the Commons lane: built once its chunks are here (they come with the Wilds' read).
    const lane = open ? commonsLane() : null
    if (lane || homeRoom !== null || isYardRoom(this.world.areaId)) this.homesteads = this.homesteadLayer(lane, homeRoom)
    else if (open) {
      // The Commons' chunks came after this build began (a first visit): the lane joins in then.
      const late = () => {
        const lane = commonsLane()
        if (!lane || this.homesteads) return
        this.homesteads = this.homesteadLayer(lane, null)
        this.window?.fixturesReady()
      }
      bus.on(EV.fixedReady, late)
      this.events.once('shutdown', () => bus.off(EV.fixedReady, late))
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
      paths: () => this.paths,
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
        this.npcs.block(tx, ty, on)
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

    // The open map: camps, nodes, chests, POIs, lanterns and sites in the
    // attached chunks, and the window that attaches them as the hero walks
    // (null in the curated areas). Entities render from the store.
    let windowReady: Promise<void> | null = null
    if (open) {
      const wilds = (this.wilds = new WildsEntities(this, {
        session: this.session,
        fx: this.fx,
        enemies: this.enemies,
        reducedMotion: this.reducedMotion,
        interactables: this.interactables,
        hero: () => this.hero.sprite
      }))
      const fixedLife = new FixedLife({ world: this.world, npcs: this.npcs, cycle, talk, pickups, papers, repairs, touches, village, fishing: this.fishing ?? undefined, pip: this.pipWalkOn ?? undefined, homes: () => this.homesteads?.fixedHooks ?? null, lights })
      this.window = new WildsWindow({
        scene: this,
        session: this.session,
        solids: this.solids.group,
        tileArt: this.tileArt,
        gathering: () => this.gathering,
        entities: wilds,
        occluders: {
          add: (list) => this.occluders.push(...list),
          remove: (images) => {
            const gone = new Set<Phaser.GameObjects.Image>(images)
            this.occluders = this.occluders.filter((o) => !gone.has(o.image))
          }
        },
        reducedMotion: this.reducedMotion,
        hero: () => this.hero.sprite,
        interactables: this.interactables,
        enter: (room) => this.goIn(room),
        hooks: () => fixedLife
      })
      // ?perf=1 samples the open map's display list and tweens (src/game/perf.ts).
      perfWatch(this)
      this.events.once('shutdown', () => perfWatch(null))
      // The HUD names the land you stand in (the meadow, the Wend) from the loaded chunks.
      setWildsLand(landName)
      this.events.once('shutdown', () => setWildsLand(null))
      this.paths = new WildsPaths(this, {
        session: this.session,
        interactables: this.interactables,
        fx: this.fx,
        reducedMotion: this.reducedMotion,
        hero: () => this.hero,
        notePosition: () => this.notePosition(),
        live: () => this.worldLive()
      })
      this.marks = new WildsMarks(this, {
        session: this.session,
        interactables: this.interactables,
        fx: this.fx,
        reducedMotion: this.reducedMotion,
        hero: () => this.hero.sprite,
        notePosition: () => this.notePosition()
      })
      // The first window is painted behind the fade (the near read and its
      // chunks came in before this build: prepareWilds).
      this.window.update(0)
      this.window.settle()
      windowReady = this.window.ready()
    }

    // Arcade's world bounds default to the canvas size, which is larger than
    // small maps — without this the hero can walk off the map edge. On the
    // open map they are the frontier (open-map.md 2.6): the drift is solid.
    if (open) this.physics.world.setBounds(open.bounds.x, open.bounds.y, open.bounds.w, open.bounds.h)
    else this.physics.world.setBounds(0, 0, this.world.widthPx, this.world.heightPx)
    this.cameras.main.startFollow(this.hero.sprite, true, 0.12, 0.12)
    this.camera = new WorldCamera(this, this.world)
    // A first visit paints the ground's transitions off the main thread
    // (src/game/area/terrain.ts): stay dark until they're in (a second at
    // most), so the area never shows without its edges.
    const holding = groundPainting ?? windowReady
    if (holding) {
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
      void holding.then(show, show)
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
      clearMapPosition(this)
      // A restart mid-beat must never leave the HUD hidden and input blocked.
      if (this.cinematic) {
        this.cinematic = false
        bus.emit(EV.cinematic, { active: false })
      }
      this.input.keyboard?.enableGlobalCapture()
    })

    this.session.emitArea()
    this.shownPlace = displayArea(this.session.state)
    this.session.emitStats()
    this.session.emitQuest()
    emitResidents(this.session)
    this.session.startAutosave()
    refreshLanternVisuals(this, this.lightProps, this.session.questStage, this.session.state)
    this.interactables.buildMarkers()
    // A restarted scene starts with nothing drawn (the old image went with the old build).
    this.finger = null
    this.drawFinger()
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
    this.presenceArea = presenceAreaFor(this.world.areaId, { x: this.hero.sprite.x, y: this.hero.sprite.y })
    feed?.setArea(this.presenceArea)
    this.remotePlayers = createRemotePlayers(this, feed, this.presenceArea, false, this.reducedMotion)
    this.events.once('shutdown', () => this.remotePlayers.clear())
    // Pet a pet (crafts.md 2.1): your follower, friends' and the yard's.
    this.petting = new Petting(
      this,
      this.interactables,
      this.reducedMotion,
      () => [
        ...(this.avatar.follower ? [{ id: 'mine', x: this.avatar.follower.x, y: this.avatar.follower.y, hop: () => this.avatar.follower?.hop() }] : []),
        ...this.remotePlayers.pets(),
        ...(this.homesteads?.petPoints() ?? [])
      ],
      // The prompt offers the pet only with empty hands (src/lib/pet-gating.ts).
      () => heldNow().kind
    )
    presenceMoments(this, { session: this.session, world: this.world, enemies: this.enemies, hero: () => this.hero.sprite })
    this.goalGuide = new GoalGuide(this, {
      world: this.world,
      position: () => this.hero.sprite,
      exits: () => this.window?.exits() ?? [],
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
        return e ? { x: e.x, y: e.y - 8 } : null
      },
      lootAt: (enemy) => (enemy === 'finger-wisp' && this.finger ? { x: this.finger.x, y: this.finger.y - 3 } : null),
      marked: (id) => this.interactables.list.some((x) => x.id === id && x.marker?.() === 'quest'),
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
        position: { x: px, y: py },
        safe: isSafeArea(this.world.areaId, { x: px, y: py }),
        transitioning: this.transitioning,
        dialogueOpen: uiState.dialogueOpen,
        enemiesNear: enemiesNearForSync(this.world.areaId, { x: px, y: py }, this.enemies.enemies)
      }
    })
    onSceneEnd(this, dropSafety)
    // Playtest hooks (docs/playtest.md), dev builds only.
    if (import.meta.env.DEV) exposeWorldHooks(this, { papers, pickups, repairs })

    if (this.pendingDefeatToast) {
      this.pendingDefeatToast = false
      bus.emit(EV.defeat, { phase: 'woke' })
    }

    // This wick's rumour follows the calendar's turning, wherever the hero is.
    if (this.session.link) watchRumour(this.session)

    // The Turning: an ended epoch (a claim refused, or the clock passing the
    // wick's end while we stand here) shifts the outer Wilds under us.
    this.turning = new Turning(this, {
      session: this.session,
      world: this.world,
      reducedMotion: this.reducedMotion,
      hero: () => this.hero,
      unmoored: this.unmoored,
      window: () => this.window,
      wilds: () => this.wilds,
      moving: () => this.transitioning,
      hold: (on) => {
        this.transitioning = on
      }
    })
    if (this.pendingTurned) {
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
    runFrame(this.frame, time, Math.min(delta / 1000, 0.05))
  }

  /** The frame's halves (./world-frame.ts): observation always, then play or holding still. */
  private readonly frame: WorldFrame = {
    observe: (time, dt) => this.observe(time, dt),
    hold: () =>
      playHold({
        ui: uiBlocked(),
        transitioning: this.transitioning,
        cinematic: this.cinematic || (this.waitingFixed && this.fixedWait < 4),
        persisting: this.session.persistenceInFlight,
        placing: !!this.homesteads?.placing
      }),
    still: (time, dt) => this.holdStill(time, dt),
    play: (time, dt) => this.play(time, dt)
  }

  /** Every frame, play held or not: the framing, the clocks, and the world others share. */
  private observe(time: number, dt: number): void {
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
    // Where you stand, for the world map: every frame, panels up too (src/game/map-position.ts).
    if (!this.transitioning) publishMapPosition(this, this.world.areaId, this.session.link?.worldId ?? '', this.hero.sprite.x, this.hero.sprite.y)

    this.unmoored.update(time, dt)
    this.homesteads?.update(dt)
    // Others keep walking while a panel or dialogue holds the screen.
    this.remotePlayers.update(dt)
    this.npcs.update(dt, this.hero.sprite, uiBlocked() || this.transitioning || this.cinematic)
    // Elara at her desk (docs/design/indoors.md 2.8): the desk's `writing`
    // art draws her seated, so her own sprite stands down while she sits
    // there. She walks in and out as before.
    const elara = this.npcs.npcs.find((n) => n.id === 'elara')
    if (elara?.present && elara.seated && !elara.path) elara.sprite.setVisible(false)
    this.samplePresence()
    this.petting.update()
    // The shared world goes on under a menu: the open map's window, the camps'
    // rooms and claims, the Turning, and every server enemy (shared-fights.md 1.8).
    this.window?.update(dt)
    if (this.waitingFixed) {
      this.fixedWait += dt
      if (this.fixedWait >= 4) this.waitForCommons()
    }
    const atChunk = chunkOfPixel(this.hero.sprite.x, this.hero.sprite.y)
    if (this.waitingFixed && this.window?.fixedKeys().includes(chunkKey(atChunk.cx, atChunk.cy))) {
      const at = this.world.open?.standAt(this.hero.sprite.x, this.hero.sprite.y)
      if (at) {
        ;(this.hero.sprite.body as Phaser.Physics.Arcade.Body).reset(at.x, at.y)
        this.notePosition()
        this.session.saveSoon()
      }
      this.waitingFixed = false
      this.fixedWait = 0
      this.commonsWaitSaid = false
    }
    this.wilds?.update()
    this.turning.update(dt)
    this.enemies.observe(dt)
  }

  /**
   * Play held (a panel, a conversation, a transition, a cinematic, a sync's
   * write, placing a piece): the hero stands still, the screen stays alive.
   */
  private holdStill(time: number, dt: number): void {
    this.hero.halt()
    // Still breathing while a conversation or panel holds the screen.
    this.avatar.update(time)
    this.interactables.hideKeyHint()
    this.goalGuide.update(dt, this.hero.sprite, false)
    this.gathering?.updateHint(dt, this.hero.sprite, false, false)
    this.enemies.updateEnemyBars()
    this.updateOccluders(dt)
  }

  /** This player's play: input, the local fights, bolts, exits. */
  private play(time: number, dt: number): void {
    this.hero.move(dt, this.devWalk ? this.devSteer() : this.controls.vector())
    this.holdSafe(dt)
    this.holdFixed(dt)
    this.enemies.update(dt)
    this.goalGuide.update(dt, this.hero.sprite, this.worldLive())
    this.projectiles.update(dt)
    this.paths?.update()
    this.marks?.update()
    this.checkDrift()
    this.updateDiscoveries()
    this.checkExits()
    maybeNudgePip(this.session, this.world, this.hero.sprite) // P1 onboarding: Pip's one-off gate line
    // One target for the action button: the highest rank in reach (the
    // Wilds' claims, the warden's naming), then the nearest.
    this.interactables.update(this.hero.sprite, this.time.now)
    this.fishing?.update()
    this.controls.update()
    // The wrong tool in hand by something workable: a faint hint after a moment.
    const hx = this.hero.sprite.x
    const hy = this.hero.sprite.y
    const creatureNear = this.enemies.enemies.some((e) => !e.dead && Math.hypot(e.x - hx, e.y - hy) < 200)
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
      // The open map is one area but three places (the Tangle, the Whitequiet, beyond): the HUD follows.
      if (this.world.open) {
        const place = displayArea(this.session.state)
        if (place !== this.shownPlace) {
          this.shownPlace = place
          this.session.emitArea()
        }
      }
    }
  }

  /** Undelivered fixed ground is a boundary, including a step Arcade has already taken. */
  private holdFixed(dt: number): void {
    if (!this.window) return
    const ready = (x: number, y: number) => this.fixedReady(x, y)
    const h = this.hero.sprite
    if (!ready(h.x, h.y)) {
      if (this.fixedSpot && ready(this.fixedSpot.x, this.fixedSpot.y)) {
        ;(h.body as Phaser.Physics.Arcade.Body).reset(this.fixedSpot.x, this.fixedSpot.y)
      } else {
        ;(h.body as Phaser.Physics.Arcade.Body).reset(h.x, h.y)
        this.hero.halt()
      }
      this.waitForCommons()
      return
    }
    this.fixedSpot = { x: h.x, y: h.y }
    const body = h.body as Phaser.Physics.Arcade.Body
    const next = { x: h.x + body.position.x - body.prevFrame.x, y: h.y + body.position.y - body.prevFrame.y }
    if (!ready(next.x, next.y)) {
      this.waitForCommons()
      const at = holdOnSafe(ready, h, next)
      body.reset(at.x, at.y)
      return
    }
    const v = stopAtEdge(ready, next, body.velocity, Math.max(dt, 1 / 30) * 1.5)
    if (v.x !== body.velocity.x || v.y !== body.velocity.y) this.waitForCommons()
    body.setVelocity(v.x, v.y)
  }

  private fixedReady(x: number, y: number): boolean {
    const at = chunkOfPixel(x, y)
    return !this.window || !fixedPlaceOf(at.cx, at.cy) || this.window.hasFixed(at.cx, at.cy)
  }

  private waitForCommons(): void {
    if (this.commonsWaitSaid) return
    this.commonsWaitSaid = true
    bus.emit(EV.toast, { text: 'Waiting for the Commons…', icon: 'map', kind: 'thought' })
  }

  private fixedSpot: { x: number; y: number } | null = null
  private fixedWait = 0
  private commonsWaitSaid = false

  /** Where the hero last stood on safe ground while too hurt to fight (the zero-HP barrier's). */
  private safeSpot: { x: number; y: number } | null = null
  private waitingFixed = false

  /**
   * The zero-HP barrier (../safe-barrier.ts): too hurt to fight, a hero on
   * safe ground can't step off it (on the open map, the Commons' mouth at
   * y = 24). One already off safe ground (a legacy save) walks freely, home
   * to rest.
   */
  private holdSafe(dt: number): void {
    if (!this.session.zeroHpLocked) {
      this.safeSpot = null
      return
    }
    const h = this.hero.sprite
    const area = this.world.areaId
    const safe = (x: number, y: number) => safeArea(area, x, y) && this.fixedReady(x, y)
    const body = h.body as Phaser.Physics.Arcade.Body
    if (safe(h.x, h.y)) this.safeSpot = { x: h.x, y: h.y }
    // Arcade has already stepped the body, but postUpdate has not copied
    // its displacement to the sprite yet. Catch a shove in this frame,
    // before the unsafe step is ever displayed or saved.
    const next = { x: h.x + body.position.x - body.prevFrame.x, y: h.y + body.position.y - body.prevFrame.y }
    if (safe(next.x, next.y)) {
      this.safeSpot = next
      // The next step (a frame and a half ahead, for a slow frame) stops at the edge.
      const v = stopAtEdge(safe, next, body.velocity, Math.max(dt, 1 / 30) * 1.5)
      body.setVelocity(v.x, v.y)
      return
    }
    if (!this.fixedReady(next.x, next.y)) this.waitForCommons()
    const was = this.safeSpot
    if (!was || !safe(was.x, was.y)) return
    const at = holdOnSafe(safe, was, next)
    // A reset, so the step already taken isn't written to the sprite again after this update.
    body.reset(at.x, at.y)
    this.safeSpot = at
  }

  /** Dev: the steering toward the next waypoint (dropping those reached). */
  private devSteer(): Phaser.Math.Vector2 {
    const h = this.hero.sprite
    while (this.devWalk?.length && Math.hypot(this.devWalk[0].x - h.x, this.devWalk[0].y - h.y) < 3) this.devWalk.shift()
    if (!this.devWalk?.length) {
      this.devWalk = null
      return new Phaser.Math.Vector2(0, 0)
    }
    const d = new Phaser.Math.Vector2(this.devWalk[0].x - h.x, this.devWalk[0].y - h.y)
    return d.normalize()
  }

  /**
   * Write where the hero stands into the save, now (the frame loop does it
   * once a second; a gather or a planting does it first, so the server
   * measures reach from where the hero really is).
   */
  private notePosition(): void {
    if (this.transitioning || !this.fixedReady(this.hero.sprite.x, this.hero.sprite.y)) return
    // Positions are the scene's pixels everywhere; on the open map those are
    // world pixels (one convention for saves, reloads, claims and reports).
    this.session.state.position = { x: Math.round(this.hero.sprite.x), y: Math.round(this.hero.sprite.y) }
  }

  /** Tell the presence feed where the hero is (it paces the wire itself). */
  private samplePresence(): void {
    const feed = presence()
    // The open map's room is the chunk you stand in: crossing an edge joins the next one
    // (the server shares a chunk's room with its neighbours', so those in range stay drawn).
    if (feed && this.world.open && !this.transitioning) {
      const room = presenceAreaFor(this.world.areaId, { x: this.hero.sprite.x, y: this.hero.sprite.y })
      if (room && room !== this.presenceArea) {
        this.presenceArea = room
        feed.setArea(room)
        this.remotePlayers.setArea(room)
      }
    }
    if (!feed || !this.presenceArea) return
    const body = this.hero.sprite.body as Phaser.Physics.Arcade.Body
    const moving = !this.transitioning && Math.hypot(body.velocity.x, body.velocity.y) > 5
    // One pose at a time: a line in the water, else the saddle.
    const pose = fishingPose() ?? (this.avatar.riding ? 'riding' : null)
    feed.position({ x: this.hero.sprite.x, y: this.hero.sprite.y, facing: this.hero.facing, moving, ...(pose ? { pose } : {}) })
  }

  /**
   * The drift at the frontier (open-map.md 2.6): pushing against the
   * frontier's edge, the hero stops (the bounds hold them) and, the first
   * time, says why. The south edge is the village's, not the drift's.
   */
  private checkDrift(): void {
    const open = this.world.open
    if (!open || this.driftSaid) return
    const body = this.hero.sprite.body as Phaser.Physics.Arcade.Body
    const v = this.controls.vector()
    const b = open.bounds
    const x = this.hero.sprite.x
    const y = this.hero.sprite.y
    const near = 3
    const pushing =
      (v.x < -0.3 && x - b.x <= body.width / 2 + near) ||
      (v.x > 0.3 && b.x + b.w - x <= body.width / 2 + near) ||
      (v.y < -0.3 && y - b.y <= body.height + near)
    if (!pushing) return
    this.driftSaid = true
    bus.emit(EV.toast, { text: loadWilds().words.drift, icon: 'map', kind: 'thought' })
  }

  /** World input is live only while the hero actually has control. */
  private worldLive(): boolean {
    return !uiBlocked() && !this.transitioning && !this.cinematic && !this.waitingFixed && !this.session.persistenceInFlight &&
      !this.homesteads?.placing && performance.now() >= uiState.blockedUntil
  }

  private handleAction(): void {
    if (uiBlocked() || this.cinematic || this.waitingFixed || this.transitioning || this.homesteads?.placing || performance.now() < uiState.blockedUntil) return
    // Whatever the prompt is on (free activities stay available at zero HP).
    if (this.interactables.activate()) return
    if (this.session.zeroHpLocked) return // too injured to fight; no auto revival
    // The weapon strikes; a sturdy tool swings too, weakly (you're never
    // helpless); a rod or a bucket doesn't (src/lib/belt.ts SWING).
    swingHeld(this.hero)
  }

  /** Quest progress (or a spend) changes what the markers say; owned by Interactables. */
  private refreshMarkers(): void {
    this.interactables.refreshMarkers()
    this.drawFinger()
    // What the quest points at may move and glow; the rest of a room stands still.
    this.roomArt?.refresh()
  }

  /**
   * The signpost's east finger lies in the bracken where the finger-wisp sits
   * (src/lib/quests.ts fingerInBracken), from the opening until the wisp is
   * shooed off it and the finger comes away with you.
   */
  private drawFinger(): void {
    const spot = this.world.areaId === 'woodland' ? this.world.enemies.find((e) => e.id === 'finger-wisp') : undefined
    const lies = !!spot && fingerInBracken(this.session.state.quests)
    if (!lies) {
      this.finger?.destroy()
      this.finger = null
      return
    }
    if (this.finger) return
    const x = tileMid(spot.tx)
    const y = (spot.ty + 1) * TILE - 3
    this.finger = this.add.image(x, y, 'signpost-finger').setOrigin(0.5, 1).setAngle(-12).setDepth(y - 4)
  }

  private onProfileChanged(): void {
    // A sync may have brought glims: glim-spot markers can change.
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

  /**
   * Connected play: the server's area/position won (a stale merge after
   * another device played). Same area: step there (on the open map, only
   * where the window can stand you; else the scene rebuilds around the new
   * spot). Another area: rebuild the scene, which places the hero from the
   * session state.
   */
  private onRelocate(p: RelocatePayload): void {
    if (this.transitioning) return
    this.safeSpot = null
    if (isWildsArea(p.area) && this.world.open) {
      const at = this.world.open.standAt(p.x, p.y)
      if (at && Math.hypot(at.x - this.hero.sprite.x, at.y - this.hero.sprite.y) < 24 * TILE) {
        this.hero.sprite.setPosition(at.x, at.y)
        this.hero.sprite.setVelocity(0, 0)
        return
      }
      this.moveTo({ save: false }, {}, { inDark: () => prepareWilds(this.session, 60_000) })
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
    for (const e of this.enemies.enemies) things.push({ x: e.x, y: e.y })
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
    // Zero-HP gates expeditions only from safe ground; a legacy zero-HP save
    // found outside may travel home freely (nothing heals en route). Safe
    // ground's edge on the open map is a barrier of its own (holdSafe).
    const locked = this.session.zeroHpLocked && safeArea(this.world.areaId, this.hero.sprite.x, this.hero.sprite.y)
    const tx = tileAt(this.hero.sprite.x)
    const ty = tileAt(this.hero.sprite.y)
    // On the open map, the ways out of the attached fixed chunks too (the Commons' gates, the village path).
    for (const exit of this.window ? [...this.world.exits, ...this.window.exits()] : this.world.exits) {
      if (locked && !safeArea(exit.to, exit.entry.tx * TILE + TILE / 2, exit.entry.ty * TILE + TILE / 2)) continue
      if (tx >= exit.tx && tx < exit.tx + exit.tw && ty >= exit.ty && ty < exit.ty + exit.th) {
        // The open map is the server's: without a connection its gate stays shut. (A way out
        // to a fixed place by its own name, a room's door to the Commons, leads onto the open map.)
        const to = contentPosition(String(exit.to), exit.entry.tx, exit.entry.ty).space
        if (!canEnter(to) || (to === OUTDOORS_AREA && !this.session.link)) {
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
    // Content names Commons positions in Commons tiles (the Yard's door back
    // out): since the join they lie on the open map's grid.
    const at = contentPosition(String(area), entry.tx, entry.ty)
    if (at.space !== area) {
      area = at.space
      entry = { tx: at.tx, ty: at.ty }
    }
    if (!canEnter(area)) return
    const extra = facing ? { facing } : {}
    if (area === OUTDOORS_AREA) {
      // Onto the open map at an anchor (the Commons' west path, a gate, the
      // Yard's doorstep): the near read and its chunks load while the screen
      // is dark, so the first window paints behind the fade.
      this.moveTo({ area, position: tileCenter(entry.tx, entry.ty) }, { entry, ...extra }, { inDark: () => prepareWilds(this.session, 60_000) })
      return
    }
    // A homestead's land is the server's: fetched while the screen is dark.
    this.moveTo({ area, position: tileCenter(entry.tx, entry.ty) }, { entry, ...extra })
  }

  /** Dev: straight to a world tile of the open map (its chunks load while the screen is dark). */
  private warpWilds(tx: number, ty: number): void {
    if (this.transitioning) return
    this.moveTo({ area: OUTDOORS_AREA, position: tileCenter(tx, ty) }, { entry: { tx, ty } }, { inDark: () => prepareWilds(this.session, 0) })
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

  /**
   * A room's signature piece in the state what has happened puts it in
   * (docs/design/indoors.md 2.8: never by idling): the oven lit while Hazel
   * is home, the stones and gears turning while Finn is in, the reading
   * lamp lit once its oil is paid, the hoist working once greased, the
   * tallow pot steaming while a quest points at it, the sponge risen once
   * its wait has passed, Elara's desk drawn with her while she's at it.
   * Null: its default.
   */
  private pieceState(f: Footprint, pointed: (f: Footprint) => boolean): string | null {
    const home = residentIn(this.world.areaId.replace(/:\d+$/, ''))
    switch (f.art) {
      case 'kitchen-hearth':
        return home ? 'lit' : 'banked'
      case 'millstones':
      case 'mill-gears':
        return home ? 'turning' : 'still'
      case 'reading-table':
        return this.session.state.flags.includes(LAMP_MARK) ? 'lit' : 'unlit'
      case 'mill-hoist':
        return hoistState(this.session.quests)
      case 'kitchen-tallow-pot':
        return pointed(f) ? 'steaming' : 'still'
      case 'kitchen-sponge-bowl':
        return spongeBowlState(this.session.quests, this.session.gateContext('set-to-rise'))
      case 'elara-desk':
        return elaraDeskState(residentPlace('elara'), this.world.areaId)
      default:
        return null
    }
  }

  /** The homestead layer: the Commons lane on the open map, a homestead's land, a cottage, the Yard. */
  private homesteadLayer(lane: ReturnType<typeof commonsLane>, homeRoom: number | null): HomesteadLayer {
    return new HomesteadLayer(this, {
      world: this.world,
      commons: lane,
      session: this.session,
      fx: this.fx,
      reducedMotion: this.reducedMotion,
      solidGroup: this.solids.group,
      interactables: this.interactables,
      hero: () => this.hero.sprite,
      sitter: () => this.hero,
      room: homeRoom !== null ? { gate: homeRoom } : null,
      enterRoom: (gate) => this.goIn(homeRoomArea(gate)),
      rebuild: () => this.rebuildArea(),
      refreshLot: (key) => this.window?.refreshFixed(key)
    })
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
    // Where this scene's hero stood is no longer where you are: the map falls back to the save until the next scene says.
    clearMapPosition(this)
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
