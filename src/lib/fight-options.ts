/** Prototype selection must match the server's -fight-camp / GLIMWAY_FIGHT_CAMP. */
export function fightOptions(search: string): { enabled: boolean; camp: string; lag: number; jitter: number } {
  const q = new URLSearchParams(search)
  const ms = (key: string) => Math.max(0, Math.min(5000, Number(q.get(key)) || 0))
  return { enabled: q.get('fights') === 'server', camp: q.get('fightsCamp') || 'camp:0:0:0', lag: ms('lag'), jitter: ms('jitter') }
}
export const FIGHT_OPTIONS = fightOptions(typeof location === 'undefined' ? '' : location.search)
