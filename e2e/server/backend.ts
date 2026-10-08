/**
 * One connected-play backend per Playwright worker: its own Go server, its own
 * SQLite database and its own fake Habitica, so parallel workers never share
 * server state. The Vite dev server is shared; the browser reaches its
 * worker's Go server through Vite with the `fs-e2e-api` cookie (see
 * e2e/server/vite-routing.mjs and the fixtures in e2e/fixtures.ts).
 *
 * Started lazily by the fixtures' `backend` fixture (the first test in the
 * worker), and stopped when the worker exits. Ports are picked free at start, so worktrees
 * and workers never collide. Each run has its own directory (two runs in one
 * worktree don't share files): .e2e-server/run-<pid>/, with the Go binary and
 * a w<parallel index>/ folder per worker (database, server.log, server.json).
 * .e2e-server/latest points at the newest run.
 */
import childProcess, { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createServer, type AddressInfo } from 'node:net'
import { startFakeHabitica } from './fake-habitica.ts'

/** This run's directory (set by e2e/global-setup.ts for the workers). */
const runDir = (): string => process.env.E2E_RUN_DIR || '.e2e-server/latest'
/** The Go server binary, built once per run by e2e/global-setup.ts. */
export const BIN = `${runDir()}/glimway-server`
/** The cookie the shared Vite reads to pick this worker's Go server. */
export const ROUTE_COOKIE = 'fs-e2e-api'

export interface Backend {
  /** The Go server's port (127.0.0.1). */
  apiPort: number
  /** The fake Habitica's base URL. */
  habitica: string
  /** This worker's SQLite database (for the admin CLI and sqlite3). */
  db: string
  dir: string
}

/** Stable per worker slot: a restarted worker reuses (and wipes) its slot's directory. */
const slot = (): number => Number(process.env.TEST_PARALLEL_INDEX ?? 0)
const workerDir = (): string => `${runDir()}/w${slot()}`

let running: (Backend & { stop: () => Promise<void> }) | null = null
let starting: Promise<Backend> | null = null

/** This worker's backend, or null before its first test. */
export function currentBackend(): Backend | null {
  return running
}

/** This worker's backend, for the module-level helpers (allow, fund, …). */
export function requireBackend(): Backend {
  if (!running) throw new Error('No e2e server in this worker yet: the backend fixture starts it.')
  return running
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo
      s.close(() => resolve(port))
    })
  })
}

async function waitUp(port: number, child: ChildProcess, log: string): Promise<void> {
  const until = Date.now() + 30_000
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`e2e Go server exited (${child.exitCode}); see ${log}`)
    try {
      await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1000) })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error(`e2e Go server never answered on ${port}; see ${log}`)
}

async function start(): Promise<Backend> {
  const dir = workerDir()
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const db = `${dir}/glimway.sqlite`
  const log = `${dir}/server.log`
  const fake = await startFakeHabitica(0)
  const habitica = `http://127.0.0.1:${fake.port}`
  // A free port can be taken between the probe and the bind: retry.
  for (let attempt = 1; ; attempt++) {
    const apiPort = await freePort()
    const out = openSync(log, 'a')
    // Insecure cookies: the tests use http. The login limits are lifted so a
    // busy worker never trips them.
    const child = spawn(
      BIN,
      // -dev-clock=now: the real time to the instant (a stamp taken here would
      // leave the server behind by its start-up), movable by a test (moveServerClock).
      ['-listen', `127.0.0.1:${apiPort}`, '-db', db, '-cookie-secure=false', '-habitica-url', habitica, '-login-rate', '10000', '-login-global-rate', '100000', '-login-concurrency', '64', '-dev-clock=now'],
      { stdio: ['ignore', out, out] }
    )
    const kill = () => child.kill('SIGKILL')
    process.on('exit', kill)
    try {
      await waitUp(apiPort, child, log)
    } catch (e) {
      kill()
      process.off('exit', kill)
      if (attempt >= 3) {
        await fake.close()
        throw e
      }
      continue
    }
    const backend: Backend = { apiPort, habitica, db, dir }
    writeFileSync(`${dir}/server.json`, JSON.stringify({ ...backend, pid: child.pid, worker: slot() }, null, 2))
    running = {
      ...backend,
      stop: async () => {
        process.off('exit', kill)
        if (child.exitCode === null) {
          const exited = new Promise((r) => child.once('exit', r))
          child.kill('SIGTERM')
          await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
          if (child.exitCode === null) kill()
        }
        await fake.close()
      }
    }
    return backend
  }
}

let clockMoved = false

/**
 * Move this worker's server clock forward (a dev build's POST /api/dev/clock,
 * straight to the server on loopback). Its world is then ahead of real time
 * for good, so the backend is replaced before the worker's next test.
 */
export async function moveBackendClock(to: { unix: number } | { advance_seconds: number }): Promise<number> {
  const b = requireBackend()
  clockMoved = true
  const res = await fetch(`http://127.0.0.1:${b.apiPort}/api/dev/clock`, { method: 'POST', body: JSON.stringify(to) })
  if (!res.ok) throw new Error(`moving the server clock failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { unix: number }).unix
}

/** After a test: a backend whose clock was moved is stopped (the next test starts a fresh one). */
export async function retireMovedBackend(): Promise<void> {
  if (!clockMoved) return
  clockMoved = false
  await stopBackend()
}

/** Start this worker's backend if it isn't running yet. */
export function ensureBackend(): Promise<Backend> {
  if (running) return Promise.resolve(running)
  starting ??= start().finally(() => (starting = null))
  return starting
}

export async function stopBackend(): Promise<void> {
  const r = running
  running = null
  await r?.stop()
}

/** The single shared database's path before per-worker servers. */
const LEGACY_DB = '.e2e-server/glimway.sqlite'

/**
 * Compat for specs written against the single shared server: an
 * `execFileSync(..., ['.e2e-server/glimway.sqlite', ...])` (sqlite3 or the
 * admin CLI) is pointed at this worker's database. New specs use `sql()` and
 * `allow()`/`adminInvite()` from e2e/connected.ts instead.
 */
export function installLegacyDbPath(): void {
  const cp = childProcess as unknown as { execFileSync: (...a: unknown[]) => unknown; __fsLegacyDb?: boolean }
  if (cp.__fsLegacyDb) return
  cp.__fsLegacyDb = true
  const original = cp.execFileSync
  let warned = false
  cp.execFileSync = (file: unknown, args?: unknown, ...rest: unknown[]) => {
    if (Array.isArray(args) && args.includes(LEGACY_DB) && running) {
      if (!warned) {
        warned = true
        console.warn(`e2e: ${LEGACY_DB} is now per worker; use sql() from e2e/connected.ts`)
      }
      args = args.map((a) => (a === LEGACY_DB ? running!.db : a))
    }
    return original(file, args, ...rest)
  }
  syncBuiltinESMExports()
}
