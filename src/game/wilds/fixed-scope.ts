/** Tiles owned by the fixed chunks that have reached their fixture build step. */
import { chunkOfTile } from './fixed.ts'

export class FixedScope {
  readonly keys = new Set<string>()

  constructor(private open: boolean) {}

  has(tx: number, ty: number): boolean {
    return !this.open || this.keys.has(chunkOfTile(tx, ty))
  }
}
