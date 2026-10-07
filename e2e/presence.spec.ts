import { expect, test, type Page } from './fixtures'
import type { Browser, BrowserContext } from '@playwright/test'
import { allow, linkStatus, newUser, openTitleGuide, pasteAndConnect, routeHabitica, setHabitica, waitForWorld } from './connected'
import { animationsDone, waitForArea, waitForLive, frames, warp, waitFrames, waitGame } from './helpers'

/**
 * Presence against the real Go server: two players in one world
 * (the second joins with the first one's invite), each in their own browser
 * context. SCREENS=1 saves screenshots to .agent/screens/.
 */
test.use({ server: true })

type Remote = { id: string; name: string; x: number; y: number; alpha: number; moving: boolean; avatar: boolean; bubble: string | null; bubbleAlpha: number | null }
const remotes = (page: Page) => page.evaluate(() => ((window as unknown as { __fsRemote?: () => Remote[] }).__fsRemote?.() ?? []) as Remote[])
const presenceState = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fsPresence?: () => { status: string; area: string | null; peers: string[] } }).__fsPresence?.() ?? null)

/** Dev warp to any area id; waits until it has settled. */
const go = (page: Page, to: string, tx: number, ty: number): Promise<void> => warp(page, to, tx, ty)

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

/** Rowan (other) walks east until they have really moved, then stops; returns where they rest. */
async function walkEastAndRest(other: Page): Promise<{ start: number; rest: number }> {
  const rowanX = () => other.evaluate(() => (window as unknown as { __fsPlayer: () => { x: number } }).__fsPlayer().x)
  const start = await rowanX()
  await other.bringToFront()
  // Hold until Rowan has really walked (frame rates vary under load).
  await other.keyboard.down('d')
  await expect.poll(rowanX, { timeout: 10_000 }).toBeGreaterThan(start + 30)
  await other.keyboard.up('d')
  // Where Rowan comes to rest.
  let rest = NaN
  await expect
    .poll(async () => {
      await frames(other, 6)
      const x = await rowanX()
      const still = x === rest
      rest = x
      return still
    })
    .toBe(true)
  return { start, rest }
}

test('two players in the village see each other move, and walking somewhere else parts them', async ({ page, browser, baseURL }) => {
  const { other, ctx } = await twoPlayers(page, browser, baseURL!)
  await seeEachOther(page, other)
  await expect(page.getByTestId('presence-here')).toHaveText('1 other here')

  // Rowan walks east; Ash sees them glide there, then stop. (Exactly where
  // they stop is the known-bug test below.)
  const { start, rest } = await walkEastAndRest(other)
  await waitGame(page, async () => (await remotes(page))[0].x, (x) => x > start + 20, { seconds: 8, message: 'Ash sees Rowan walk east' })
  await expect.poll(async () => (await remotes(page))[0].moving).toBe(false)
  expect(Math.abs((await remotes(page))[0].x - rest)).toBeLessThan(16)

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

// The server drops a position that arrives within 125 ms of the last one;
// the client paces with slack and repeats a final stop once, so the stop
// always lands (bugs #1, tests/presence-client.test.ts).
test('the others see you come to rest exactly where you stopped', async ({ page, browser, baseURL }) => {
  const { other, ctx } = await twoPlayers(page, browser, baseURL!)
  await seeEachOther(page, other)
  const { rest } = await walkEastAndRest(other)
  // Ash's view glides there frame by frame: give it 8 s of Ash's game time.
  await waitGame(page, async () => Math.abs((await remotes(page))[0].x - rest), (d) => d < 2, { seconds: 8, message: 'Ash sees Rowan where they stopped' })
  await expect.poll(async () => (await remotes(page))[0].moving).toBe(false)
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
  // Send Hello. The cooldown is shown, not silently dropped: reopened inside
  // its two (wall-clock) seconds, the picker has the emotes disabled. Checked
  // in the page, every frame. On a starved machine the picker can reopen
  // after the two seconds; that can't tell, so wait it out and send again.
  const cheer = picker.getByRole('button', { name: 'Cheer' })
  let shown: { disabled: boolean; at: number } | null = null
  for (let attempt = 0; attempt < 3 && !shown?.disabled; attempt++) {
    if (attempt > 0) await expect(cheer).toBeEnabled({ timeout: 10_000 })
    const sentAt = await page.evaluate(() => performance.now())
    await page.keyboard.press('1')
    await expect(picker).toBeHidden()
    await page.keyboard.press('g')
    shown = await waitFrames(
      page,
      (t0: number) => {
        const b = document.querySelector('[data-testid="emote-picker"] button[aria-label="Cheer"]') as HTMLButtonElement | null
        if (!b) return null
        const at = Math.round(performance.now() - t0)
        if (b.disabled) return { disabled: true, at }
        return at > 1800 ? { disabled: false, at } : null
      },
      sentAt,
      { seconds: 10, message: 'the picker reopens' }
    )
  }
  expect(shown, 'the cooldown shows on the reopened picker').toEqual(expect.objectContaining({ disabled: true }))
  await expect.poll(async () => (await remotes(other))[0]?.bubble, { timeout: 5_000 }).toBe('Hello!')
  await expect(picker.getByRole('button', { name: 'Cheer' })).toBeEnabled({ timeout: 4_000 })
  await picker.getByRole('button', { name: 'Cheer' }).click()
  await expect.poll(async () => (await remotes(other))[0]?.bubble, { timeout: 5_000 }).toBe('Hooray!')
  await ctx.close()
})

test('a takeover stops the old tab\'s presence socket; the new tab takes its place', async ({ page, browser, baseURL, context }) => {
  const { other, ctx } = await twoPlayers(page, browser, baseURL!)
  await seeEachOther(page, other)
  expect((await presenceState(page))?.status).toBe('live')
  // Every presence socket the old tab opens from here on (there must be none).
  const reopened: string[] = []
  page.on('websocket', (ws) => void (ws.url().endsWith('/ws') && reopened.push(ws.url())))

  const second = await context.newPage()
  await second.goto('/')
  await second.getByTestId('continue-world').click()
  await second.getByRole('button', { name: 'Take over here' }).click()
  await waitForWorld(second)
  // The old tab's socket is closed by the server (4002) and never reopens.
  await expect.poll(async () => (await presenceState(page))?.status, { timeout: 10_000 }).toMatch(/superseded|off/)
  // The old tab's link learns of the takeover (the presence feed asks it at
  // once): from then on the feed keeps the socket off, so no reconnect can come.
  await expect.poll(() => linkStatus(page), { timeout: 10_000 }).toBe('superseded')
  expect((await presenceState(page))?.status).toMatch(/superseded|off/)
  // Rowan still sees Ash: the new tab.
  await expect.poll(async () => (await remotes(other)).map((r) => r.name), { timeout: 10_000 }).toEqual(['Ash'])
  await expect.poll(async () => (await remotes(second)).map((r) => r.name), { timeout: 10_000 }).toEqual(['Rowan'])
  expect(reopened, 'the old tab opened no presence socket').toEqual([])
  expect((await presenceState(page))?.status).toMatch(/superseded|off/)
  await ctx.close()
})

test('guests have no presence socket', async ({ page }) => {
  const sockets: string[] = []
  page.on('websocket', (ws) => sockets.push(ws.url()))
  await page.goto('/')
  await page.getByRole('button', { name: /Wander as a guest/ }).click()
  await waitForArea(page, 'village')
  // Live play has begun: connected play would have started its feed by now.
  await waitForLive(page)
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
      await animationsDone(page)
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
    // The bubble fades in on the canvas (a Phaser tween): wait until it is fully shown.
    await expect.poll(async () => (await remotes(page))[0]?.bubbleAlpha, { timeout: 5_000 }).toBe(1)
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

test('a connection without the binary protocol stops with reload needed', async ({ page, browser, baseURL }) => {
  await page.addInitScript(() => {
    const NativeSocket = window.WebSocket
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, new URL(String(url), location.href).pathname === '/ws' ? undefined : protocols)
      }
    }
  })
  const { other, ctx } = await twoPlayers(page, browser, baseURL!)
  try {
    await expect.poll(async () => (await presenceState(page))?.status).toBe('reload-needed')
    expect(await remotes(page)).toEqual([])
    expect(await remotes(other)).toEqual([])
  } finally { await ctx.close() }
})
