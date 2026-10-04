/**
 * Area construction — exits. Readable exits: a floating destination label
 * and pulsing chevrons on the exit tiles pointing the way out.
 */
import type Phaser from 'phaser'
import { locations } from '../../content/world'
import { TILE } from '../textures'
import type { WorldData } from '../worlds'

export function buildExitSigns(scene: Phaser.Scene, world: WorldData, reducedMotion: boolean): void {
  for (const exit of world.exits) {
    const westEdge = exit.tx === 0
    const midY = (exit.ty + exit.th / 2) * TILE
    const edgeX = westEdge ? exit.tx * TILE + 6 : (exit.tx + 1) * TILE - 6
    const chevron = scene.add.image(edgeX, midY, 'mark-chevron')
      .setDepth(5500)
      .setFlipX(westEdge)
      .setAlpha(0.9)
    if (!reducedMotion) {
      scene.tweens.add({
        targets: chevron,
        x: edgeX + (westEdge ? -4 : 4),
        alpha: 0.45,
        duration: 700,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      })
    }
    // Destination label: high-resolution text so it stays crisp at zoom.
    const name = locations[exit.to].name
    const labelX = westEdge ? exit.tx * TILE + 26 : (exit.tx + 1) * TILE - 26
    scene.add.text(labelX, midY - 20, westEdge ? `◂ ${name}` : `${name} ▸`, {
      fontFamily: '"Pixelify Sans", monospace',
      fontSize: '7px',
      color: '#fff3c4',
      stroke: '#2b1d1a',
      strokeThickness: 3,
      resolution: 8
    })
      .setOrigin(westEdge ? 0 : 1, 0.5)
      .setDepth(5501)
  }
}
