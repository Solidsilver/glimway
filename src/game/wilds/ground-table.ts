/**
 * The ground painter's table (./ground-paint.ts): each content ground's
 * TERRAIN id and how it paints. Built once from content on the main thread;
 * the painter's worker gets it with each job, so it never loads content.
 * `paintTable` adds the fixed places' rows (./fixed-ground.ts): the open
 * map paints generated and fixed chunks from one table.
 */
import { TERRAIN } from '../../lib/tile.ts'
import { loadWilds } from '../../lib/wilds/data.ts'
import { fixedPaintTable } from './fixed-ground.ts'
import { PAINT, type PaintTable } from './ground-paint.ts'

let table: PaintTable | null = null
let both: PaintTable | null = null

export function groundTable(): PaintTable {
  if (table) return table
  const rows: [number, (typeof PAINT)[string]['cat'], number][] = []
  for (const g of loadWilds().grounds) {
    const t = (TERRAIN as Record<string, number>)[g.terrain]
    const p = PAINT[g.id]
    if (t !== undefined && p) rows.push([t, p.cat, p.trail])
  }
  return (table = rows)
}

/** The generated land's rows and every fixed style's. */
export function paintTable(): PaintTable {
  return (both ??= [...groundTable(), ...fixedPaintTable()])
}
