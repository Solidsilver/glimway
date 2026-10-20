/**
 * Dev only (playtests, staging and e2e): a dev warp's server half. The
 * server keeps where each player may see from (server/internal/api/sight.go)
 * and moves it only as fast as a hero travels; a warp is faster. Before the
 * hero lands, a `-tags dev` server's POST /api/dev/warp
 * (server/internal/api/dev_warp.go) moves the caller's sight there, so the
 * reads round the new spot answer. Best effort: a server without the route
 * (404) or the tool leaves sight where it was, and the warp goes on.
 */
import { CONTRACT_NUMBER } from '../../lib/contract.ts'

export const DEV_WARP_PATH = '/api/dev/warp'

/** Move this account's sight to outdoors pixel (x, y); true when the server took it. */
export async function devWarpSight(x: number, y: number, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetcher(DEV_WARP_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Glimway-Contract': String(CONTRACT_NUMBER) },
      body: JSON.stringify({ x, y })
    })
    return res.ok
  } catch {
    return false
  }
}
