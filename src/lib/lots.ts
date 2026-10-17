export const PLOT_REVISION = 5;

/** A town lot uses local 24×24 coordinates for home data and world coordinates for walking. */
export function lotAt(cx: number, cy: number): number | null { return (cx === -2 || cx === 2) && cy >= 1 && cy <= 4 ? (cy - 1) * 2 + (cx === 2 ? 1 : 0) : null }
export function lotOrigin(gate: number): { tx: number; ty: number } { return { tx: gate % 2 ? 48 : -48, ty: 24 + Math.floor(gate / 2) * 24 } }
export function homeEntrance(gate: number): { tx: number; ty: number } { const o = lotOrigin(gate); return { tx: gate % 2 ? 46 : -23, ty: o.ty + 11 } }
export function homeDoorstep(gate: number): { tx: number; ty: number } { const o = lotOrigin(gate); return { tx: o.tx + 11, ty: o.ty + 8 } }
export function plotEpoch(world: string, gate: number): string { return `plot:${world}:${gate}@${PLOT_REVISION}` }
export function plotIdentity(epoch: string): { world: string; gate: number } | null { const m = new RegExp(`^plot:(.+):([0-7])@${PLOT_REVISION}$`).exec(epoch); return m ? { world: m[1]!, gate: Number(m[2]) } : null }

/** Private ground excludes fences, verges and the open back lantern line. */
export function insideLot(tx: number, ty: number, gate: number): boolean {
  const o = lotOrigin(gate), x = tx - o.tx, y = ty - o.ty
  return x >= 1 && x <= 22 && y >= 2 && y <= 21 || x === (gate % 2 ? 0 : 23) && y >= 11 && y <= 12
}
export function lotAtPixel(x: number, y: number): number | null {
  const tx = Math.floor(x / 16), ty = Math.floor(y / 16)
  const g = lotAt(Math.floor(tx / 24), Math.floor(ty / 24))
  return g !== null && insideLot(tx, ty, g) ? g : null
}

export function lotLayout(gate: number): string { return gate % 2 ? 'lots-east' : 'lots-west' }
export function lotService(gate: number, kind: 'mailbox' | 'sign' | 'shelf'): { x: number; y: number } {
  const x = kind === 'mailbox' ? 21 : 23
  return { x: gate % 2 ? 23 - x : x, y: kind === 'mailbox' ? 10 : kind === 'sign' ? 9 : 14 }
}

export function lotName(gate: number): string { return `${gate % 2 ? 'East' : 'West'} Row ${Math.floor(gate / 2) + 1}` }

/**
 * The backland (hearthwick-2.md §6): the generated chunk behind each lot,
 * held while the lot's lantern burns. West lots look onto cx -3, east onto
 * cx 3. Its tiles are stored lot-local past the lot: west x -24..-1, east
 * x 24..47 (the server's chunks.BacklandAt / InBackland).
 */
export function backlandAt(cx: number, cy: number): number | null { return cx === -3 ? lotAt(-2, cy) : cx === 3 ? lotAt(2, cy) : null }
export function backlandChunk(gate: number): { cx: number; cy: number } { const o = lotOrigin(gate); return { cx: o.tx / 24 + (gate % 2 ? 1 : -1), cy: o.ty / 24 } }
export function inBackland(x: number, y: number, gate: number): boolean { const x0 = gate % 2 ? 24 : -24; return x >= x0 && x < x0 + 24 && y >= 0 && y < 24 }
export function backlandAtPixel(x: number, y: number): number | null { return backlandAt(Math.floor(x / 16 / 24), Math.floor(y / 16 / 24)) }
/** The lot-local tile of the stake carrying the lot's lantern (its back line, `stakeY` down). */
export function lanternStake(gate: number, stakeY: number): { x: number; y: number } { return { x: gate % 2 ? 23 : 0, y: stakeY } }
/** Lot-local service bounds: inside the fence, or in the backland while the lantern is lit (`lotLit`). */
export function lotLit(x: number, y: number, gate: number, lit: boolean): boolean {
  const o = lotOrigin(gate)
  return insideLot(o.tx + x, o.ty + y, gate) || lit && inBackland(x, y, gate)
}
