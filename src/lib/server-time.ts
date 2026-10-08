/**
 * How far the server's clock is from this device's, from every API answer
 * (docs/design/indoors.md 4): its `X-Glimway-Now` header when the server
 * sends one (Unix seconds from its own clock, a dev clock included), else
 * the standard `Date` header (one-second resolution, real time). The
 * residents' cycles allow 90 seconds of grace, which covers what's left.
 * The game reads it through `serverNow` (src/game/clock.ts).
 */
let skew = 0

/** An answer arrived with these headers (missing or unparseable: ignored). */
export function noteServerClock(headers: { get(name: string): string | null } | undefined, receivedMs: number = Date.now()): void {
  const stamped = Number(headers?.get('x-glimway-now') ?? NaN)
  if (Number.isFinite(stamped) && stamped > 0) {
    skew = stamped - receivedMs / 1000
    return
  }
  const date = headers?.get('date')
  const at = date ? Date.parse(date) : NaN
  if (!Number.isFinite(at)) return
  // The header is truncated to the second: on average the server stood half a second later.
  skew = (at + 500 - receivedMs) / 1000
}

/** Seconds to add to this device's clock to read the server's. */
export function serverSkew(): number {
  return skew
}
