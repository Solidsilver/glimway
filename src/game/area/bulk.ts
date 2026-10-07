/**
 * Adding many images to a scene at once. Phaser's display list refuses
 * duplicates by scanning itself on every add, so adding n images one by one
 * costs n² / 2 comparisons: the Commons' thousand-odd trees and their
 * canopies were a tenth of a second of blocked main thread on every entry.
 * These are made off the list and appended in one go, each still announced
 * to the scene as an ordinary add would (`addChildCallback`).
 */
import type Phaser from 'phaser'

type Listed = { list: Phaser.GameObjects.GameObject[]; addChildCallback?: (o: Phaser.GameObjects.GameObject) => void }

/** An image made off the display list (add it with `addAll`). */
export function looseImage(scene: Phaser.Scene, x: number, y: number, key: string, frame?: string): Phaser.GameObjects.Image {
  return scene.make.image({ x, y, key, frame }, false)
}

/** Put freshly made objects on the scene's display list, in order. */
export function addAll(scene: Phaser.Scene, objects: Phaser.GameObjects.GameObject[]): void {
  const dl = scene.children as unknown as Listed
  if (typeof dl.addChildCallback !== 'function') {
    for (const o of objects) scene.add.existing(o)
    return
  }
  for (const o of objects) {
    dl.list.push(o)
    dl.addChildCallback(o)
  }
}
