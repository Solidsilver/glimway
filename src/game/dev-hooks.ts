/**
 * Playtest hooks: the `window.__fs*` handles the e2e suite reads and drives
 * the game through (docs/playtest.md). They exist in dev builds only (e2e
 * runs the Vite dev server), so a production bundle carries none of them,
 * and a hook tied to a scene is deleted when that scene ends (shuts down or
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
import type { Result } from '../lib/api/errors'
import type { ItemsView } from '../lib/api/types'
import type { SyncSafety } from './sync-safety'
import { onSceneEnd, type SceneEvents } from './scene-end.ts'

type Box = { x: number; y: number; w: number; h: number }
type Insets = { top: number; right: number; bottom: number; left: number }
type ExitView = { tx: number; ty: number; tw: number; th: number; to: string }

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
  /** Dormant, active (and whether it stands open), or settled. */
  __fsWarden: () => WardenView
  /** The map's geometry, so a playtest can check the hero is confined to it. */
  __fsWorld: () => { areaId: AreaId; widthPx: number; heightPx: number; bounds: Box; solid: boolean[][]; exits: ExitView[] }
  /** How settled this area is: frames drawn since it was built, the fade, whether input is live. */
  __fsFrame: () => { areaId: AreaId; frames: number; loop: number; fading: boolean; transitioning: boolean; cinematic: boolean; live: boolean }
  /** The server revision this tab's link is based on (null for guests). */
  __fsLinkRev: () => number | null
  /** The item model as last read (null for guests or before a read). */
  __fsItems: (() => ItemsView | null) & { load: () => Promise<Result> }
  __fsVitals: () => { hp: number; maxHp: number; mana: number; maxMana: number }
  /** Connected-play status (null for guests). */
  __fsLink: () => string | null
  /** The Wilds layer (null outside the Wilds). */
  __fsWilds: () => ReturnType<WildsEntities['debug']> | null
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
  /** Whether any collision body covers a tile. */
  __fsSolidAt: (tx: number, ty: number) => boolean
  /**
   * The art drawn for a map tile's piece, read from what is on screen (not
   * from the felling registry): each live image anchored there, its frame,
   * and whether it is a fading canopy.
   */
  __fsArtAt: (tx: number, ty: number) => { frame: string; fades: boolean }[]
  /** The sync-safety snapshot the UI's sync gate reads (sync-safety.ts). */
  __fsSafety: () => SyncSafety | null
  /** The seat, and the depths the hero and the layered avatar are drawn at. */
  __fsSeat: () => unknown
  /** Avatar and combat diagnostics. */
  __fsDebug: () => Record<string, unknown>

  // ---- WorldScene levers
  __fsDevHurt: (n: number) => void
  __fsDevWarp: (area: AreaId, tx: number, ty: number) => void
  /** The screen insets the camera keeps the hero clear of; set them, or read them. */
  __fsDevInsets: (v?: Insets) => Insets
  /** The hero sprite's box on screen (CSS px from the canvas's top left). */
  __fsDevHeroScreen: () => Box & { zoom: number }
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
  __fsDevParkCreatures: () => void
  __fsDevStrike: (n: number, type?: EnemyType) => void
  /** Speak the naming to the warden; `force` skips the opening and reach rules. */
  __fsDevSpeakNaming: (force?: boolean) => boolean
  /** Set the hero down at a spot in this area (no scene restart); the save follows. */
  __fsDevPlace: (x: number, y: number) => void
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
  __fsNpcs: () => { id: string; x: number; y: number; facing: string; mode: string; frame: string }[]
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
  __fsHomes: () => unknown
  /** A tap on a land or room grid tile while arranging. */
  __fsDevTapTile: (x: number, y: number) => void
  __fsMill: () => unknown
  __fsVillage: () => unknown
  /** Pretend the calendar says this time (null: the real clock). */
  __fsDevCalendar: (unix: number | null) => void
  /** Pretend the world has finished something (a project's flag). */
  __fsDevWorldFlag: (flag: string) => void

  // ---- set by src/ui (DEV-gated there)
  __fsDialogue: () => unknown
  __fsBanners: () => unknown
  __fsToasts: () => unknown
}

/**
 * Put a playtest hook on `window` (dev builds only; a no-op otherwise). With
 * a scene, it is deleted when that scene shuts down or is destroyed, unless a
 * newer registration has taken the name meanwhile.
 */
export function expose<K extends keyof FsHooks>(name: K, fn: FsHooks[K], scene?: { events: SceneEvents }): void {
  // `?.`: Node tests load modules that expose hooks, and have no import.meta.env.
  if (import.meta.env?.DEV) hook(window as unknown as Partial<FsHooks>, name, fn, scene)
}

/** Who registered each hook last, per target: the same function can be registered twice. */
const owners = new WeakMap<object, Map<string, object>>()

/** expose's body, on any target (tests use a plain object). */
export function hook<K extends keyof FsHooks>(target: Partial<FsHooks>, name: K, fn: FsHooks[K], scene?: { events: SceneEvents }): void {
  let mine = owners.get(target)
  if (!mine) owners.set(target, (mine = new Map()))
  const token = {}
  mine.set(name, token)
  target[name] = fn
  if (!scene) return
  onSceneEnd(scene, () => {
    if (mine.get(name) !== token) return
    mine.delete(name)
    delete target[name]
  })
}
