/**
 * A tiny stand-in for habitica.com, for the connected playtests. The Go server
 * calls it once per login (its "proof" read), during a purse top-up (the
 * reward it adds, buys and removes — docs/design/purse-and-wardrobe.md 2.2)
 * and for the wardrobe's gear check (4.3); the browser's own Habitica calls
 * are routed here by the tests (connected.ts), so both sides see the same
 * hero.
 *
 * GET    /api/v3/user                     → the "Tansy" fixture, with `_id` = X-Api-User and
 * any per-user overrides. Any X-Api-Key but the tests' TOKEN
 * (e2e/connected.ts) → 401.
 * POST   /api/v3/tasks/user               → creates a reward (a top-up's "Glimway purse"), 201.
 * POST   /api/v3/tasks/:alias/score/down  → buys it: gold goes down by the reward's value and
 * the answer carries `data.gp`. `down` is never scored — no drops.
 * DELETE /api/v3/tasks/:alias             → removes it (404 when it's gone: also done).
 * POST   /__user                          → { id, name?, lvl?, exp?, hp?, mp?, party?, pets?,
 * mounts?, currentPet?, currentMount?, class?,
 * gp?, owned?, score?, down? } sets overrides.
 * GET    /__health                        → 200 (readiness check).
 * GET    /__tasks                         → the rewards this hero still has (for assertions).
 *
 * The purse and wardrobe switches (each optional, per user):
 *
 * - `gp`: the hero's Habitica gold (`stats.gp`).
 * - `owned`: the map `items.gear.owned` (true owned, false lost).
 * - `score`: what the score call does —
 * 'ok' (default)      the gold goes and the answer carries `data.gp`;
 * 'timeout-moved'     the gold goes, then the score never answers in time
 * (the Go server's call gives up after 10 s and reads the
 * outcome off the balance — design 2.3);
 * 'timeout'           the score never answers and nothing moves;
 * 'timeout-partial'   half the gold goes and the score never answers;
 * 'not-enough-gold'   401 "Not Enough Gold", nothing moves;
 * 'error'             500, nothing moves.
 * - `down`: "Habitica is down" — every call answers 503 until it's cleared.
 *
 * Each Playwright worker starts its own in-process copy (e2e/server/backend.ts,
 * startFakeHabitica). Standalone: node e2e/server/fake-habitica.ts <port>
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { FIXTURES_BY_KEY } from '../../src/lib/habitica/fixtures.ts'

type ScoreMode = 'ok' | 'timeout-moved' | 'timeout' | 'timeout-partial' | 'not-enough-gold' | 'error'

interface Overrides {
  name?: string
  lvl?: number
  exp?: number
  hp?: number
  mp?: number
  /** The hero's Habitica party id (none by default). */
  party?: string
  /** Owned companions and the chosen ones (items.pets / items.mounts / currentPet / currentMount). */
  pets?: Record<string, number>
  mounts?: Record<string, boolean>
  currentPet?: string
  currentMount?: string
  /** Habitica's class spelling (`warrior`, `wizard`, `rogue`, `healer`), or null for a hero who never chose one. */
  class?: string | null
  /** The hero's Habitica gold (stats.gp) — what a top-up moves. */
  gp?: number
  /** items.gear.owned: true owned, false had and lost (4.3). */
  owned?: Record<string, boolean>
  /** What the score call does (the purse's switches). */
  score?: ScoreMode
  /** "Habitica is down": every call answers 503. */
  down?: boolean
}

interface Reward {
  _id: string
  alias: string
  type: string
  text: string
  notes: string
  value: number
}

function userFor(users: Map<string, Overrides>, id: string): unknown {
  const base = structuredClone(FIXTURES_BY_KEY.lowLevel.user) as unknown as {
    _id: string
    stats: Record<string, unknown>
    profile: { name: string }
    items: Record<string, unknown>
    flags: Record<string, unknown>
  }
  const o = users.get(id) ?? {}
  base._id = id
  base.profile.name = o.name ?? 'Tansy'
  // The fixture's exp (120.5) is past a level-2 bar; the server checks the curve.
  base.stats.exp = o.exp ?? 20
  if (o.lvl !== undefined) base.stats.lvl = o.lvl
  if (o.hp !== undefined) base.stats.hp = o.hp
  if (o.mp !== undefined) base.stats.mp = o.mp
  if (o.gp !== undefined) base.stats.gp = o.gp
  if (o.pets !== undefined) base.items.pets = o.pets
  if (o.mounts !== undefined) base.items.mounts = o.mounts
  if (o.currentPet !== undefined) base.items.currentPet = o.currentPet
  if (o.currentMount !== undefined) base.items.currentMount = o.currentMount
  if (o.class !== undefined) {
    base.stats.class = o.class ?? 'warrior'
    base.flags = { ...base.flags, classSelected: o.class !== null }
  }
  if (o.owned !== undefined) {
    const gear = (base.items.gear ?? {}) as Record<string, unknown>
    base.items.gear = { ...gear, owned: o.owned }
  }
  return { ...base, party: { _id: o.party ?? null } }
}

/** The one token the fake accepts (e2e/connected.ts TOKEN); a real token reads one account. */
export const FAKE_TOKEN = '99999999-ffff-4eee-9ddd-888888888888'

/** A fake Habitica with its own users; port 0 picks a free port. */
export function startFakeHabitica(port = 0): Promise<{ port: number; server: Server; close: () => Promise<void> }> {
  const users = new Map<string, Overrides>()
  // The rewards a top-up added to a hero's Habitica Rewards, by alias.
  const rewards = new Map<string, Map<string, Reward>>()
  // Score calls that never answer (the switches), so they can be closed on shutdown.
  const hung: ServerResponse[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify(body))
    }
    const readBody = (done: (body: any) => void) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        try {
          done(JSON.parse(raw))
        } catch {
          send(400, { ok: false })
        }
      })
    }
    if (url.pathname === '/__health') return send(200, { ok: true })
    if (url.pathname === '/__tasks') {
      return send(200, { ok: true, tasks: [...(rewards.get(String(url.searchParams.get('id') ?? ''))?.values() ?? [])] })
    }
    if (url.pathname === '/__user' && req.method === 'POST') {
      return readBody((body: Overrides & { id: string }) => {
        users.set(body.id, { ...users.get(body.id), ...body })
        send(200, { ok: true })
      })
    }
    // Everything below is Habitica itself: it needs the tests' token, as
    // habitica.com needs a real one. A wrong token reads and writes nothing.
    const id = String(req.headers['x-api-user'] ?? '')
    const key = String(req.headers['x-api-key'] ?? '')
    if (!id || !key || key !== FAKE_TOKEN) return send(401, { success: false, error: 'NotAuthorized' })
    const o = users.get(id) ?? {}
    if (o.down) return send(503, { success: false, error: 'ServiceUnavailable' })
    const heroRewards = rewards.get(id) ?? new Map<string, Reward>()
    rewards.set(id, heroRewards)

    if (url.pathname === '/api/v3/user' && req.method === 'GET') {
      return send(200, { success: true, data: userFor(users, id) })
    }
    if (url.pathname === '/api/v3/tasks/user' && req.method === 'POST') {
      return readBody((body: { type?: string; text?: string; notes?: string; value?: number; alias?: string }) => {
        const alias = String(body.alias ?? '')
        if (!alias) return send(400, { success: false, error: 'BadRequest' })
        const task: Reward = {
          _id: alias,
          alias,
          type: String(body.type ?? 'reward'),
          text: String(body.text ?? ''),
          notes: String(body.notes ?? ''),
          value: Number(body.value ?? 0),
        }
        heroRewards.set(alias, task)
        send(201, { success: true, data: task })
      })
    }
    const score = /^\/api\/v3\/tasks\/([^/]+)\/score\/down$/.exec(url.pathname)
    if (score && req.method === 'POST') {
      const task = heroRewards.get(decodeURIComponent(score[1]))
      if (!task) return send(404, { success: false, error: 'NotFound' })
      const gold = Number(o.gp ?? (userFor(users, id) as { stats: { gp?: number } }).stats.gp ?? 0)
      const charge = () => {
        users.set(id, { ...o, gp: Math.max(0, gold - task.value) })
      }
      switch (o.score ?? 'ok') {
        case 'not-enough-gold':
          return send(401, { success: false, error: 'NotAuthorized', message: 'Not Enough Gold' })
        case 'error':
          return send(500, { success: false, error: 'InternalServerError' })
        case 'timeout':
        case 'timeout-moved':
        case 'timeout-partial': {
          // The score never answers in time. timeout-moved took the gold
          // first (the charge happened; the answer didn't), timeout-partial
          // took half of it, and plain `timeout` moved nothing. The server's
          // call gives up after its own timeout and reads the outcome off
          // the hero's gold (design 2.3).
          const drop = o.score === 'timeout' ? 0 : o.score === 'timeout-partial' ? Math.floor(task.value / 2) : task.value
          users.set(id, { ...o, gp: Math.max(0, gold - drop) })
          hung.push(res)
          return
        }
        default:
          charge()
          return send(200, {
            success: true,
            data: { gp: Math.max(0, gold - task.value), _id: task._id, value: task.value },
          })
      }
    }
    const task = /^\/api\/v3\/tasks\/([^/]+)$/.exec(url.pathname)
    if (task && req.method === 'DELETE') {
      // 200 or 404 both mean the reward is gone (2.2 step e).
      const existed = heroRewards.delete(decodeURIComponent(task[1]))
      return send(existed ? 200 : 404, { success: true, data: {} })
    }
    send(404, { success: false })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const close = () =>
        new Promise<void>((done) => {
          for (const res of hung) res.destroy()
          hung.length = 0
          server.closeAllConnections()
          server.close(() => done())
        })
      resolve({ port: (server.address() as AddressInfo).port, server, close })
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port, close } = await startFakeHabitica(Number(process.argv[2] ?? 18303))
  console.log(`fake habitica on ${port}`)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void close().then(() => process.exit(0)))
}
