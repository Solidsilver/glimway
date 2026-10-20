import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { expect, type APIResponse, type BrowserContext, type Page } from '@playwright/test'
import contract from '../content/contract.json' with { type: 'json' }
import story from '../content/story.json' with { type: 'json' }
import { backendDiagnostics, BIN, moveBackendClock, requireBackend } from './server/backend.ts'
import { FAKE_TOKEN } from './server/fake-habitica.ts'
import { SERVER_ANSWER_MS } from './helpers'
import { retryConnectionResetRead } from './read-retry.ts'
import { REPORT_INTERVAL_MS } from '../src/lib/api/reports.ts'

/**
 * Helpers for the connected playtests: this worker's own Go server (through
 * the shared Vite) and its fake Habitica (e2e/server/backend.ts). The
 * fixtures' `backend` fixture starts the server and routes every context to
 * it, so every test can use these.
 */

export const TOKEN = FAKE_TOKEN

/** This worker's fake Habitica (base URL). */
export const habiticaURL = (): string => requireBackend().habitica
/** This worker's SQLite database (the admin CLI and sqlite3 read it). */
const dbPath = (): string => requireBackend().db

/** The contract header the /api gate requires on every stateful call. */
export const CONTRACT = { headers: { 'X-Glimway-Contract': String(contract.number) } }

/**
 * A domain read's body. The server answers reads as `{ state, result }` (the
 * player's state beside the view); this is the view with `state` beside it,
 * the way the client reads them (`mixedRead` in src/lib/api/client.ts).
 */
export async function served(res: APIResponse): Promise<any> {
  const raw = await res.json()
  if (!raw || typeof raw !== 'object' || !('state' in raw) || !('result' in raw)) return raw
  const result = raw.result
  if (!result || typeof result !== 'object' || Array.isArray(result)) return raw
  return { ...result, state: raw.state }
}

/**
 * A faked gameplay refusal for `route.fulfill`, shaped like the server's own:
 * the code and the player's current state. (The client takes only a refusal
 * that carries state as settled; a bare one may have committed, so it retries.)
 */
export async function refusal(page: Page, code: string, status = 409): Promise<{ status: number; contentType: string; body: string }> {
  const res = await page.request.get('/api/state', CONTRACT)
  expect(res.ok()).toBe(true)
  return { status, contentType: 'application/json', body: JSON.stringify({ error: { code }, state: (await res.json()).state }) }
}

/**
 * Move the world server's clock forward to `unix` (a dev build's clock route;
 * never back). The worker's backend is replaced after this test, since its
 * world is then ahead of real time. Returns the server's new now.
 */
export async function moveServerClock(page: Page, unix: number): Promise<number> {
  // In steps of at most six days, with a signed-in read between them: the
  // session slides on use (seven idle days sign you out), as it would for a
  // player who kept playing through that week.
  const step = 6 * 86400
  let now = await moveBackendClock({ advance_seconds: 0 })
  while (now < unix) {
    now = await moveBackendClock({ unix: Math.min(unix, now + step) })
    expect((await readApiGet(page, '/api/state')).ok()).toBe(true)
  }
  return now
}

/**
 * Pin this player's world to a fixed seed (a pinned fixture): set before its
 * Wilds are first made (epochs and chunks are made on first entry; any made
 * already are dropped). The still land (the Tangle) is then the same on
 * every run; the wick's land (the Whitequiet and beyond) also follows the
 * wick, so it is the same for a seed only within one wick. Returns the seed,
 * for a failure message to name.
 */
export async function pinWorld(page: Page, seed: string): Promise<string> {
  const world = (await serverState(page)).body.worldId as string
  sql(`DELETE FROM wilds_chunks WHERE epoch_id IN (SELECT id FROM wild_epochs WHERE world_id='${world}'); DELETE FROM wild_epochs WHERE world_id='${world}'; UPDATE worlds SET seed='${seed.replace(/'/g, "''")}' WHERE id='${world}';`)
  return seed
}

const DAY = 86400

/**
 * How long the world can take to hear of a move within one area: the link
 * sends the place on its report deadline (REPORT_INTERVAL_MS, 10 s), and only
 * an arrival in another area goes at once. `__fsDevSaveSoon` stores the
 * outbox record; it sends no report. Poll a saved place for this long.
 */
export const PLACE_REPORTED_MS = REPORT_INTERVAL_MS + 5_000

/** The screen's calendar (the dev hook) on the world's clock: what the server reads now. */
export async function calendarOnServer(page: Page): Promise<number> {
  const now = await moveServerClock(page, 0)
  await page.evaluate((x) => (window as unknown as { __fsDevCalendar: (t: number) => void }).__fsDevCalendar(x), now)
  return now
}

/**
 * Both clocks (the world's and the screen's) to a safe moment from now on
 * whose calendar mark is `mark` (with `outside`, any other mark): one with a
 * whole day of that same mark still ahead and a whole day before the wick's
 * turning (a mark is three wicks, and the outer land turns at each), so no
 * turning lands mid-test, and the calendar the request is checked against is
 * the one set. Returns it.
 * The world's clock moves in steps under 30 days, signing in again between
 * them: a session ends 30 days after it began however much it's used (the
 * server's seasons tests' `jumpToAs` does the same), and a mark can be two
 * months off. Never a fixed date: that would be a date bomb.
 */
export async function seasonOf(page: Page, id: string, mark: string, opts: { outside?: boolean } = {}): Promise<number> {
  const { calendarAt } = await import('../src/lib/calendar.ts')
  const is = (t: number) => (calendarAt(t).mark === mark) !== !!opts.outside
  let now = await moveServerClock(page, 0)
  let t = now
  while (!(is(t) && is(t + DAY) && calendarAt(t).nextTurning - t >= DAY)) t += 3600
  while (now < t) {
    now = await moveServerClock(page, Math.min(t, now + 25 * DAY))
    if (now < t) await signInAgain(page, id)
  }
  return calendarOnServer(page)
}

/**
 * The wick's land (the Whitequiet and beyond) held still for a test: if the
 * wick turns within `slack` (a day), the world's clock forward to an hour
 * into the next one; then the screen's calendar on the world's clock. That
 * land turns at the wick, so a fixture laid near a turning is gone by the
 * time a second page reads it (review 2026-10-11). Call it before the Wilds
 * are first entered (with pinWorld); every other page in the test needs
 * `calendarOnServer(other)` once it has signed in. Crossing a turning is
 * its own test (e2e/wilds-outer.spec.ts). Returns the world's now.
 */
export async function wickSlack(page: Page, slack = DAY): Promise<number> {
  const { calendarAt } = await import('../src/lib/calendar.ts')
  const now = await moveServerClock(page, 0)
  const d = calendarAt(now)
  if (d.nextTurning - now < slack) await moveServerClock(page, d.nextTurning + 3600)
  const at = await calendarOnServer(page)
  expect(calendarAt(at).nextTurning - at, 'the wick has slack before its turning').toBeGreaterThanOrEqual(slack)
  return at
}

/** A fresh Habitica user id per test, so tests never share server state. */
export const newUser = (): string => randomUUID()

function admin(...args: string[]): string {
  return execFileSync(BIN, ['-db', dbPath(), ...args], { encoding: 'utf8' }).trim()
}

/**
 * Test-only lever: run SQL against this worker's database (sqlite3, waiting
 * out the server's locks). Never hard-code a database path in a spec.
 */
export function sql(statements: string): string {
  return execFileSync('sqlite3', ['-cmd', '.timeout 5000', dbPath(), statements], { encoding: 'utf8' }).trim()
}

/**
 * The server's account id for a Habitica subject (A's accounts: random ids,
 * found through `sign_ins`). Test SQL wants it, never the subject.
 */
export function accountOf(habiticaId: string): string {
  const account = sql(`SELECT account_id FROM sign_ins WHERE method='habitica' AND subject='${habiticaId.replace(/'/g, "''")}';`)
    .split('\n').at(-1) || ''
  if (!account) throw new Error(`accountOf: no account for ${habiticaId} (sign in once first)`)
  return account
}

/** Who writes a story mark (content/story.json; the server's `content.MarkWriter`): the longest matching namespace. */
function markWriter(mark: string): string {
  let best = 0
  let writer = ''
  for (const n of story.namespaces) {
    if ((mark === n.prefix || (n.prefix.endsWith(':') && mark.startsWith(n.prefix))) && n.prefix.length > best) {
      best = n.prefix.length
      writer = n.writer
    }
  }
  if (!writer) throw new Error(`seedStory: no namespace writes ${mark}`)
  return writer
}

/** Economy flags live in `outcomes`, not `story_marks` (the server's `rules.EconomyFlag`). */
const economyFlag = (mark: string) => mark === 'embers:welcome' || mark.startsWith('lit:') || mark.startsWith('opened:')

/**
 * Test-only lever: put a story state on an account (replaces the old guest
 * `seedSave`): a quest stage (the lantern road's), any quests' steps, story
 * marks (flags), quest items and a place.
 * `habiticaId` is the subject `freshPlayer` returned (sign in once first).
 * It writes the server's story tables (quest_progress, story_marks, outcomes,
 * player_place) at the account's current version, so a page that is already
 * playing won't see it: follow it with `reenter(page)`, whose sign-in read
 * adopts the server's copy.
 */
export function seedStory(habiticaId: string, o: { quest?: string; quests?: Record<string, string>; marks?: string[]; questItems?: string[]; place?: { area: string; x: number; y: number } }): void {
  const esc = (v: string) => v.replace(/'/g, "''")
  const account = esc(accountOf(habiticaId))
  const at = Math.floor(Date.now() / 1000)
  const stmts: string[] = []
  for (const mark of o.marks ?? []) {
    if (economyFlag(mark)) stmts.push(`INSERT OR IGNORE INTO outcomes(account_id,outcome_id,reason,at) VALUES('${account}','${esc(mark)}','seed',${at});`)
    else stmts.push(`INSERT OR IGNORE INTO story_marks VALUES('${account}','${esc(mark)}','${markWriter(mark)}',${at});`)
  }
  if (o.quest) {
    stmts.push(
      o.quest === 'new'
        ? `DELETE FROM quest_progress WHERE account_id='${account}' AND quest='lantern-road';`
        : `INSERT INTO quest_progress(account_id,quest,step) VALUES('${account}','lantern-road','${esc(o.quest)}') ON CONFLICT(account_id,quest) DO UPDATE SET step=excluded.step;`
    )
  }
  // Any quest's record (src/lib/quests.ts): the step reached.
  for (const [quest, step] of Object.entries(o.quests ?? {})) {
    stmts.push(`INSERT INTO quest_progress(account_id,quest,step) VALUES('${account}','${esc(quest)}','${esc(step)}') ON CONFLICT(account_id,quest) DO UPDATE SET step=excluded.step;`)
  }
  if (o.questItems) {
    stmts.push(`DELETE FROM story_marks WHERE account_id='${account}' AND writer='quest-item';`)
    for (const item of o.questItems) stmts.push(`INSERT OR IGNORE INTO story_marks VALUES('${account}','${esc(item)}','quest-item',${at});`)
  }
  if (o.place) {
    // A place set at the account's version: the client takes it as the server's word.
    stmts.push(
      `UPDATE player_place SET area='${esc(o.place.area)}', x=${o.place.x}, y=${o.place.y}, place_set_version=(SELECT version FROM players WHERE account_id='${account}') WHERE account_id='${account}';`
    )
  }
  sql(stmts.join('\n'))
}

/** Add story marks to an account (see `seedStory`). */
export function seedMarks(habiticaId: string, ...marks: string[]): void {
  seedStory(habiticaId, { marks })
}

/** Owner CLI: let this Habitica id sign in. */
export const allow = (id: string): void => void admin('allowlist', 'add', id)
/** Owner CLI: a single-use invite code. */
export const adminInvite = (): string => admin('invite')

/** Change what the fake Habitica reports for a user (XP, vitals, name, party). */
export async function setHabitica(id: string, o: { name?: string; lvl?: number; exp?: number; hp?: number; mp?: number; party?: string; pets?: Record<string, number>; mounts?: Record<string, boolean>; currentPet?: string; currentMount?: string; class?: string | null }): Promise<void> {
  const res = await fetch(`${habiticaURL()}/__user`, { method: 'POST', body: JSON.stringify({ id, ...o }) })
  expect(res.ok).toBe(true)
}

/** The browser's own Habitica reads go to the same fake hero the server sees. */
export async function routeHabitica(context: BrowserContext): Promise<void> {
  await context.route('https://habitica.com/api/v3/user*', async (route) => {
    const h = route.request().headers()
    const res = await fetch(`${habiticaURL()}/api/v3/user`, { headers: { 'x-api-user': h['x-api-user'] ?? '', 'x-api-key': h['x-api-key'] ?? '' } })
    await route.fulfill({
      status: res.status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: await res.text()
    })
  })
}

/** Paste the labeled pair and press Connect (the guide must be on step 2). */
export async function pasteAndConnect(page: Page, id: string, opts: { invite?: string } = {}): Promise<void> {
  await page.getByLabel('Paste both values').fill(`User ID: ${id}\nAPI Token: ${TOKEN}`)
  if (opts.invite) {
    await page.getByText('Have an invite code?').click()
    await page.getByLabel('Invite code').fill(opts.invite)
  }
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
}

/** Title → "Play as your Habitica hero" → guide step 2. */
export async function openTitleGuide(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: /Play as your Habitica hero/ }).click()
  await page.getByRole('button', { name: 'I have them' }).click()
}

/**
 * Wait for connected play: the world is live and the lease is held
 * (`'outdoors'`: the open map; `'commons'`: the same, on the Commons' fixed
 * ground since the join).
 */
export async function waitForWorld(page: Page, area: string = 'outdoors'): Promise<void> {
  await page.waitForFunction((a) => {
    const s = (window as unknown as { __fsSafety?: () => { areaId: string; transitioning: boolean } | null }).__fsSafety?.()
    return !!s && !s.transitioning && s.areaId === a
  }, area === 'commons' ? 'outdoors' : area)
  await expect.poll(() => linkStatus(page), { timeout: SERVER_ANSWER_MS }).toBe('online')
}

/**
 * Reload the page and Continue into the world (a fresh read of the server's
 * state). First a wait on server state, in the spirit of the old
 * `savedToDisk`: this tab's revision is the world's, so everything this tab
 * did has been uploaded.
 */
export async function reenter(page: Page, area: string = 'outdoors'): Promise<void> {
  await expect
    .poll(async () => {
      const mine = await linkRev(page)
      const world = (await serverState(page)).body.rev
      return mine !== null && mine === world
    }, { timeout: 15_000, message: "the world has this tab's latest revision" })
    .toBe(true)
  await page.reload()
  await page.getByTestId('continue-world').click()
  await waitForWorld(page, area)
}

/**
 * Log out and sign in again from the title (a fresh read of the server's
 * state, like `reenter`). Unlike a reload, this keeps the Habitica link:
 * the details live only in the page's memory, and the Menu's Sync needs them.
 */
export async function signInAgain(page: Page, id: string, area: string = 'outdoors'): Promise<void> {
  await expect
    .poll(async () => {
      const mine = await linkRev(page)
      const world = (await serverState(page)).body.rev
      return mine !== null && mine === world
    }, { timeout: 15_000, message: "the world has this tab's latest revision" })
    .toBe(true)
  await page.keyboard.press('Escape')
  await page.getByTestId('world-card').getByRole('button', { name: 'Log out' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Log out' }).click()
  await page.getByTestId('connect-hero').click()
  await page.getByRole('button', { name: 'I have them' }).click()
  await pasteAndConnect(page, id)
  await waitForWorld(page, area)
}

/**
 * Put a just-signed-in player past the opening (as migration 029 leaves
 * every account that played before it), so a spec starts where the lantern
 * road does: the signpost's last step, then a fresh sign-in to read it.
 */
export async function pastOpening(page: Page, id: string): Promise<void> {
  seedStory(id, { quests: { signpost: 'light-first-lamp' } })
  await signInAgain(page, id)
}

/** The running link's status, read through the HUD state (null for guests). */
export async function linkStatus(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as { __fsLink?: () => string | null }).__fsLink?.() ?? null)
}

/** The revision this tab's link is based on (null for guests). */
export async function linkRev(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as unknown as { __fsLinkRev?: () => number | null }).__fsLinkRev?.() ?? null)
}

/**
 * Server state for this browser's session cookie, read the way the client
 * reads it (the /api gate's contract header included, the raw PlayerState
 * projected into the game's own shape by the client's parser).
 */
export async function serverState(page: Page): Promise<{ status: number; body: any }> {
  const res = await readApiGet(page, '/api/state')
  if (!res.ok()) return { status: res.status(), body: await res.json().catch(() => null) }
  const { parseState } = await import('../src/lib/api/parse.ts')
  return { status: res.status(), body: parseState(await res.json()) }
}

/** Retry one safe test API read only after a connection reset; never mutations. */
export async function readApiGet(page: Page, path: string): Promise<APIResponse> {
  let attempt = 0
  return retryConnectionResetRead(
    () => page.request.get(path, CONTRACT),
    (error) => {
      attempt++
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`e2e test API GET reset; retrying once: ${JSON.stringify({ path, attempt, error: message, backend: backendDiagnostics() })}`)
    }
  )
}

/** Open the Menu and press "Sync character" (Habitica details must be in memory). */
export async function syncFromMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Sync character' }).click()
}

/**
 * Test-only lever for reading land through the API (0.14): chunk and near
 * reads answer only within sight of the reader's saved place
 * (server/internal/api/sight.go). Returns a function that puts the page's
 * saved place in the middle of chunk (cx, cy), at its version, so the next
 * read sees from there; call it before each read, since the page's own
 * reports (every 10 s) put it back where the hero stands.
 */
export async function seeFrom(page: Page): Promise<(cx: number, cy: number) => void> {
  const account = ((await serverState(page)).body.accountId as string).replace(/'/g, "''")
  return (cx, cy) => {
    sql(`UPDATE player_place SET area='outdoors', x=${(cx * 24 + 12) * 16}, y=${(cy * 24 + 12) * 16} WHERE account_id='${account}';`)
  }
}
