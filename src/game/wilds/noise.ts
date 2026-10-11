/**
 * The Wilds' value noise (one octave, smoothstep-interpolated), for the
 * ground art. No content and no DOM: the ground painter's worker loads it.
 */

/** Smooth 2D value noise in 0..1 (one octave, smoothstep-interpolated), for the ground art. */
export function valueNoise(seed: number): (x: number, y: number) => number {
  const lattice = (x: number, y: number): number => {
    let v = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  return (x: number, y: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = lattice(x0, y0) + (lattice(x0 + 1, y0) - lattice(x0, y0)) * sx;
    const b = lattice(x0, y0 + 1) + (lattice(x0 + 1, y0 + 1) - lattice(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}

/**
 * `valueNoise(seed)` at (x / scale, y / scale), for integer pixels in
 * [x0, x0 + w) × [y0, y0 + h) only: its lattice and each column's and row's
 * smoothstep worked out once. The same arithmetic, so the same values to
 * the last bit, at a fraction of the cost (the open map's ground painter
 * samples several fields at every pixel of a chunk).
 */
export function latticeNoise(seed: number, scale: number, x0: number, y0: number, w: number, h: number): (x: number, y: number) => number {
  const lattice = (x: number, y: number): number => {
    let v = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  const lx0 = Math.floor(x0 / scale);
  const ly0 = Math.floor(y0 / scale);
  const lw = Math.floor((x0 + w) / scale) - lx0 + 2;
  const lh = Math.floor((y0 + h) / scale) - ly0 + 2;
  const L = new Float64Array(lw * lh);
  for (let j = 0; j < lh; j++) for (let i = 0; i < lw; i++) L[j * lw + i] = lattice(lx0 + i, ly0 + j);
  const axis = (from: number, n: number, l0: number) => {
    const idx = new Int32Array(n);
    const sm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = (from + i) / scale;
      const f = Math.floor(v);
      const t = v - f;
      idx[i] = f - l0;
      sm[i] = t * t * (3 - 2 * t);
    }
    return { idx, sm };
  };
  const cols = axis(x0, w, lx0);
  const rows = axis(y0, h, ly0);
  return (px: number, py: number) => {
    const c = px - x0;
    const r = py - y0;
    const sx = cols.sm[c]!;
    const sy = rows.sm[r]!;
    const k = rows.idx[r]! * lw + cols.idx[c]!;
    const l00 = L[k]!;
    const l10 = L[k + 1]!;
    const l01 = L[k + lw]!;
    const l11 = L[k + lw + 1]!;
    const a = l00 + (l10 - l00) * sx;
    const b = l01 + (l11 - l01) * sx;
    return a + (b - a) * sy;
  };
}
