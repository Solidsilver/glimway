import Phaser from 'phaser'
import { BootScene } from './scenes/BootScene'
import { WorldScene } from './scenes/WorldScene'
import type { Session } from './session'
import { DEMO_CHARACTER } from '../content/world'

export function startGame(parent: HTMLElement, session: Session): Phaser.Game {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: '#241f31',
    pixelArt: true,
    roundPixels: true,
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: parent.clientWidth || 640,
      height: parent.clientHeight || 480
    },
    physics: { default: 'arcade', arcade: { debug: false } },
    scene: [BootScene, WorldScene]
  })
  game.registry.set('session', session)
  game.registry.set('demoStats', DEMO_CHARACTER.stats)
  return game
}

export function stopGame(game: Phaser.Game | null): void {
  game?.destroy(true)
}
