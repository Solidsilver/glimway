/** Fight diagnostics from the URL: `?lag=<ms>&jitter=<ms>` delays both directions of the presence socket.
 * Every generated camp is a server camp; there is no flag to choose ownership. */
export function fightOptions(search: string): { lag: number; jitter: number } {
  const q = new URLSearchParams(search)
  const ms = (key: string) => Math.max(0, Math.min(5000, Number(q.get(key)) || 0))
  return { lag: ms('lag'), jitter: ms('jitter') }
}
export const FIGHT_OPTIONS = fightOptions(typeof location === 'undefined' ? '' : location.search)
