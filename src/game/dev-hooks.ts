/**
 * Playtest hooks: the `window.__fs*` handles the e2e suite reads and drives
 * the game through (docs/playtest.md). They exist only in builds with dev
 * tools (the Vite dev server, which e2e runs, and a staging server's
 * dev-tools build for players its dev mode allows; src/lib/dev-tools.ts), so
 * a release bundle installs none of them, and a hook tied to a scene is deleted when that scene ends (shuts down or
 * is destroyed), so it never keeps a dead scene alive.
 *
 * FsHooks is the one list of them, typed; `e2e/` can import it
 * (`import type { FsHooks } from '../src/game/dev-hooks'`).
 */
import type { AreaId } from '../lib/state'
import type { GroundView } from './area/terrain'
import type { EnemyType } from './worlds'
import type { WardenView } from './entities/warden'
import type { WildsEntities } from './wilds/entities'
import type { DevFightFall } from './wilds/dev-fight-fall'
import type { WildsWindow } from './wilds/window'
import type { WildsPaths } from './wilds/paths'
import type { WildsMarks } from './wilds/marks'
import type { PathTile } from '../lib/wilds/paths'
import type { Result } from '../lib/api/errors'
import type { ItemsView } from '../lib/api/types'
import type { SyncSafety } from './sync-safety'
import type { GoalTarget } from './guide-pin.ts'
import type { MapView, TileRect } from '../lib/wilds/map-view.ts'
import type { MapLoad } from './wilds/map-data.ts'
import type { LibraryOpenPayload } from './event-names.ts'
import type { PerfReport } from './perf.ts'
import type { InteractableView } from './entities/interactables.ts'
import { onSceneEnd, type SceneEvents } from './scene-end.ts'
import { DEV_LOCAL, DEV_TOOLS } from '../lib/dev-tools.ts'
import { onWebSettings, webSettings } from '../lib/web-settings.ts'

type Box = { x: number; y: number; w: number; h: number }
type Insets = { top: number; right: number; bottom: number; left: number }
type ExitView = { tx: number; ty: number; tw: number; th: number; to: string; side?: 'north' | 'south' | 'east' | 'west'; kind?: 'edge' | 'door' | 'stair' | 'inner' }

export interface FsHooks {
  // ---- WorldScene (scenes/world-dev-hooks.ts), read-only
  /** Found-text pickups still lying in this area. */
  __fsPapers: () => string[]
  /** What the off hand shows (null: nothing). */
  __fsOffHand: () => string | null
  /** Item pickups still lying here. */
  __fsPickups: () => string[]
  /** The village's broken things still to mend here. */
  __fsRepairs: () => string[]
  __fsPlayer: () => { x: number; y: number; body: Box; blocked: Record<string, boolean> }
  __fsEnemies: () => Array<{ x: number; y: number; state: string; hp: number; texture: string; body: Box; flipX: boolean; type: string; locked: boolean; tint: string }>
  /** The hero's moves (crafts.md 4): the kit's F and R, cooldowns, and what Stand, Kindle and Echo hold now. */
  __fsMoves: () => { signature: string | null; move: string | null; wardPulseHeal: number; shown: Array<{ move: string; x: number; y: number }>; castCooldown: number; moveCooldown: number; planted: boolean; patches: Array<{ x: number; y: number; r: number; slow: number }>; decoy: { x: number; y: number } | null }
  /** Dormant, active (and whether it stands open), or settled. */
  __fsWarden: () => WardenView
  /** The map's geometry, so a playtest can check the hero is confined to it. */
  __fsWorld: () => { areaId: AreaId; widthPx: number; heightPx: number; bounds: Box; solid: boolean[][]; exits: ExitView[] }
  /** Whether the map's data has a tile solid (the open map's by world tile; off a curated map, solid). */
  __fsTileSolid: (tx: number, ty: number) => boolean
  /** The ground under a tile (a TERRAIN id), or null. */
  __fsGroundAt: (tx: number, ty: number) => number | null
  /** Walk through waypoints (world px) as if steered; whether a walk is still going. */
  __fsDevWalk: (path: { x: number; y: number }[]) => void
  /** Displace the physics body during its next step, returning the feet after postUpdate. */
  __fsDevShove: (dx: number, dy: number) => Promise<{ x: number; y: number }>
  __fsDevWalking: () => boolean
  /** The waypoints a dev walk has still to reach, the next first (null: not walking). */
  __fsDevWalkLeft: () => { x: number; y: number }[] | null
  /** How settled this area is: frames drawn since it was built, the fade, whether input is live. */
  __fsFrame: () => { areaId: AreaId; frames: number; loop: number; fading: boolean; transitioning: boolean; cinematic: boolean; live: boolean }
  /** The server revision this tab's link is based on (null for guests). */
  __fsLinkRev: () => number | null
  /** Today's top-ups as the game shows them (null for guests); `reread` reads the state again (silas-yard.md 1.5). */
  __fsPurse: (() => { glimsLeft: number; topUpsLeft: number } | null) & { reread: () => Promise<void> }
  /** The item model as last read (null for guests or before a read). */
  __fsItems: (() => ItemsView | null) & { load: () => Promise<Result> }
  __fsVitals: () => { hp: number; maxHp: number; mana: number; maxMana: number }
  /** Connected-play status (null for guests). */
  __fsLink: () => string | null
  /** The Wilds layer (null outside the Wilds). */
  __fsWilds: () => ReturnType<WildsEntities['debug']> | null
  __fsWildsWindow: () => ReturnType<WildsWindow['debug']> | null
  /** The scene's display-list size, running tweens and static bodies, and what is listed (type:texture, counted). */
  __fsSceneSize: () => { list: number; tweens: number; transientTweens: number; tweening: string[]; statics: number; textures: number; listeners: number; kinds: Record<string, number> }
  /** The walking-performance instruments (src/game/perf.ts; only with `?perf=1`): everything as JSON, the walk's phase, a fresh start. */
  __fsPerf: () => PerfReport
  __fsPerfPhase: (name: string) => void
  __fsPerfReset: () => void
  /** The open map's path work: the clear prompt's tile, the queue, the last outcome, the buttons, and what the store holds. */
  __fsPaths: () => (ReturnType<WildsPaths['debug']> & { materials: Record<string, number> | null; ways: { id: string; name: string; a: string; b: string; by: string; signA: { x: number; y: number } | null; signB: { x: number; y: number } | null; path: number }[] }) | null
  /** One world tile as the path rules read it. */
  __fsPathTile: (tx: number, ty: number) => PathTile | null
  /** Way signs drawn and places asked about, and the discoveries the store holds. */
  __fsMarks: () => (ReturnType<WildsMarks['debug']> & { discoveries: { id: string; by: string; name: string }[]; places: { id: string; kind: string; tx: number; ty: number }[] }) | null
  /** The camps the open map last read, and the spot beside the hero a lamp, piece or seed would go. */
  __fsCamps: () => { camps: { id: string; cx: number; cy: number; x: number; y: number; oil: number; dimming: boolean; pieces: { id: string; itemDef: string; x: number; y: number }[]; plants: { id: string; itemDef: string }[] }[]; spot: { tx: number; ty: number } | null } | null
  /** The lit communal lamps the open map last read (lamps.md 1.3). */
  __fsCommunalLamps: () => { lamps: { id: string; kind: string; x: number; y: number; visited: boolean; name: string }[]; stones: { site: string; frame: string }[] } | null
  /** This wick's rumour as the link holds it. */
  __fsRumour: () => ({ epoch: string; place: string; site: string; landmark: string; compass: string; ring: number; pastRiver: boolean; opened: boolean; current: boolean } | null)
  /** The workable pieces of this area and, at home, the lamps whose light holds the ground. */
  __fsGather: () => {
    area: string
    spots: { target: string; tx: number; ty: number; lit: boolean }[]
    prompt: { target: string; tx: number; ty: number; label: string } | null
    left: { tx: number; ty: number; frame: string }[]
    last: string
    lights: { x: number; y: number; radius: number }[]
    hint: { tx: number; ty: number } | null
  } | null
  /** Fishing here (docs/design/crafts.md 5): the line out, a landed fish, each water's band, the last outcome. */
  __fsFishing: () => ReturnType<import('./entities/fishing').Fishing['view']> | null
  /**
   * The action button's target (entities/interactables.ts): the one this frame
   * chose, or with (x, y) the one the hero's feet there would get by the same
   * rule (rank, reach, the tool in hand); and every point in reach there.
   */
  __fsTarget: (x?: number, y?: number) => { target: InteractableView | null; near: (InteractableView & { d: number; usable: boolean })[]; at: { x: number; y: number } }
  /** Whether any collision body covers a tile. */
  __fsSolidAt: (tx: number, ty: number) => boolean
  /**
   * The art drawn for a map tile's piece, read from what is on screen (not
   * from the felling registry): each live image anchored there, its frame,
   * and whether it is a fading canopy.
   */
  __fsArtAt: (tx: number, ty: number) => { frame: string; fades: boolean }[]
  /** Live images whose texture key starts with a prefix, where they stand in world px (the lot lantern's stake). */
  __fsImagesNamed: (prefix: string) => { key: string; x: number; y: number }[]
  /** The sync-safety snapshot the UI's sync gate reads (sync-safety.ts). */
  __fsSafety: () => SyncSafety | null
  /** The seat, and the depths the hero and the layered avatar are drawn at. */
  __fsSeat: () => unknown
  /** Avatar and combat diagnostics. */
  __fsDebug: () => Record<string, unknown>

  // ---- WorldScene levers
  __fsDevHurt: (n: number) => void
  __fsDevWarp: (area: AreaId, tx: number, ty: number) => void
  /** Dev height terrain (../terrain/scene-terrain.ts): its readout, and its settings changed (the dev panel's Terrain section). */
  __fsTerrain: () => Record<string, unknown> | null
  __fsTerrainSet: (change: Partial<import('./terrain/settings').TerrainSettings>) => void
  /** Start the terrain's frame timings afresh (a steady walk's budget). */
  __fsTerrainReset: () => void
  /** Dev height terrain: one frame over a magenta background, its magenta (nothing drawn) pixels counted. */
  __fsTerrainVoid: () => Promise<{ void: number; total: number; at: [number, number][] }> | null
  /** The screen insets the camera keeps the hero clear of; set them, or read them. */
  __fsDevInsets: (v?: Insets) => Insets
  /** The hero sprite's box on screen (CSS px from the canvas's top left). */
  __fsDevHeroScreen: () => Box & { zoom: number }
  /** The camera's scroll, zoom and centre as drawn (canvas px). */
  __fsDevCamera: () => { scrollX: number; scrollY: number; zoom: number; originX: number; originY: number }
  /** A world point on screen (CSS px from the canvas's top left). */
  __fsDevToScreen: (x: number, y: number) => { x: number; y: number }
  /** The world point under the pointer. */
  __fsDevPointerWorld: () => { x: number; y: number }
  __fsDevAddFlag: (flag: string) => void
  /** The ground tileset painted again on the main thread (no workers): its hash. */
  __fsDevGroundMainThreadHash: () => Promise<string | null>
  /** A texture's pixels as `<w>x<h>:<hash>` (null: no such texture). */
  __fsDevTextureHash: (key: string) => string | null
  /** A texture's frame size (world px) and density (texels per world px). */
  __fsDevTextureSize: (key: string) => { w: number; h: number; density: number } | null
  /** Texture memory as the GPU holds it (RGBA), by texture and in total. */
  __fsDevTextureMemory: () => { total: number; largest: number; textures: Record<string, number> }
  /** Frame timings over `ms` (p50/p95 ms): frame-to-frame gaps and the game's step (`finish`: the GPU's drawing included); the canvas size in px. */
  __fsDevFrameTimes: (ms: number, finish?: boolean) => Promise<{ frames: number; gap: { p50: number; p95: number }; step: { p50: number; p95: number }; canvas: [number, number] }>
  __fsDevDodge: (dx: number, dy: number) => void
  __fsDevAttack: () => void
  __fsDevParkCreatures: (keep?: boolean) => void
  /** Local (curated) enemies take `n`; a server camp's enemies only show it (their room decides). */
  __fsDevStrike: (n: number, type?: EnemyType) => void
  /** Finish a generated camp's fight for this account (a `-tags dev` server's /api/dev/fight-fall), then read the Wilds again. */
  __fsDevFightFall: (entity: string) => Promise<DevFightFall>
  /** Speak the naming to the warden; `force` skips the opening and reach rules. */
  __fsDevSpeakNaming: (force?: boolean) => boolean
  /** Set the hero down at a spot in this area (no scene restart); the save follows. */
  __fsDevPlace: (x: number, y: number) => void | Promise<void>
  /** Write a spot into the save without moving the hero. */
  __fsDevStalePosition: (x: number, y: number) => void
  /** Take the saved-position sample every frame. */
  __fsDevSampleEveryFrame: (on: boolean) => void
  /** Add an exit to this area until the scene restarts. */
  __fsDevAddExit: (exit: ExitView) => void
  __fsDevSaveSoon: () => void
  /** Where the save says the hero is, and whether a debounced save is waiting. */
  __fsDevSaved: () => { area: AreaId; position: { x: number; y: number }; pending: boolean }
  /** Uses of a carried tool through the real server path: the last wear, or `{ error }`. */
  __fsDevUseTool: (instance: string, n?: number, action?: string) => Promise<unknown>
  /** Emit any bus event. */
  __fsEmit: (event: string, ...args: unknown[]) => void
  /** Read or set the UI's unmoored flag. */
  __fsUnmoored: (val?: boolean) => boolean
  /** Start or end the unmoored beat itself. */
  fsUnmoored: { trigger: () => void; clear: () => void }

  // ---- entities and stores
  /** The built ground (area/terrain.ts). */
  __fsGround: () => GroundView | null
  /** The walking residents' poses (entities/npcs.ts). */
  __fsNpcs: () => { id: string; x: number; y: number; facing: string; mode: string; frame: string; present: boolean; spot: string | null; walking: boolean }[]
  /**
   * The room you're in (null outdoors): its art on its footprints, spots,
   * light pools, the camera's zoom (CSS px per world px), and the residents
   * on their cycle here; outdoors and in, the lit windows and smoke.
   */
  __fsRoom: () => {
    areaId: string
    room: { id: string; name: string; arrive: { tx: number; ty: number } } | null
    zoom: number
    facing: { x: number; y: number }
    props: { art: string; frame: string; tx: number; ty: number; tw: number; th: number }[]
    spots: string[]
    lights: { kind: string; visible: boolean }[]
    /** The room's dressing (the shared kit): each piece, its draw depth and foot. */
    dressing: { piece: string; depth: number; x: number; y: number }[]
    /** Collision boxes (px) of its pieces' bases. */
    bodies: { x: number; y: number; w: number; h: number }[]
    houses: { room: string; window: boolean; smoke: boolean }[]
  }
  /** Check the residents' cycle now (a moved dev clock shows at once, not within a second). */
  __fsDevCycleCheck: () => void
  /** Play Pip's walk-on now (the opening's `set-post`); false when Pip isn't in this scene. */
  __fsDevPipWalkOn: () => boolean
  /** What the goal guide points at, and whether the edge glint shows. */
  __fsGoal: () => unknown
  /** The thought on screen now, and every one shown this page. */
  __fsThoughts: () => { current: string | null; seen: string[] }
  /** The other players drawn in this area. */
  __fsRemote: () => unknown[]
  /** The presence feed (presence.ts). */
  __fsPresence: () => unknown
  /** What's in hand, and the belt as carried (held.ts). */
  __fsHeld: () => unknown
  /** The homesteads as held; `fresh()` reads the lane and your home again (asked now, never joining an earlier read). */
  __fsHomes: (() => unknown) & { fresh: () => Promise<void> }
  /** A tap on a land or room grid tile while arranging. */
  __fsDevTapTile: (x: number, y: number) => void
  __fsMill: () => unknown
  __fsVillage: () => unknown
  /** Pretend the calendar says this time (null: the real clock). */
  __fsDevCalendar: (unix: number | null) => void
  /** Pretend the world has finished something (a project's flag). */
  __fsDevWorldFlag: (flag: string) => void

  // ---- set by src/ui (DEV-gated there)
  __fsQuests: () => { quests: Record<string, string>; gateAt: Record<string, number>; pin: string | null; goal: GoalTarget | null }
  __fsDevLibrary: (payload: LibraryOpenPayload) => void
  __fsWorldMap: () => {
    view: MapView | null; vp: { w: number; h: number }; frame: TileRect | null
    hero: { x: number; y: number } | null; outside: boolean
    loads: number; draws: number; cached: number
    stats: { rasters: number; images: number; overviews: number; summaries: number }
    result: Pick<MapLoad, 'scope' | 'missing' | 'offline' | 'partial' | 'ended' | 'endsAt'> | null
    online: boolean; notes: string[]; chunks: number
  }
  __fsDevVersionCheck: () => Promise<void>
  __fsDialogue: () => { open: boolean; speaker: string; line: number; lines: number; said: string[]; typing: boolean; pending: boolean; choices: { text: string; disabled: boolean }[] | null; opened: number; seen: { speaker: string; text: string }[] }
  __fsBanners: () => { current: { kind: string; title: string; waiting?: boolean } | null; shown: { kind: string; title: string }[] }
  __fsToasts: () => { count: number; seen: { n: number; text: string; kind: string }[] }
}

/**
 * Put a playtest hook on `window` (builds with dev tools only; a no-op
 * otherwise). Under the Vite dev server it goes on at once. In a dev-tools
 * build it follows this player's grant (web.dev.hooks): on while the server
 * gives it, off again when the grant goes (another account, a revoke).
 * The returned disposer removes only this registration. With a scene, it is deleted when that scene shuts down or is destroyed, unless a
 * newer registration has taken the name meanwhile.
 */
export function expose<K extends keyof FsHooks>(name: K, fn: FsHooks[K], scene?: { events: SceneEvents }): () => void {
  if (!DEV_TOOLS) return () => {}
  if (DEV_LOCAL) return hook(window as unknown as Partial<FsHooks>, name, fn, scene)
  if (!windowGate) {
    const gate = gatedHooks(window as unknown as Partial<FsHooks>)
    gate.set(!!webSettings().dev?.hooks)
    onWebSettings((s) => gate.set(!!s.dev?.hooks))
    windowGate = gate
  }
  return windowGate.expose(name, fn, scene)
}

let windowGate: HookGate | null = null

export interface HookGate {
  /** Grant (true) or take away (false): every registration goes on or comes off at once. */
  set(on: boolean): void
  /** expose, under the gate. */
  expose<K extends keyof FsHooks>(name: K, fn: FsHooks[K], scene?: { events: SceneEvents }): () => void
}

/**
 * Hooks behind a grant, on `target`: each registration is on the target
 * while the gate is on and off it otherwise, kept until it is disposed (or
 * its scene ends), so a later grant puts it back.
 */
export function gatedHooks(target: Partial<FsHooks>): HookGate {
  type Entry = { install: () => void; remove: () => void }
  const entries = new Set<Entry>()
  let on = false
  return {
    set(next) {
      if (next === on) return
      on = next
      // Insertion order: the newest registration of a name goes on last, and wins.
      for (const e of entries) {
        if (on) e.install()
        else e.remove()
      }
    },
    expose(name, fn, scene) {
      let dispose: (() => void) | null = null
      const entry: Entry = {
        install: () => {
          if (!dispose) dispose = hook(target, name, fn)
        },
        remove: () => {
          dispose?.()
          dispose = null
        }
      }
      entries.add(entry)
      if (on) entry.install()
      const cancel = () => {
        entry.remove()
        entries.delete(entry)
      }
      if (scene) onSceneEnd(scene, cancel)
      return cancel
    }
  }
}

/** Who registered each hook last, per target: the same function can be registered twice. */
const owners = new WeakMap<object, Map<string, object>>()

/** expose's body, on any target (tests use a plain object). */
export function hook<K extends keyof FsHooks>(target: Partial<FsHooks>, name: K, fn: FsHooks[K], scene?: { events: SceneEvents }): () => void {
  let mine = owners.get(target)
  if (!mine) owners.set(target, (mine = new Map()))
  const token = {}
  mine.set(name, token)
  target[name] = fn
  const dispose = () => {
    if (mine.get(name) !== token) return
    mine.delete(name)
    delete target[name]
  }
  if (scene) onSceneEnd(scene, dispose)
  return dispose
}
