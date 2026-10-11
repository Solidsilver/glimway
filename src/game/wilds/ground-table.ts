/**
 * The ground painter's table (./ground-paint.ts): each content ground's
 * TERRAIN id and how it paints. Built once from content on the main thread;
 * the painter's worker gets it with each job, so it never loads content.
 */
import { TERRAIN } from '../../lib/tile.ts'
import { loadWilds } from '../../lib/wilds/data.ts'
import { PAINT, type PaintTable } from './ground-paint.ts'

let table: PaintTable | null = null

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
