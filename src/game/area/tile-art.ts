/**
 * Tile-anchored art: everything drawn for a map tile's piece (a tree, a
 * rock), whichever pass drew it. The props pass draws standing pieces; the
 * foreground pass draws the ones that overhang a path (they fade when walked
 * under). A felled piece takes all of its own, so nothing of a tree is left
 * standing over its stump. Phaser-free (tests load it).
 */
import { tileKey } from '../../lib/tile.ts'

export interface Destroyable {
  destroy(): void
}

export class TileArt<T extends Destroyable> {
  private readonly byTile = new Map<string, T[]>()

  keep(tx: number, ty: number, art: T): void {
    const key = tileKey(tx, ty)
    const list = this.byTile.get(key) ?? []
    list.push(art)
    this.byTile.set(key, list)
  }

  /** What stands for a tile now. */
  at(tx: number, ty: number): T[] {
    return this.byTile.get(tileKey(tx, ty)) ?? []
  }

  /** Destroy everything standing for a tile; returns what went (the scene drops it from its occluders). */
  fell(tx: number, ty: number): T[] {
    const key = tileKey(tx, ty)
    const gone = this.byTile.get(key) ?? []
    this.byTile.delete(key)
    for (const art of gone) art.destroy()
    return gone
  }
}

/** The data key a tile-anchored image carries (`tx,ty`), for the playtest hook that reads what is drawn. */
export const TILE_DATA = 'tile'
