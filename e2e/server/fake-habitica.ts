/**
 * A tiny stand-in for habitica.com, for the connected playtests. The Go server
 * calls it once per login (its "proof" read); the browser's own Habitica
 * calls are routed here by the tests (connected.ts), so both sides see the
 * same hero.
 *
 * GET  /api/v3/user        → the "Tansy" fixture, with `_id` = X-Api-User and
 *                            any per-user overrides. X-Api-Key "wrong" → 401.
 * POST /__user             → { id, name?, lvl?, exp?, hp?, mp? } sets overrides.
 * GET  /__health           → 200 (Playwright's readiness check).
 *
 * Run: node e2e/server/fake-habitica.ts <port>
 */
import { createServer } from 'node:http'
import { FIXTURES_BY_KEY } from '../../src/lib/habitica/fixtures.ts'

const port = Number(process.argv[2] ?? 18303)

interface Overrides {
  name?: string
  lvl?: number
  exp?: number
  hp?: number
  mp?: number
}
const users = new Map<string, Overrides>()

function userFor(id: string): unknown {
  const base = structuredClone(FIXTURES_BY_KEY.lowLevel.user) as unknown as {
    _id: string
    stats: Record<string, unknown>
    profile: { name: string }
  }
  const o = users.get(id) ?? {}
  base._id = id
  base.profile.name = o.name ?? 'Tansy'
  // The fixture's exp (120.5) is past a level-2 bar; the server checks the curve.
  base.stats.exp = o.exp ?? 20
  if (o.lvl !== undefined) base.stats.lvl = o.lvl
  if (o.hp !== undefined) base.stats.hp = o.hp
  if (o.mp !== undefined) base.stats.mp = o.mp
  return { ...base, party: { _id: null } }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/__health') return send(200, { ok: true })
  if (url.pathname === '/__user' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        const body = JSON.parse(raw) as Overrides & { id: string }
        users.set(body.id, { ...users.get(body.id), ...body })
        send(200, { ok: true })
      } catch {
        send(400, { ok: false })
      }
    })
    return
  }
  if (url.pathname === '/api/v3/user' && req.method === 'GET') {
    const id = String(req.headers['x-api-user'] ?? '')
    const key = String(req.headers['x-api-key'] ?? '')
    if (!id || !key || key === 'wrong') return send(401, { success: false, error: 'NotAuthorized' })
    return send(200, { success: true, data: userFor(id) })
  }
  send(404, { success: false })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`fake habitica on ${port}`)
})
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => process.exit(0)))
