/**
 * Area construction — exits. Readable exits: a floating destination label
 * and pulsing chevrons on the exit tiles pointing the way out, on whichever
 * map edge the exit sits.
 */
import type Phaser from 'phaser'
import { areaInfo } from '../../content/world'
import { TILE, tileBottom } from '../../lib/tile'
import type { ExitDef, WorldData } from '../worlds'

/** Destination name for an exit label (areas registered later may lack an entry). */
export function exitName(to: string): string {
  return areaInfo(to).name
}

type Edge = 'west' | 'east' | 'north' | 'south'

function edgeOf(world: WorldData, exit: ExitDef): Edge {
  if (exit.tx === 0) return 'west'
  if (exit.ty === 0 && exit.tw > exit.th) return 'north'
  if (exit.ty + exit.th === world.height && exit.tw > exit.th) return 'south'
  return 'east'
}

export function buildExitSigns(scene: Phaser.Scene, world: WorldData, reducedMotion: boolean): void {
  for (const exit of world.exits) {
    if (exit.label === null) continue
    const edge = edgeOf(world, exit)
    const vertical = edge === 'north' || edge === 'south'
    const midX = (exit.tx + exit.tw / 2) * TILE
    const midY = (exit.ty + exit.th / 2) * TILE
    const x = edge === 'west' ? exit.tx * TILE + 6 : edge === 'east' ? (exit.tx + 1) * TILE - 6 : midX
    const y = edge === 'north' ? exit.ty * TILE + 6 : edge === 'south' ? tileBottom(exit.ty) - 6 : midY
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
    const name = exit.label ?? exitName(exit.to)
    const text = edge === 'west' ? `◂ ${name}` : edge === 'east' ? `${name} ▸` : edge === 'north' ? `▴ ${name}` : `${name} ▾`
    const lx = edge === 'west' ? exit.tx * TILE + 26 : edge === 'east' ? (exit.tx + 1) * TILE - 26 : midX
    const ly = vertical ? (edge === 'north' ? exit.ty * TILE + 22 : exit.ty * TILE - 10) : midY - 20
    scene.add
      .text(lx, ly, text, {
        fontFamily: '"Pixelify Sans", monospace',
        fontSize: '7px',
        color: '#fff3c4',
        stroke: '#2b1d1a',
        strokeThickness: 3,
        resolution: 8
      })
      .setOrigin(edge === 'west' ? 0 : edge === 'east' ? 1 : 0.5, 0.5)
      .setDepth(5501)
  }
}
