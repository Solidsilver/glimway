/**
 * Area construction — exits. Readable exits: a floating destination label
 * and pulsing chevrons on the exit tiles pointing the way out, on whichever
 * map edge the exit sits (or the side a room's doorway or stair names; a
 * stair's chevron sits on its steps, its label above them). An edge exit's
 * label stands on a small signpost you can read (the owner's playtest: "the
 * gate sign doesn't even look visible"): the post is drawn under the label's
 * outer end, and its read point is the post's foot (./../entities/touches.ts).
 */
import type Phaser from 'phaser'
import { areaInfo } from '../../content/world.ts'
import { TILE, tileBottom } from '../../lib/tile.ts'
import type { ExitDef, WorldData } from '../worlds.ts'

/** Destination name for an exit label (areas registered later may lack an entry). */
export function exitName(to: string): string {
  return areaInfo(to).name
}

type Edge = 'west' | 'east' | 'north' | 'south'

export function edgeOf(world: WorldData, exit: ExitDef): Edge {
  if (exit.side) return exit.side
  if (exit.tx === 0) return 'west'
  if (exit.ty === 0 && exit.tw > exit.th) return 'north'
  if (exit.ty + exit.th === world.height && exit.tw > exit.th) return 'south'
  return 'east'
}

/** Where an exit's floating label sits (px), and which way it reads from there. */
function labelAt(world: WorldData, exit: ExitDef): { x: number; y: number; edge: Edge } {
  const edge = edgeOf(world, exit)
  const stair = exit.kind === 'stair'
  const vertical = edge === 'north' || edge === 'south'
  const midX = (exit.tx + exit.tw / 2) * TILE
  const midY = (exit.ty + exit.th / 2) * TILE
  const x = stair ? midX : edge === 'west' ? exit.tx * TILE + 26 : edge === 'east' ? (exit.tx + 1) * TILE - 26 : midX
  const y = stair ? exit.ty * TILE - 6 : vertical ? (edge === 'north' ? exit.ty * TILE + 22 : exit.ty * TILE - 10) : midY - 20
  return { x, y, edge }
}

/** The signpost's height (px), and how far its foot stands below the label's middle. */
const GATE_SIGN_H = 20
const GATE_SIGN_DROP = 15

/**
 * The gate sign of an edge exit with a name: its foot (px), under the
 * label's outer end so the label reads as its board, a tile and more inside
 * the edge (reading it never walks you out). Null for doorways, stairs and
 * unnamed exits: they have no sign.
 */
export function gateSignAt(world: WorldData, exit: ExitDef): { x: number; y: number } | null {
  if (exit.label === null || exit.label === '' || (exit.kind && exit.kind !== 'edge')) return null
  const at = labelAt(world, exit)
  return { x: at.x, y: at.y + GATE_SIGN_DROP }
}

export function buildExitSigns(scene: Phaser.Scene, world: WorldData, reducedMotion: boolean): void {
  for (const exit of world.exits) {
    if (exit.label === null) continue
    const edge = edgeOf(world, exit)
    const stair = exit.kind === 'stair'
    const vertical = edge === 'north' || edge === 'south'
    const midX = (exit.tx + exit.tw / 2) * TILE
    const midY = (exit.ty + exit.th / 2) * TILE
    const x = stair ? midX : edge === 'west' ? exit.tx * TILE + 6 : edge === 'east' ? (exit.tx + 1) * TILE - 6 : midX
    const y = stair ? midY : edge === 'north' ? exit.ty * TILE + 6 : edge === 'south' ? tileBottom(exit.ty) - 6 : midY
    const chevron = scene.add.image(x, y, 'mark-chevron').setDepth(5500).setAlpha(0.9)
    if (edge === 'west') chevron.setFlipX(true)
    if (edge === 'north') chevron.setAngle(-90)
    if (edge === 'south') chevron.setAngle(90)
    if (!reducedMotion) {
      const dx = edge === 'west' ? -4 : edge === 'east' ? 4 : 0
      const dy = edge === 'north' ? -4 : edge === 'south' ? 4 : 0
      scene.tweens.add({ targets: chevron, x: x + dx, y: y + dy, alpha: 0.45, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    }
    // Destination label: high-resolution text so it stays crisp at zoom.
    // An empty label: the chevron alone (a room's doorway: out is out, and the HUD names the room).
    if (exit.label === '') continue
    const name = exit.label ?? exitName(exit.to)
    // A stair names the floor it climbs to (`…:2`) or comes down to.
    const text = stair ? (/:\d+$/.test(exit.to) ? `▴ ${name}` : `▾ ${name}`) : edge === 'west' ? `◂ ${name}` : edge === 'east' ? `${name} ▸` : edge === 'north' ? `▴ ${name}` : `${name} ▾`
    const { x: lx, y: ly } = labelAt(world, exit)
    // The post the label stands on (decoration: it never blocks the way out).
    const post = gateSignAt(world, exit)
    const props = scene.textures.exists('fingersnap-props') ? scene.textures.get('fingersnap-props') : null
    if (post && props?.has('trail-sign')) {
      const f = props.get('trail-sign')!
      scene.add.image(post.x, post.y, 'fingersnap-props', 'trail-sign').setOrigin(0.5, 1).setScale(GATE_SIGN_H / f.height).setFlipX(edge === 'west').setDepth(post.y)
    }
    scene.add
      .text(lx, ly, text, {
        fontFamily: '"Pixelify Sans", monospace',
        fontSize: '7px',
        color: '#fff3c4',
        stroke: '#2b1d1a',
        strokeThickness: 3,
        resolution: 8
      })
      .setOrigin(stair || vertical ? 0.5 : edge === 'west' ? 0 : 1, 0.5)
      .setDepth(5501)
  }
}
