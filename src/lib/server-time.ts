/**
 * How far the server's clock is from this device's, from the `Date` header
 * every API answer carries (one-second resolution: the resident cycles'
 * 90-second grace covers what's left, docs/design/indoors.md 4). The game
 * reads it through `serverNow` (src/game/clock.ts).
 */
let skew = 0

/** An answer arrived with this `Date` header (null or unparseable: ignored). */
export function noteServerDate(header: string | null, receivedMs: number = Date.now()): void {
  if (!header) return
  const at = Date.parse(header)
  if (!Number.isFinite(at)) return
  // The header is truncated to the second: on average the server stood half a second later.
  skew = (at + 500 - receivedMs) / 1000
}

/** Seconds to add to this device's clock to read the server's. */
export function serverSkew(): number {
  return skew
}
