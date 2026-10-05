import { expect, test, type Page } from './fixtures'
import type { Browser, BrowserContext } from '@playwright/test'
import { allow, newUser, openTitleGuide, pasteAndConnect, routeHabitica, setHabitica, waitForWorld } from './connected'
import { waitForArea } from './helpers'

/**
 * Presence (phase 6) against the real Go server: two players in one world
 * (the second joins with the first one's invite), each in their own browser
 * context. SCREENS=1 saves screenshots to .agent/screens/.
 */
test.use({ server: true })

type Remote = { id: string; name: string; x: number; y: number; alpha: number; moving: boolean; avatar: boolean; bubble: string | null }
const remotes = (page: Page) => page.evaluate(() => ((window as unknown as { __fsRemote?: () => Remote[] }).__fsRemote?.() ?? []) as Remote[])
const presenceState = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fsPresence?: () => { status: string; area: string | null; peers: string[] } }).__fsPresence?.() ?? null)

async function go(page: Page, to: string, tx: number, ty: number): Promise<void> {
  await page.evaluate(([a, x, y]) => (window as unknown as { __fsDevWarp: (a: string, x: number, y: number) => void }).__fsDevWarp(a as string, x as number, y as number), [to, tx, ty] as const)
  await page.waitForFunction(() => (window as unknown as { __fsSafety: () => { transitioning: boolean } }).__fsSafety().transitioning === true).catch(() => {})
  await waitForArea(page, to as 'village')
}

/** Player one signs in from the title; player two joins their world with an invite. */
async function twoPlayers(page: Page, browser: Browser, baseURL: string, viewport?: { width: number; height: number }) {
  const ash = newUser()
  const rowan = newUser()
  allow(ash)
  await setHabitica(ash, { name: 'Ash' })
  await setHabitica(rowan, { name: 'Rowan' })
  await routeHabitica(page.context())
  await openTitleGuide(page)
  await pasteAndConnect(page, ash)
  await waitForWorld(page)
  const invite = await (await page.request.post('/api/invites', { data: {} })).json()

  const ctx: BrowserContext = await browser.newContext({ baseURL, viewport: viewport ?? { width: 1200, height: 760 } })
  await routeHabitica(ctx)
  const other = await ctx.newPage()
  await openTitleGuide(other)
  await pasteAndConnect(other, rowan, { invite: invite.code })
  await waitForWorld(other)
  return { other, ctx, ash, rowan }
}

async function seeEachOther(page: Page, other: Page): Promise<void> {
  await expect.poll(async () => (await remotes(page)).map((r) => r.name), { timeout: 15_000 }).toEqual(['Rowan'])
  await expect.poll(async () => (await remotes(other)).map((r) => r.name), { timeout: 15_000 }).toEqual(['Ash'])
  await expect.poll(async () => (await remotes(page))[0]?.alpha ?? 0).toBe(1)
}

test('two players in the village see each other move, and walking somewhere else parts them', async ({ page, browser, baseURL }) => {
  const { other, ctx } = await twoPlayers(page, browser, baseURL!)
  await seeEachOther(page, other)
  await expect(page.getByTestId('presence-here')).toHaveText('1 other here')

  // Rowan walks east; Ash sees them glide there, then stop.
  const rowanX = () => other.evaluate(() => (window as unknown as { __fsPlayer: () => { x: number } }).__fsPlayer().x)
  const start = await rowanX()
  await other.bringToFront()
  // Hold until Rowan has really walked (frame rates vary under load).
  await other.keyboard.down('d')
  await expect.poll(rowanX, { timeout: 10_000 }).toBeGreaterThan(start + 30)
  await other.keyboard.up('d')
  await other.waitForTimeout(300)
  const rowanThere = await rowanX()
  await expect.poll(async () => Math.abs((await remotes(page))[0].x - rowanThere), { timeout: 8_000 }).toBeLessThan(2)
  await expect.poll(async () => (await remotes(page))[0].moving).toBe(false)

  // Different areas never see each other.
  await go(other, 'woodland', 15, 20)
  await expect.poll(async () => (await remotes(page)).length, { timeout: 5_000 }).toBe(0)
  await expect.poll(async () => (await remotes(other)).length).toBe(0)
  await expect(page.getByTestId('presence-here')).toHaveCount(0)
  // …and meet again when they share one.
  await go(page, 'woodland', 17, 20)
  await seeEachOther(page, other)
  await ctx.close()
})

test('an emote shows as a bubble over the player, for them and for others', async ({ page, browser, baseURL }) => {
  const { other, ctx } = await twoPlayers(page, browser, baseURL!)
  await seeEachOther(page, other)
  await page.bringToFront()
  await page.keyboard.press('g')
  const picker = page.getByTestId('emote-picker')
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('button')).toHaveCount(6) // five emotes + close
  await page.keyboard.press('1')
  await expect(picker).toBeHidden()
  await expect.poll(async () => (await remotes(other))[0]?.bubble, { timeout: 5_000 }).toBe('Hello!')
  // The cooldown is shown, not silently dropped.
  await page.keyboard.press('g')
  await expect(picker.getByRole('button', { name: 'Cheer' })).toBeDisabled()
  await expect(picker.getByRole('button', { name: 'Cheer' })).toBeEnabled({ timeout: 4_000 })
  await picker.getByRole('button', { name: 'Cheer' }).click()
  await expect.poll(async () => (await remotes(other))[0]?.bubble, { timeout: 5_000 }).toBe('Hooray!')
  await ctx.close()
})

test('a takeover stops the old tab\'s presence socket; the new tab takes its place', async ({ page, browser, baseURL, context }) => {
  const { other, ctx } = await twoPlayers(page, browser, baseURL!)
  await seeEachOther(page, other)
  expect((await presenceState(page))?.status).toBe('live')

  const second = await context.newPage()
  await second.goto('/')
  await second.getByTestId('continue-world').click()
  await second.getByRole('button', { name: 'Take over here' }).click()
  await waitForWorld(second)
  // The old tab's socket is closed by the server (4002) and never reopens.
  await expect.poll(async () => (await presenceState(page))?.status, { timeout: 10_000 }).toMatch(/superseded|off/)
  await page.waitForTimeout(2_500)
  expect((await presenceState(page))?.status).toMatch(/superseded|off/)
  // Rowan still sees Ash: the new tab.
  await expect.poll(async () => (await remotes(other)).map((r) => r.name), { timeout: 10_000 }).toEqual(['Ash'])
  await expect.poll(async () => (await remotes(second)).map((r) => r.name), { timeout: 10_000 }).toEqual(['Rowan'])
  await ctx.close()
})

test('guests have no presence socket', async ({ page }) => {
  const sockets: string[] = []
  page.on('websocket', (ws) => sockets.push(ws.url()))
  await page.goto('/')
  await page.getByRole('button', { name: /Wander as a guest/ }).click()
  await waitForArea(page, 'village')
  await page.waitForTimeout(1_000)
  expect(sockets.filter((u) => u.endsWith('/ws'))).toEqual([])
  expect(await presenceState(page)).toBeNull()
  await expect(page.getByTestId('emote-button')).toHaveCount(0)
})

for (const [name, vp] of [['desktop', { width: 1200, height: 760 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`screens: two players in the village and the Commons, and the emote picker (${name})`, async ({ page, browser, baseURL }) => {
    await page.setViewportSize(vp)
    const { other, ctx } = await twoPlayers(page, browser, baseURL!, vp)
    const shot = async (n: string) => {
      if (!process.env.SCREENS) return
      await page.waitForTimeout(400)
      await page.screenshot({ path: `.agent/screens/${n}-${name}.png` })
    }
    await go(page, 'village', 16, 18)
    await go(other, 'village', 18, 18)
    await seeEachOther(page, other)
    await other.bringToFront()
    await other.keyboard.press('g')
    await other.keyboard.press('1')
    await expect.poll(async () => (await remotes(page))[0]?.bubble, { timeout: 5_000 }).toBe('Hello!')
    await page.bringToFront()
    await shot('20-presence-village')

    await go(page, 'commons', 23, 19)
    await go(other, 'commons', 25, 19)
    await seeEachOther(page, other)
    await shot('21-presence-commons')

    await page.keyboard.press('g')
    await expect(page.getByTestId('emote-picker')).toBeVisible()
    await shot('22-emote-picker')
    await ctx.close()
  })
}
