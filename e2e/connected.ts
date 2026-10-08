import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { expect, type BrowserContext, type Page } from '@playwright/test'
import contract from '../content/contract.json' with { type: 'json' }
import { BIN, requireBackend } from './server/backend.ts'
import { FAKE_TOKEN } from './server/fake-habitica.ts'

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

/**
 * Test-only lever: put a story state on an account (replaces the old guest
 * `seedSave`): a quest stage, story marks (flags), quest items and a place.
 * `habiticaId` is the subject `freshPlayer` returned (sign in once first);
 * the change lands on the account's progress document, so a page that is
 * already playing won't see it — follow it with `reenter(page)`
 * (TODO(B): write the new story tables instead, once the server loads them).
 */
export function seedStory(habiticaId: string, o: { quest?: string; marks?: string[]; questItems?: string[]; place?: { area: string; x: number; y: number } }): void {
  const esc = (v: string) => v.replace(/'/g, "''")
  const account = esc(accountOf(habiticaId))
  const stmts: string[] = []
  for (const mark of o.marks ?? []) stmts.push(`UPDATE progress SET doc_json = json_insert(doc_json, '$.flags[#]', '${esc(mark)}') WHERE account_id='${account}';`)
  if (o.quest) stmts.push(`UPDATE progress SET doc_json = json_set(doc_json, '$.quest', '${esc(o.quest)}') WHERE account_id='${account}';`)
  if (o.questItems?.length) {
    // The array goes in as a SQL string literal (double quotes mean
    // identifiers on their own).
    const items = JSON.stringify(o.questItems.map(esc)).replace(/'/g, "''")
    stmts.push(`UPDATE progress SET doc_json = json_set(doc_json, '$.inventory', json('${items}')) WHERE account_id='${account}';`)
  }
  if (o.place) {
    stmts.push(
      `UPDATE progress SET doc_json = json_set(doc_json, '$.area', '${esc(o.place.area)}', '$.position.x', ${Math.round(o.place.x)}, '$.position.y', ${Math.round(o.place.y)}) WHERE account_id='${account}';`
    )
  }
  sql(stmts.join('\n'))
}

/** Owner CLI: let this Habitica id sign in. */
export const allow = (id: string): void => void admin('allowlist', 'add', id)
/** Owner CLI: a single-use invite code. */
export const adminInvite = (): string => admin('invite')

/** Change what the fake Habitica reports for a user (XP, vitals, name, party). */
export async function setHabitica(id: string, o: { name?: string; lvl?: number; exp?: number; hp?: number; mp?: number; party?: string }): Promise<void> {
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

/** Wait for connected play: the world is live and the lease is held. */
export async function waitForWorld(page: Page, area: string = 'village'): Promise<void> {
  await page.waitForFunction((a) => {
    const s = (window as unknown as { __fsSafety?: () => { areaId: string; transitioning: boolean } | null }).__fsSafety?.()
    return !!s && !s.transitioning && (a === 'wilds' ? s.areaId.startsWith('chunk:inner-1') : s.areaId === a)
  }, area)
  await expect.poll(() => linkStatus(page)).toBe('online')
}

/**
 * Reload the page and Continue into the world (a fresh read of the server's
 * state). First a wait on server state, in the spirit of the old
 * `savedToDisk`: this tab's revision is the world's, so everything this tab
 * did has been uploaded.
 */
export async function reenter(page: Page, area: string = 'village'): Promise<void> {
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
  const res = await page.request.get('/api/state', CONTRACT)
  if (!res.ok()) return { status: res.status(), body: await res.json().catch(() => null) }
  const { parseState } = await import('../src/lib/api/parse.ts')
  return { status: res.status(), body: parseState(await res.json()) }
}

/** Open the Menu and press "Sync character" (Habitica details must be in memory). */
export async function syncFromMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Sync character' }).click()
}
