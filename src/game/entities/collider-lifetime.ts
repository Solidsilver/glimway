/** Tie an Arcade collider to the sprite it references. Phaser does not unregister it when the sprite dies. */
export function ownCollider(sprite: { once(event: string, fn: () => void): unknown }, collider: { destroy(): void }): void {
  sprite.once('destroy', () => collider.destroy())
}
