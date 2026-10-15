export const PLOT_REVISION = 3;

/** A town lot uses local 24×24 coordinates for home data and world coordinates for walking. */
export function lotAt(cx: number, cy: number): number | null { return cx >= -3 && cx <= -2 && cy >= 1 && cy <= 4 ? (cy - 1) * 2 + cx + 3 : null }
export function lotOrigin(gate: number): { tx: number; ty: number } { return { tx: -72 + gate % 2 * 24, ty: 24 + Math.floor(gate / 2) * 24 } }
export function homeEntrance(gate: number): { tx: number; ty: number } { const o = lotOrigin(gate); return { tx: o.tx + 12, ty: o.ty + 20 } }
export function homeDoorstep(gate: number): { tx: number; ty: number } { const o = lotOrigin(gate); return { tx: o.tx + 11, ty: o.ty + 8 } }
export function plotEpoch(world: string, gate: number): string { return `plot:${world}:${gate}@${PLOT_REVISION}` }
export function plotIdentity(epoch: string): { world: string; gate: number } | null { const m = new RegExp(`^plot:(.+):([0-7])@${PLOT_REVISION}$`).exec(epoch); return m ? { world: m[1]!, gate: Number(m[2]) } : null }

/** Private ground starts on the gate row; the public lane and fence bands stay outside. */
export function insideLot(tx: number, ty: number, gate: number): boolean {
  const o = lotOrigin(gate), x = tx - o.tx, y = ty - o.ty
  return x >= 3 && x <= 20 && (y >= 2 && y <= 18 || y === 19 && x >= 11 && x <= 12)
}
export function lotAtPixel(x: number, y: number): number | null {
  const tx = Math.floor(x / 16), ty = Math.floor(y / 16)
  const g = lotAt(Math.floor(tx / 24), Math.floor(ty / 24))
  return g !== null && insideLot(tx, ty, g) ? g : null
}
