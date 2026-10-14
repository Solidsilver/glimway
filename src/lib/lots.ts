/** A town lot uses local 24×24 coordinates for home data and world coordinates for walking. */
export function lotAt(cx: number, cy: number): number | null { return cx >= -3 && cx <= -2 && cy >= 1 && cy <= 4 ? (cy - 1) * 2 + cx + 3 : null }
export function lotOrigin(gate: number): { tx: number; ty: number } { return { tx: -72 + gate % 2 * 24, ty: 24 + Math.floor(gate / 2) * 24 } }
export function homeEntrance(gate: number): { tx: number; ty: number } { const o = lotOrigin(gate); return { tx: o.tx + 12, ty: o.ty + 20 } }
export function homeDoorstep(gate: number): { tx: number; ty: number } { const o = lotOrigin(gate); return { tx: o.tx + 11, ty: o.ty + 8 } }
export function plotEpoch(world: string, gate: number): string { return `plot:${world}:${gate}@2` }
export function plotIdentity(epoch: string): { world: string; gate: number } | null { const m = /^plot:(.+):([0-7])@2$/.exec(epoch); return m ? { world: m[1]!, gate: Number(m[2]) } : null }
