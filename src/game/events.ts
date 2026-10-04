/**
 * Event bridge between the Phaser runtime and the Svelte interface.
 *
 * The game loop stays in Phaser. Only meaningful state changes cross this bus —
 * never per-frame movement data.
 */
import Phaser from 'phaser'

export const bus = new Phaser.Events.EventEmitter()

export * from './event-names'
