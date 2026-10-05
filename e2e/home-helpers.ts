import { execFileSync } from 'node:child_process'
import { expect, type Page } from './fixtures'
import { allow, newUser, openTitleGuide, pasteAndConnect, routeHabitica, setHabitica, syncFromMenu, waitForWorld } from './connected'
import { beginNewJourney, waitForArea, player } from './helpers'

/**
 * Helpers for the homestead and village-life playtests (real Go server).
 * SCREENS=1 makes `shot` save desktop + phone screenshots to .agent/screens/.
 */

export const OUT = '.agent/screens'
export type Area = 'village' | 'woodland' | 'ruin'

export interface HomesView {
  status: string
  claimed: boolean
  plots: { slot: number; ownerId: string; name: string; tier: number; allocated: boolean; mine: boolean }[]
  mine: { tier: number; items: { id: string; itemDef: string; scene: string | null; x: number | null; y: number | null; rotation: number | null }[] } | null
  slots: { index: number; tx: number; ty: number; door: { tx: number; ty: number }; doorstep: { tx: number; ty: number }; sign: { tx: number; ty: number } }[]
  features: { silas: { tx: number; ty: number } } | null
  placing: boolean
}

export const homes = (page: Page) => page.evaluate(() => (window as unknown as { __fsHomes: () => HomesView }).__fsHomes())
export const area = (page: Page) => page.evaluate(() => (window as unknown as { __fsSafety: () => { areaId: string } }).__fsSafety().areaId)
export const hurt = (page: Page, n: number) => page.evaluate((d) => (window as unknown as { __fsDevHurt: (n: number) => void }).__fsDevHurt(d), n)
export const place = (page: Page, x: number, y: number) => page.evaluate(([px, py]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(px, py), [x, y] as const)

/** Desktop and phone screenshots of the same moment (names end -desktop / -phone). */
export async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.SCREENS) return
  const base = name.replace(/-desktop$/, '')
  const size = page.viewportSize()!
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/${base}-desktop.png` })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/${base}-phone.png` })
  await page.setViewportSize(size)
  await page.waitForTimeout(400)
}

/** Dev warp, for any area id (the Commons included). */
export async function go(page: Page, to: string, tx: number, ty: number): Promise<void> {
  await page.evaluate(([a, x, y]) => (window as unknown as { __fsDevWarp: (a: string, x: number, y: number) => void }).__fsDevWarp(a as string, x as number, y as number), [to, tx, ty] as const)
  await page.waitForFunction(() => (window as unknown as { __fsSafety: () => { transitioning: boolean } }).__fsSafety().transitioning === true, undefined, { timeout: 2000 }).catch(() => {})
  await waitForArea(page, to as Area)
}

/** Talk at the prompt; pick the choice named `pick` (if any), and read to the end. */
export async function talk(page: Page, prompt: RegExp, pick?: RegExp): Promise<void> {
  await expect(page.locator('.prompt')).toContainText(prompt)
  await page.waitForTimeout(250)
  await page.keyboard.press('e')
  const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
  await expect(dialogue).toBeVisible()
  let picked = !pick
  for (let i = 0; i < 40 && (await dialogue.isVisible()); i++) {
    const choice = page.locator('.choice').first()
    if (!picked && (await choice.isVisible().catch(() => false))) {
      await page.locator('.choice', { hasText: pick! }).click()
      picked = true
    } else {
      if (await choice.isVisible().catch(() => false)) await page.keyboard.press('Escape')
      else await page.keyboard.press('e')
    }
    await page.waitForTimeout(220)
  }
  await expect(dialogue).toBeHidden()
}

/** Sign in from the title as a new allowlisted player. */
export async function freshPlayer(page: Page, name = 'Tansy', invite?: string): Promise<string> {
  const id = newUser()
  if (!invite) allow(id)
  await setHabitica(id, { name })
  await routeHabitica(page.context())
  await openTitleGuide(page)
  await pasteAndConnect(page, id, invite ? { invite } : {})
  await waitForWorld(page)
  return id
}

/** Two syncs: the welcome, then a big Habitica day (three levels: about 30 embers). */
export async function earnEmbers(page: Page, id: string): Promise<void> {
  let balance = 0
  for (const [lvl, exp, toast] of [[2, 20, /embers into your hand/], [5, 100, /embers — from the XP you earned/]] as const) {
    await setHabitica(id, { lvl, exp })
    balance = await syncEmberBalance(page)
    await expect(page.locator('.toast', { hasText: toast })).toBeVisible()
    await page.getByRole('button', { name: 'Back to the road' }).click()
  }
  expect(balance).toBeGreaterThanOrEqual(20)
}

/**
 * Confirm the real server's balance from the sync that earned it. A separate
 * page.request read can spend the whole poll budget resolving localhost even
 * after the browser has received the successful sync and shown its toast.
 */
async function syncEmberBalance(page: Page): Promise<number> {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/sync') && r.request().method() === 'POST'),
    syncFromMenu(page)
  ])
  expect(response.ok()).toBe(true)
  return (await response.json()).state.embers as number
}

/** Read an open conversation (one the world opened on its own) to its end. */
export async function readOn(page: Page, says: RegExp): Promise<void> {
  const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
  // The talk loop may already have read it (it follows the answer closely).
  await dialogue.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {})
  if (!(await dialogue.isVisible())) return
  await expect(dialogue).toContainText(says)
  for (let i = 0; i < 12 && (await dialogue.isVisible()); i++) {
    await page.keyboard.press('e')
    await page.waitForTimeout(220)
  }
  await expect(dialogue).toBeHidden()
}

export async function silasSays(page: Page, pick?: RegExp): Promise<void> {
  const v = await homes(page)
  await go(page, 'commons', v.features!.silas.tx, v.features!.silas.ty + 1)
  await talk(page, /Talk to Silas/, pick)
}

export async function myHome(page: Page, id: string) {
  const res = await page.request.get(`/api/homestead/${id}`)
  expect(res.ok()).toBe(true)
  return (await res.json()).home as { tier: number; plotIndex: number; items: { id: string; itemDef: string; scene: string | null; x: number | null; y: number | null; rotation: number | null }[] }
}


/**
 * Test-only lever: put Wilds goods straight into a player's pack in the e2e
 * database (the Wilds client isn't on this branch, so nothing gathers them).
 * The server reads balances from these tables on every request.
 */
export function fund(id: string, goods: { materials?: Record<string, number>; items?: Record<string, number> }): void {
  const esc = (v: string) => v.replace(/'/g, "''")
  const sql: string[] = []
  for (const [m, n] of Object.entries(goods.materials ?? {}))
    sql.push(`INSERT INTO materials(habitica_id,material,qty) VALUES('${esc(id)}','${esc(m)}',${n}) ON CONFLICT(habitica_id,material) DO UPDATE SET qty=excluded.qty;`)
  for (const [i, n] of Object.entries(goods.items ?? {}))
    sql.push(`INSERT INTO inventory VALUES('${esc(id)}','${esc(i)}',${n}) ON CONFLICT(habitica_id,item_def) DO UPDATE SET qty=excluded.qty;`)
  execFileSync('sqlite3', ['-cmd', '.timeout 5000', '.e2e-server/fingersnap.sqlite', sql.join('\n')])
}

/** Three syncs: the welcome, then two big Habitica days (enough embers for a workshop). */
export async function earnPlenty(page: Page, id: string): Promise<void> {
  await earnEmbers(page, id)
  await setHabitica(id, { lvl: 9, exp: 100 })
  const balance = await syncEmberBalance(page)
  await expect(page.locator('.toast', { hasText: /embers — from the XP you earned/ }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Back to the road' }).click()
  expect(balance).toBeGreaterThanOrEqual(60)
}
