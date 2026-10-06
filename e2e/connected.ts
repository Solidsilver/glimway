import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { expect, type BrowserContext, type Page } from '@playwright/test'
import { BIN, requireBackend } from './server/backend.ts'
import { warp } from './helpers'

/**
 * Helpers for the connected playtests: this worker's own Go server (through
 * the shared Vite) and its fake Habitica (e2e/server/backend.ts). They work
 * inside `test.use({ server: true })` tests.
 */

export const TOKEN = '99999999-ffff-4eee-9ddd-888888888888'

/** This worker's fake Habitica (base URL). */
export const habiticaURL = (): string => requireBackend().habitica
/** This worker's SQLite database (the admin CLI and sqlite3 read it). */
export const dbPath = (): string => requireBackend().db

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

/** The running link's status, read through the HUD state (null for guests). */
export async function linkStatus(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as { __fsLink?: () => string | null }).__fsLink?.() ?? null)
}

/** The revision this tab's link is based on (null for guests). */
export async function linkRev(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as unknown as { __fsLinkRev?: () => number | null }).__fsLinkRev?.() ?? null)
}

/** Server state for this browser's session cookie. */
export async function serverState(page: Page): Promise<{ status: number; body: any }> {
  const res = await page.request.get('/api/state')
  return { status: res.status(), body: res.ok() ? await res.json() : await res.json().catch(() => null) }
}

/** Open the Menu and press "Sync character" (Habitica details must be in memory). */
export async function syncFromMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Sync character' }).click()
}
