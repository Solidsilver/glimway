/**
 * Area construction — exits. Readable exits: a floating destination label
 * and pulsing chevrons on the exit tiles pointing the way out.
 */
import type Phaser from 'phaser'
import { areaInfo } from '../../content/world'
import { TILE } from '../textures'
import type { WorldData } from '../worlds'

export function buildExitSigns(scene: Phaser.Scene, world: WorldData, reducedMotion: boolean): void {
  for (const exit of world.exits) {
    const midX = (exit.tx + exit.tw / 2) * TILE
    const midY = (exit.ty + exit.th / 2) * TILE
    // Which edge the gap sits on decides where its chevron points and where
    // the label reads; gaps can sit on any edge (a Wilds chunk has up to
    // four, plus the way home beside one of them).
    const north = exit.ty === 0
    const south = exit.ty + exit.th === world.height
    const westEdge = exit.tx === 0
    const eastEdge = exit.tx + exit.tw === world.width
    const chevron = scene.add.image(midX, midY, 'mark-chevron').setDepth(5500).setAlpha(0.9)
    // The chevron art points right: rotate per edge (up, down, left, right).
    if (westEdge) chevron.setAngle(180)
    if (eastEdge) chevron.setAngle(0)
    if (north) chevron.setAngle(-90)
    if (south) chevron.setAngle(90)
    if (!reducedMotion) {
      scene.tweens.add({
        targets: chevron,
        y: midY + (north ? -4 : 0) + (south ? 4 : 0),
        x: midX + (westEdge ? -4 : 0) + (eastEdge ? 4 : 0),
        alpha: 0.45,
        duration: 700,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      })
    }
    // Destination label: high-resolution text so it stays crisp at zoom,
    // set just inside the map from the gap. Generated targets (`chunk:…`,
    // `commons`) resolve through areaInfo too.
    const name = areaInfo(exit.to).name
    const label = scene.add
      .text(midX, midY, name, {
        fontFamily: '"Pixelify Sans", monospace',
        fontSize: '7px',
        color: '#fff3c4',
        stroke: '#2b1d1a',
        strokeThickness: 3,
        resolution: 8
      })
      .setOrigin(0.5, 0.5)
      .setDepth(5501)
    if (westEdge) label.setOrigin(0, 0.5).setX((exit.tx + exit.tw) * TILE + 18)
    if (eastEdge) label.setOrigin(1, 0.5).setX(exit.tx * TILE - 18)
    if (north) label.setY((exit.ty + exit.th) * TILE + 12)
    if (south) label.setY(exit.ty * TILE - 12)
  }
}
