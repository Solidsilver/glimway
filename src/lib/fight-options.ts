/**
 * Supported latency diagnostics: `?lag=<ms>&jitter=<ms>` apply in production and
 * development builds, to both directions of the session's entire presence socket
 * (peers and fights). Values clamp to 0..5000 ms. A queued send is accepted for
 * prediction bookkeeping; it is not a promise that the socket has sent it yet.
 * Every generated camp is a server camp; there is no flag to choose ownership.
 */
export function fightOptions(search: string): { lag: number; jitter: number } {
  const q = new URLSearchParams(search)
  const ms = (key: string) => Math.max(0, Math.min(5000, Number(q.get(key)) || 0))
  return { lag: ms('lag'), jitter: ms('jitter') }
}
export const FIGHT_OPTIONS = fightOptions(typeof location === 'undefined' ? '' : location.search)
