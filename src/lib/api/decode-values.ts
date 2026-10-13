/** Identical domain decoding rules; response wrappers own error/status mapping. */
export function int(v: number | undefined, min = 0): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new Error('invalid integer');
  return v;
}
export function num(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('invalid number');
  return v;
}
export function countMap(v: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (v) for (const [k, n] of Object.entries(v)) if (Number.isInteger(n) && n >= 0) out[k] = n;
  return out;
}
