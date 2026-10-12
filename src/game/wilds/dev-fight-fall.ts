/**
 * Dev only (playtests and e2e fixtures): finish a generated camp's fight
 * through a `-tags dev` server's POST /api/dev/fight-fall
 * (server/internal/api/dev_fights.go). The server clears the camp in its
 * awake room through the normal path (deaths, a fall with every covering
 * account as a witness) and drains the fall writer before it answers; the next
 * near read names the camp claimable. The caller's own socket must cover that
 * room (409 not-here otherwise), so this waits for the room's join first.
 * Not a fallback: a production server has no such route (404), and nothing
 * here touches a fight. Exposed only in Vite dev mode (world-dev-hooks.ts).
 */
import { CONTRACT_NUMBER } from '../../lib/contract.ts'
import { entityChunk } from './store.ts'

export const DEV_FIGHT_FALL_PATH = '/api/dev/fight-fall'
/** How long to wait for this socket's join of the camp's room before asking anyway. */
export const DEV_FIGHT_FALL_JOIN_MS = 5_000

export type DevFightFall =
  | { ok: true; status: number; room: number; epoch: string; cycle: number; fellAt: number; witnesses: string[] }
  | { ok: false; status: number; code: string }

export interface DevFightFallDeps {
  /** Ask for a fresh near read. */
  read: () => void
  /** Whether this socket has joined the room of chunk (cx, cy). */
  joined: (cx: number, cy: number) => boolean
  fetcher?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export async function devFightFall(entity: string, deps: DevFightFallDeps): Promise<DevFightFall> {
  const fetcher = deps.fetcher ?? fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const now = deps.now ?? (() => Date.now())
  const chunk = entityChunk(entity)
  if (!chunk) return { ok: false, status: 0, code: 'entity-not-found' }
  // The server clears only a room this socket covers: wait for its join (the server says not-here past that).
  for (const until = now() + DEV_FIGHT_FALL_JOIN_MS; !deps.joined(chunk.cx, chunk.cy) && now() < until; ) await sleep(50)
  let res: Response
  try {
    res = await fetcher(DEV_FIGHT_FALL_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Glimway-Contract': String(CONTRACT_NUMBER) },
      body: JSON.stringify({ entity })
    })
  } catch {
    return { ok: false, status: 0, code: 'network' }
  }
  let body: { room?: unknown; epoch?: unknown; cycle?: unknown; fellAt?: unknown; witnesses?: unknown; error?: { code?: unknown } } | undefined
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  if (!res.ok) return { ok: false, status: res.status, code: typeof body?.error?.code === 'string' ? body.error.code : '' }
  // The fall is stored (or the camp was already down this cycle): read the Wilds again, so the claim prompt can follow.
  deps.read()
  const num = (v: unknown) => (typeof v === 'number' ? v : -1)
  return {
    ok: true,
    status: res.status,
    room: num(body?.room),
    epoch: typeof body?.epoch === 'string' ? body.epoch : '',
    cycle: num(body?.cycle),
    fellAt: num(body?.fellAt),
    witnesses: Array.isArray(body?.witnesses) ? body.witnesses.filter((w): w is string => typeof w === 'string') : []
  }
}
