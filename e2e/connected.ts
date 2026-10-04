import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { expect, type BrowserContext, type Page } from '@playwright/test'
import { API_PORT, HABITICA_PORT } from '../playwright.config'
import { waitForArea } from './helpers'

/**
 * Helpers for the connected playtests: the real Go server (through Vite's
 * /api proxy) and the fake Habitica in e2e/server/fake-habitica.ts.
 */

export const HABITICA = `http://127.0.0.1:${HABITICA_PORT}`
export const TOKEN = '99999999-ffff-4eee-9ddd-888888888888'
const BIN = '.e2e-server/fingersnap-server'
const DB = '.e2e-server/fingersnap.sqlite'

/** A fresh Habitica user id per test, so tests never share server state. */
export const newUser = (): string => randomUUID()

function admin(...args: string[]): string {
  return execFileSync(BIN, ['-db', DB, ...args], { encoding: 'utf8' }).trim()
}

/** Owner CLI: let this Habitica id sign in. */
export const allow = (id: string): void => void admin('allowlist', 'add', id)
/** Owner CLI: a single-use invite code. */
export const adminInvite = (): string => admin('invite')

/** Change what the fake Habitica reports for a user (XP, vitals, name). */
export async function setHabitica(id: string, o: { name?: string; lvl?: number; exp?: number; hp?: number; mp?: number }): Promise<void> {
  const res = await fetch(`${HABITICA}/__user`, { method: 'POST', body: JSON.stringify({ id, ...o }) })
  expect(res.ok).toBe(true)
}

/** The browser's own Habitica reads go to the same fake hero the server sees. */
export async function routeHabitica(context: BrowserContext): Promise<void> {
  await context.route('https://habitica.com/api/v3/user*', async (route) => {
    const h = route.request().headers()
    const res = await fetch(`${HABITICA}/api/v3/user`, { headers: { 'x-api-user': h['x-api-user'] ?? '', 'x-api-key': h['x-api-key'] ?? '' } })
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
export async function waitForWorld(page: Page, area: 'village' | 'woodland' | 'ruin' = 'village'): Promise<void> {
  await waitForArea(page, area)
  await expect.poll(() => linkStatus(page)).toBe('online')
}

/** The running link's status, read through the HUD state (null for guests). */
export async function linkStatus(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as { __fsLink?: () => string | null }).__fsLink?.() ?? null)
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
