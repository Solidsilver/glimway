import { expect, test, type Page } from './fixtures'
import type { Browser, BrowserContext } from '@playwright/test'
import { CONTRACT, allow, habiticaURL, newUser, openTitleGuide, pasteAndConnect, pastOpening, reenter, routeHabitica, setHabitica, waitForWorld } from './connected'
import { SERVER_ANSWER_MS, waitForLive } from './helpers'

/**
 * The wardrobe in the game (docs/design/purse-and-wardrobe.md 4, 10.2; lane
 * E): a choice holds through a reload and a friend sees it; Check for new
 * gear finds a piece the fake Habitica just added; a lapsed piece reads as
 * Habitica's after a check without it. Real Go server and fake Habitica;
 * only bundled gear art is used (head_warrior_1, head_wizard_1,
 * shield_warrior_1, the warrior's sword and armor), so nothing waits on the
 * sprite proxy.
 *
 * Needs lane B (the owned list read at sign-in and by POST
 * /api/wardrobe/check, and the fake Habitica's `owned` override) and lane C
 * (POST /api/wardrobe, GET /api/wardrobe, the resolved choice on the state
 * and the look in presence).
 */

type Debug = { layers: string[] }
type Remote = { name: string; gear: Record<string, string | null> | null }

const debug = (page: Page) => page.evaluate(() => (window as unknown as { __fsDebug: () => Debug }).__fsDebug())
const remotes = (page: Page) => page.evaluate(() => ((window as unknown as { __fsRemote?: () => Remote[] }).__fsRemote?.() ?? []) as Remote[])

/** The gear a hero owns on the fake Habitica (`items.gear.owned`: true owned, false lost). */
async function setOwned(id: string, owned: Record<string, boolean>): Promise<void> {
  const res = await fetch(`${habiticaURL()}/__user`, { method: 'POST', body: JSON.stringify({ id, owned }) })
  expect(res.ok).toBe(true)
}

/** The warrior's starter gear (the fake's fixture wears the sword and the armor). */
const STARTER = { weapon_warrior_1: true, armor_warrior_1: true }

/** A new allowlisted Habitica hero owning this gear, signed in and past the opening. */
async function heroOwning(page: Page, name: string, owned: Record<string, boolean>): Promise<string> {
  const id = newUser()
  allow(id)
  await setHabitica(id, { name })
  await setOwned(id, owned)
  await routeHabitica(page.context())
  await openTitleGuide(page)
  await pasteAndConnect(page, id)
  await waitForWorld(page)
  await pastOpening(page, id)
  return id
}

/** The Character panel at its Wardrobe page. */
async function openWardrobe(page: Page): Promise<void> {
  await waitForLive(page)
  await page.keyboard.press('c')
  await page.getByTestId('char-tab-wardrobe').click()
  await expect(page.getByTestId('wardrobe-page')).toBeVisible()
}

/** Out of the gear picker, back to the slot list. */
async function backToWardrobe(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Back to the Wardrobe' }).click()
  await expect(page.getByTestId('wardrobe-picker')).toHaveCount(0)
}

async function closePanel(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('wardrobe-page')).toHaveCount(0)
}

/** The resolved choice the server holds. */
async function serverWardrobe(page: Page): Promise<Record<string, string>> {
  return (await (await page.request.get('/api/state', CONTRACT)).json()).state?.wardrobe?.chosen ?? {}
}

test('a wardrobe choice holds through a reload, and a friend sees it', async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000)
  await heroOwning(page, 'Ash', { ...STARTER, head_warrior_1: true, shield_warrior_1: true })
  await openWardrobe(page)
  await expect(page.getByTestId('wardrobe-slot-head-name')).toHaveText('As on Habitica · none')
  await expect(page.getByTestId('wardrobe-habitica-look')).toBeDisabled()

  await page.getByTestId('wardrobe-change-head').click()
  await expect(page.getByTestId('wardrobe-picker')).toBeVisible()
  await expect(page.getByTestId('wardrobe-pick-first')).toContainText('As on Habitica')
  await page.getByTestId('wardrobe-pick-head_warrior_1').click()
  // The set's other piece is offered above the grid; one tap puts it on.
  await page.getByTestId('wardrobe-wear-set').click()
  await backToWardrobe(page)
  await expect(page.getByTestId('wardrobe-slot-head-name')).toHaveText('Leather Helm')
  await expect(page.getByTestId('wardrobe-slot-shield-name')).toHaveText('Wooden Shield')
  await closePanel(page)
  // At once (predicted), drawn on the hero, and kept by the server.
  await expect.poll(async () => (await debug(page)).layers, { timeout: SERVER_ANSWER_MS }).toContain('head_warrior_1')
  await expect.poll(() => serverWardrobe(page), { timeout: SERVER_ANSWER_MS }).toEqual({ head: 'head_warrior_1', shield: 'shield_warrior_1' })

  await reenter(page)
  await expect.poll(async () => (await debug(page)).layers, { timeout: SERVER_ANSWER_MS }).toContain('head_warrior_1')
  await openWardrobe(page)
  await expect(page.getByTestId('wardrobe-slot-head-name')).toHaveText('Leather Helm')
  await closePanel(page)

  // A friend in the same world sees the look (the server sends it as the costume).
  const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json()
  const ctx: BrowserContext = await (browser as Browser).newContext({ baseURL, viewport: { width: 1200, height: 760 } })
  await routeHabitica(ctx)
  const other = await ctx.newPage()
  const rowan = newUser()
  await setHabitica(rowan, { name: 'Rowan' })
  await openTitleGuide(other)
  await pasteAndConnect(other, rowan, { invite: invite.code })
  await waitForWorld(other)
  await expect
    .poll(async () => (await remotes(other)).map((r) => [r.name, r.gear?.head ?? null, r.gear?.shield ?? null]), { timeout: 15_000 })
    .toEqual([['Ash', 'head_warrior_1', 'shield_warrior_1']])

  // Wear Habitica's look: every slot back, on both screens.
  await page.bringToFront()
  await openWardrobe(page)
  await page.getByTestId('wardrobe-habitica-look').click()
  await expect(page.getByTestId('wardrobe-slot-head-name')).toHaveText('As on Habitica · none')
  await closePanel(page)
  await expect.poll(() => serverWardrobe(page), { timeout: SERVER_ANSWER_MS }).toEqual({})
  // Habitica's own look again: the fixture hero's equipped none-pieces (4.2's
  // lookFor passes `*_base_0` keys through; they draw nothing).
  await expect
    .poll(async () => (await remotes(other)).map((r) => [r.gear?.head ?? null, r.gear?.shield ?? null]), { timeout: 15_000 })
    .toEqual([['head_base_0', 'shield_base_0']])
  await ctx.close()
})

test('Check for new gear finds a piece the fake Habitica just added', async ({ page }) => {
  test.setTimeout(120_000)
  const id = await heroOwning(page, 'Tansy', STARTER)
  await openWardrobe(page)
  await page.getByTestId('wardrobe-change-head').click()
  await expect(page.getByTestId('wardrobe-picker')).toContainText('Nothing else for this slot yet')
  await backToWardrobe(page)

  // A hat earned on Habitica since signing in.
  await setOwned(id, { ...STARTER, head_wizard_1: true })
  await page.getByTestId('wardrobe-check').click()
  await expect(page.getByTestId('wardrobe-message')).toHaveText('Found 1 new piece.', { timeout: SERVER_ANSWER_MS })
  await expect(page.getByTestId('wardrobe-checked')).toContainText('Gear checked with Habitica')
  await page.getByTestId('wardrobe-change-head').click()
  await page.getByTestId('wardrobe-pick-head_wizard_1').click()
  await backToWardrobe(page)
  await expect(page.getByTestId('wardrobe-slot-head-name')).toHaveText('Magician Hat')

  // Asked again with nothing new.
  await page.getByTestId('wardrobe-check').click()
  await expect(page.getByTestId('wardrobe-message')).toHaveText('Nothing new on Habitica.', { timeout: SERVER_ANSWER_MS })
})

test('a lapsed piece reads as Habitica\'s after a check without it', async ({ page }) => {
  test.setTimeout(120_000)
  const id = await heroOwning(page, 'Tansy', { ...STARTER, head_wizard_1: true })
  await openWardrobe(page)
  await page.getByTestId('wardrobe-change-head').click()
  await page.getByTestId('wardrobe-pick-head_wizard_1').click()
  await backToWardrobe(page)
  await expect(page.getByTestId('wardrobe-slot-head-name')).toHaveText('Magician Hat')
  await expect.poll(() => serverWardrobe(page), { timeout: SERVER_ANSWER_MS }).toEqual({ head: 'head_wizard_1' })

  // Lost on Habitica (a warrior's death penalty reads as false in the owned map).
  await setOwned(id, { ...STARTER, head_wizard_1: false })
  await page.getByTestId('wardrobe-check').click()
  await expect(page.getByTestId('wardrobe-message')).toHaveText('Nothing new on Habitica.', { timeout: SERVER_ANSWER_MS })
  await expect(page.getByTestId('wardrobe-slot-head-name')).toHaveText('As on Habitica · none')
  await expect.poll(() => serverWardrobe(page), { timeout: SERVER_ANSWER_MS }).toEqual({})
  await closePanel(page)
  await expect.poll(async () => (await debug(page)).layers, { timeout: SERVER_ANSWER_MS }).not.toContain('head_wizard_1')
})
