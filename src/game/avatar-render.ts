/**
 * Imported-avatar + companion rendering (M3).
 *
 * Consumes the shared asset helpers from `src/lib/habitica/avatar.ts`
 * (snap_assets): avatarLayersFor(profile) -> official layer order,
 * companionLayersFor(key, kind) -> all companion layers (mounts: body+head),
 * assetSourceFor(name) -> 'local' | 'remote' | null.
 *
 * Rules from the asset contract:
 * - Only same-origin art becomes Phaser textures (upstream URLs carry no CORS
 *   headers). Bundled pieces (`assetSourceFor === 'local'`) load from
 *   /assets/habitica/; every other known piece ('remote') comes through our
 *   server's sprite proxy, kept on this device (src/lib/habitica/
 *   sprite-cache.ts). Only a piece that can't be had at all is left off.
 * - The WALKING world avatar renders with companions removed from the layer
 *   stack (cloned profile: selectedPet null; mount only while riding) so the
 *   companion is not baked in twice; the pet follows as a separate sprite.
 * - The composed avatar is STATIC (restrained code-driven bob) — no walking
 *   sprites are claimed for it. Costume visuals: the profile's useCostume/
 *   costume fields drive the layers via the shared helper; effective gear
 *   still drives combat.
 * - If no local layers resolve, rendering falls back to the original demo
 *   hero, clearly labelled.
 *
 * Loader robustness (this file owns its queueing):
 * - `queueImages` always settles: on loader complete, on load errors
 *   (failed files are simply absent), and on scene shutdown/destroy.
 * - Returned keys are only textures that actually exist afterwards —
 *   safe to pass to `textures.get` / `add.image`.
 * - Each key is queued at most once per call (duplicate layer entries such
 *   as the twice-drawn hair flower keep their multiplicity in the OUTPUT
 *   but do not double-queue the file), `load.start()` is only called when
 *   the loader is idle (no double-start with concurrent callers), and all
 *   listeners are detached when the promise settles (no stale handlers).
 *
 * NOTE: Phaser is imported type-only so this module's logic is testable
 * under the Node test runner without a DOM (the scene instance arrives
 * from the caller at runtime).
 */
import type Phaser from 'phaser'
import {
  assetSourceFor,
  avatarLayersFor,
  companionLayersFor,
  type AvatarProfileFull,
  type AssetRef
} from '../lib/habitica/avatar.ts'
import { spriteCache } from '../lib/habitica/sprite-cache.ts'
import type { HabiticaProfile } from '../lib/habitica/types.ts'
import type { PresenceAvatar } from '../lib/presence.ts'

export { assetSourceFor }

/** Visual profile for the walking avatar: no baked pet; mount only when riding. */
function visualProfile(profile: HabiticaProfile, riding: boolean): AvatarProfileFull {
  return {
    ...profile,
    selectedPet: undefined,
    selectedMount: riding ? (profile as AvatarProfileFull).selectedMount : undefined
  }
}

export interface LoadedAvatar {
  layerKeys: string[]
  fallback: boolean
  /** Pieces that couldn't be had (no server to fetch them, or none upstream): left off. */
  unavailable: string[]
  /** Layers that were queued but failed to load (dropped). */
  failedKeys: string[]
}

const ASSET_PREFIX = 'fs-asset-'

/** Keys currently queued per scene by us (cross-call dedupe; released on settle). */
const pendingByScene = new WeakMap<object, Set<string>>()

function queueImages(scene: Phaser.Scene, assets: AssetRef[]): Promise<string[]> {
  return new Promise((resolve) => {
    const keys = assets.map((a) => ASSET_PREFIX + a.key)
    let pending = pendingByScene.get(scene)
    if (!pending) {
      pending = new Set()
      pendingByScene.set(scene, pending)
    }
    let queuedAny = false
    const seen = new Set<string>()
    for (const asset of assets) {
      const key = ASSET_PREFIX + asset.key
      if (seen.has(key)) continue // duplicate layer entry (e.g. hair flower)
      seen.add(key)
      if (scene.textures.exists(key) || pending.has(key)) continue // cached or in flight (cross-call)
      pending.add(key)
      scene.load.image(key, asset.url)
      queuedAny = true
    }

    if (!queuedAny && keys.every((k) => scene.textures.exists(k))) {
      // Everything is already in the texture cache — no loader round-trip.
      resolve(keys)
      return
    }

    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      scene.load.off('complete', onComplete)
      scene.load.off('loaderror', onError)
      scene.events.off('shutdown', settle)
      scene.events.off('destroy', settle)
      for (const key of seen) pending.delete(key)
      // Only keys that actually exist as textures (drops load errors and
      // anything the shutdown aborted). Preserves order and duplicates.
      resolve(keys.filter((k) => scene.textures.exists(k)))
    }
    const onComplete = () => settle()
    const onError = () => {
      // Per-file failure: keep waiting — the loader still emits 'complete'
      // after errors, and settle() drops the missing keys there.
    }

    scene.load.on('complete', onComplete)
    scene.load.on('loaderror', onError)
    scene.events.on('shutdown', settle)
    scene.events.on('destroy', settle)

    // Join an in-flight loader run (it picks up newly queued files) instead
    // of starting a second one.
    if (scene.load.isReady()) scene.load.start()
  })
}

/** Where a piece loads from: the bundled cache, or the sprite proxy via the device cache. */
export type SpriteSource = (name: string) => Promise<string | null>

type Resolved = { refs: AssetRef[]; unavailable: string[] }

/**
 * Same-origin URLs for every layer: bundled pieces as they are, the rest
 * through `source` (the sprite cache). Order and duplicates are kept; a piece
 * that can't be had is reported, never invented. When every piece is bundled
 * the answer is immediate (no promise), so the loader is queued in the same
 * tick as before the sprite proxy existed.
 */
export function resolveLayers(refs: AssetRef[], source: SpriteSource = (n) => spriteCache.src(n)): Resolved | Promise<Resolved> {
  const where = refs.map((ref) => assetSourceFor(ref.key))
  const collect = (urls: (string | null)[]): Resolved => {
    const out: AssetRef[] = []
    const unavailable: string[] = []
    refs.forEach((ref, i) => {
      const url = urls[i]
      if (url) out.push({ key: ref.key, url })
      else if (!unavailable.includes(ref.key)) unavailable.push(ref.key)
    })
    return { refs: out, unavailable }
  }
  if (!where.includes('remote')) return collect(refs.map((ref, i) => (where[i] === 'local' ? ref.url : null)))
  return Promise.all(refs.map((ref, i) => (where[i] === 'local' ? ref.url : where[i] === 'remote' ? source(ref.key) : null))).then(collect)
}

/**
 * Queue-load and return the layer texture keys for the walking avatar.
 * Callers render them stacked, origin (0.5, 1), uniform scale.
 * `fallback` is true when no layer texture actually loaded.
 */
export async function loadWorldAvatar(scene: Phaser.Scene, profile: HabiticaProfile, riding: boolean): Promise<LoadedAvatar> {
  try {
    const now = resolveLayers(avatarLayersFor(visualProfile(profile, riding)))
    const { refs, unavailable } = now instanceof Promise ? await now : now
    if (refs.length === 0) return { layerKeys: [], fallback: true, unavailable, failedKeys: [] }
    const layerKeys = await queueImages(scene, refs)
    const resolved = new Set(layerKeys)
    const failedKeys = [
      ...new Set(refs.filter((r) => !resolved.has(`${ASSET_PREFIX}${r.key}`)).map((r) => r.key))
    ]
    return { layerKeys, fallback: layerKeys.length === 0, unavailable, failedKeys }
  } catch {
    return { layerKeys: [], fallback: true, unavailable: [], failedKeys: [] }
  }
}

/**
 * Another player's walking avatar (presence, phase 6) from the compact
 * visual shape the server relays: same layer stack and sources as the
 * hero's, on foot, with no companions baked in.
 */
export async function loadPresenceAvatar(scene: Phaser.Scene, avatar: PresenceAvatar): Promise<string[]> {
  try {
    const profile = { ...avatar, selectedPet: undefined, selectedMount: undefined } as unknown as AvatarProfileFull
    const now = resolveLayers(avatarLayersFor(profile))
    const { refs } = now instanceof Promise ? await now : now
    if (refs.length === 0) return []
    return await queueImages(scene, refs)
  } catch {
    return []
  }
}

/** Resolve ALL companion layers (pet: one; mount: body + head).
 * Returns null when the key is unknown or no texture actually loaded. */
export async function loadCompanion(scene: Phaser.Scene, key: string | undefined | null, kind: 'pet' | 'mount'): Promise<string[] | null> {
  if (!key) return null
  try {
    const all = companionLayersFor(key, kind)
    if (all.length === 0) return null
    const now = resolveLayers(all)
    const { refs } = now instanceof Promise ? await now : now
    if (refs.length === 0) return null
    const keys = await queueImages(scene, refs)
    return keys.length > 0 ? keys : null
  } catch {
    return null
  }
}
