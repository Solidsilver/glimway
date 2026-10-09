/**
 * The stable on a homestead's land (crafts.md 3.2, 9.2): one placed piece
 * that grows east a bay at a time. Each bay draws its back layer, then the
 * Habitica mount stalled in it (body and head, no rider), then its front
 * (posts and the half door), so the mount stands inside with its head over
 * the door. A bay stands open when it's empty or its mount is out with its
 * owner; an empty stall is drawn empty (no stand-in mount, ever).
 *
 * The art is the crafts pass (../crafts-art.ts) at 64 texels a tile, drawn
 * at scale 1; without it, a plain box stands in (the lane's placeholder).
 */
import type Phaser from 'phaser'
import { loadCompanion } from '../avatar-render'
import { crArt } from '../crafts-art'
import { STALL_REACH, bayFront, bayFrontPiece, stableFootprint, stableLayout } from '../../lib/stable-layout'
import { COMPANION_SCALE } from './pet-follower'
import { TILE } from '../../lib/tile'
import type { HomeView, StallView } from '../../lib/api/types'
import { HOMESTEAD_DATA, stallCost, stallGroundProblem, type HomeInstance } from '../../lib/homestead'
import { clearedSet, servedLand } from '../../lib/homestead-land'
import { predictStableExtend } from '../../lib/api/predict'
import { companionName } from '../../lib/companions'
import { companionErrorText } from '../../content/errors'
import { bus, EV } from '../events'
import type { Session } from '../session'
import type { Interactable } from './interactables'
import { wantSaddle } from './avatar'
import { short } from './homestead-art'

/** Where a stalled mount's feet stand: this far above the footprint's bottom edge, inside the bay. */
const MOUNT_FLOOR = 7
/** Habitica's mount canvas (135 px): its feet near row 110, its middle near column 61 (as ./led-mount.ts). */
const MOUNT_FEET = { x: -6, y: 42.5 }

export interface StableDrawOpts {
  /** Ghost (placement mode): faint, no mounts. */
  ghost?: boolean
  /** Desolate land: the paint gone dull. */
  desolate?: boolean
  /** Base depth (the footprint's bottom edge, px). */
  depth: number
}

/**
 * Draw a stable whose footprint's bottom-left is (bx, by) px. `stalls` are
 * the bays' occupants (crafts.md 3.4 `HomeView.stalls`). Returns everything
 * drawn (the caller owns it); mount art arrives later and is added through
 * `add`, so it lands in the caller's list too.
 */
export function drawStable(
  scene: Phaser.Scene,
  bx: number,
  by: number,
  count: number,
  stalls: readonly StallView[],
  opts: StableDrawOpts,
  add: <T extends Phaser.GameObjects.GameObject>(o: T) => T,
  alive: () => boolean
): void {
  const layout = stableLayout(count)
  const tint = (img: Phaser.GameObjects.Image) => {
    if (opts.ghost) img.setAlpha(0.85)
    if (opts.desolate) img.setTint(0xa0a0aa)
    return img
  }
  if (!scene.textures.exists(crArt('stable-west-back'))) {
    // Placeholder until the pass is packed: a timber-coloured box over the footprint.
    const [fw, fh] = layout.footprint
    const g = add(scene.add.graphics().setDepth(opts.depth))
    g.fillStyle(0x8a5a32, opts.ghost ? 0.6 : 1).fillRect(bx, by - (fh + 2) * TILE, fw * TILE, (fh + 2) * TILE)
    g.lineStyle(1, 0x2b1d1a, 1).strokeRect(bx + 0.5, by - (fh + 2) * TILE + 0.5, fw * TILE - 1, (fh + 2) * TILE - 1)
    return
  }
  const image = (frame: string, x: number, depth: number) => tint(add(scene.add.image(bx + x, by, crArt(frame)).setOrigin(0, 1).setDepth(depth)))
  for (const p of [...layout.back, ...layout.over]) image(p.frame, p.x, opts.depth - 0.3)
  for (const bay of layout.bays) {
    const st = stalls.find((s) => s.stall === bay.stall)
    const home = !!st?.mount && !st.out
    image(bayFrontPiece(bay, home && !opts.ghost).frame, bayFrontPiece(bay, home && !opts.ghost).x, opts.depth)
    if (home && !opts.ghost) void drawMount(scene, st!.mount, bx + bay.x + bay.w / 2, by - MOUNT_FLOOR, opts, add, alive)
  }
}

/** A stalled mount between its bay's back and front (facing west, as Habitica draws it). */
async function drawMount(
  scene: Phaser.Scene,
  key: string,
  x: number,
  y: number,
  opts: StableDrawOpts,
  add: <T extends Phaser.GameObjects.GameObject>(o: T) => T,
  alive: () => boolean
): Promise<void> {
  const keys = await loadCompanion(scene, key, 'mount')
  if (!keys || !alive()) return
  const s = COMPANION_SCALE
  for (const k of keys) {
    const img = add(scene.add.image(x - MOUNT_FEET.x * s, y - MOUNT_FEET.y * s, k).setScale(s).setDepth(opts.depth - 0.15))
    img.setData('stalled', key)
    if (opts.desolate) img.setTint(0xa0a0aa)
  }
}

/** Where to stand to build a bay on (the stable's east end), px. */
export function stableEastEnd(bx: number, by: number, count: number): { x: number; y: number } {
  // Just past the east edge, so it's never the nearer point at stall 1's or the last bay's door.
  return { x: bx + stableLayout(count).footprint[0] * TILE + 6, y: by + 6 }
}

// ------------------------------------------------------------ using the stable

/** What the stable's points need from the homestead layer (./homesteads.ts). */
export interface StableHost {
  readonly gone: boolean
  here(): HomeView | null
  /** The stalls as this screen shows them (your own mount out while it's out with you or walking home). */
  stallsHere(): StallView[]
  readonly homes: { readonly myId: string | null; readonly connected: boolean; adoptHome(home: HomeView | null): void; materials: Record<string, number> }
  readonly deps: { session: Session; hero: () => { x: number; y: number } }
  readonly land: unknown
}

/**
 * The stable's points (crafts.md 3.1): at each bay, Choose a mount (empty,
 * or your mount is out), Saddle up (your stalled mount), or a look at a
 * partner's; and Build a stall at its east end. Visitors look.
 */
export function stablePoints(host: StableHost, say: (speaker: string, lines: string[]) => void): Interactable[] {
  const home = host.here()
  if (!home) return []
  const out: Interactable[] = []
  const me = host.homes.myId
  const mine = home.member && host.homes.connected
  for (const it of home.items) {
    if (it.itemDef !== HOMESTEAD_DATA.stable.item || it.scene !== 'outdoor' || it.x === null || it.y === null) continue
    const count = it.stalls ?? 1
    const [, fh] = stableFootprint(count)
    const bx = it.x * TILE
    const by = (it.y + fh) * TILE
    for (let stall = 1; stall <= count; stall++) {
      const at = bayFront(bx, by, count, stall)
      const st = () => host.stallsHere().find((s) => s.stall === stall) ?? null
      const label = () => {
        const s = st()
        if (s?.mount && s.ownerId !== me) return `${short(s.ownerName || 'A neighbour', 16)}’s ${companionName(s.mount)}`
        if (!mine) return s?.mount && !s.out ? `Look at the ${companionName(s.mount)}` : 'Look in the stall'
        if (s?.mount && !s.out) return `Saddle up · ${companionName(s.mount)}`
        return 'Choose a mount'
      }
      out.push({
        id: `home:stall:${it.id}:${stall}`,
        ...at,
        label,
        verb: () => {
          const s = st()
          if (!mine || (s?.mount && s.ownerId !== me)) return 'Look'
          return s?.mount && !s.out ? 'Saddle up' : 'Choose'
        },
        markerOffset: 30,
        rank: 1,
        // Strictly inside the server's walk-up check (too-far-away), prompt and click alike.
        reach: STALL_REACH,
        clickReach: STALL_REACH,
        activate: () => {
          const s = st()
          if (s?.mount && s.ownerId !== me) {
            say(`Stall ${stall}`, [s.out ? `${s.ownerName || 'A neighbour'}’s ${companionName(s.mount)} is out on the road. The half door stands open.` : `${s.ownerName || 'A neighbour'}’s ${companionName(s.mount)} looks at you over the half door.`])
            return
          }
          if (!mine) {
            say(`Stall ${stall}`, [s?.mount && !s.out ? `A ${companionName(s.mount)} looks at you over the half door. Not yours to take out.` : 'Clean straw, a full rack of hay. Nobody stands here just now.'])
            return
          }
          if (s?.mount && !s.out) void saddleUp(host, home.id, stall, s.mount)
          else bus.emit(EV.openCompanions, { at: 'stable' })
        }
      })
    }
    if (mine && count < HOMESTEAD_DATA.stable.maxStalls) {
      const cost = stallCost(count)
      out.push({
        id: `home:stall-build:${it.id}`,
        ...stableEastEnd(bx, by, count),
        label: `Build a stall · ${Object.entries(cost).map(([m, n]) => `${n} ${m}`).join(', ')}`,
        // The bays' rank: the nearest of the stable's points wins.
        rank: 1,
        verb: 'Build',
        markerOffset: 30,
        activate: () => void buildStall(host, home.id, it)
      })
    }
  }
  return out
}

/** Saddle up: you're on it at once (the link shows it out until the answer); a refusal says why. */
async function saddleUp(host: StableHost, homeId: string, stall: number, mount: string): Promise<void> {
  const link = host.deps.session.link
  if (!link) return
  wantSaddle(mount)
  // The `where` it carries is where you stand now, not the last second's sample.
  bus.emit(EV.notePosition)
  const r = await link.mountOut(homeId, stall, mount)
  if (!r.ok) {
    wantSaddle('')
    bus.emit(EV.toast, { text: companionErrorText(r.code), kind: 'error' })
  }
}

/** Build a stall east: checked here first (the two tiles must be clear, buildable and lit), predicted, then the answer. */
async function buildStall(host: StableHost, homeId: string, stable: HomeInstance): Promise<void> {
  const link = host.deps.session.link
  const home = host.here()
  if (!link || !home) return
  const land = servedLand(home.gate)
  const problem = stallGroundProblem(home, stable, HOMESTEAD_DATA, land ? { land, cleared: clearedSet(home.cleared) } : undefined)
  if (problem) {
    bus.emit(EV.toast, { text: companionErrorText(problem), kind: 'error' })
    return
  }
  const lacking = Object.entries(stallCost(stable.stalls ?? 1)).some(([m, n]) => (host.homes.materials[m] ?? 0) < n)
  if (lacking) {
    bus.emit(EV.toast, { text: companionErrorText('short'), kind: 'error' })
    return
  }
  host.homes.adoptHome(predictStableExtend(home, HOMESTEAD_DATA.stable.item, HOMESTEAD_DATA.stable.maxStalls))
  const r = await link.stableExtend(homeId)
  if (host.gone) return
  if (!r.ok) {
    host.homes.adoptHome(home)
    bus.emit(EV.toast, { text: companionErrorText(r.code), kind: 'error' })
    return
  }
  if (r.result.home) host.homes.adoptHome(r.result.home)
  host.homes.materials = r.result.materials
  bus.emit(EV.toast, { text: 'A new bay on the stable: fresh straw, and a door that shuts.', kind: 'thought' })
}
