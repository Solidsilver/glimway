import { expect, test, type Page } from './fixtures'
import type { Browser, BrowserContext } from '@playwright/test'
import { newUser, openTitleGuide, pasteAndConnect, routeHabitica, serverState, setHabitica, waitForWorld } from './connected'
import { partyOwner, signInPage } from './party-helpers'
import { animationsDone, expectToast, settleWarden, talkThrough, warden, warp } from './helpers'

/**
 * Playing together (docs/home-server.md "Party worlds and world moves" and
 * "Witnessing"): a newcomer in a party chooses where to live at first sign-in
 * (and a closed tab asks again), and a player standing by sees another speak
 * the naming to the Warden and keeps a journal line for it. Screenshots go to
 * .agent/screens/coop-*.png.
 */
test.use({ server: true })

type Remote = { id: string; name: string }
const remotes = (page: Page) => page.evaluate(() => ((window as unknown as { __fsRemote?: () => Remote[] }).__fsRemote?.() ?? []) as Remote[])
/** The warden, with whether it is resting for someone else's naming (WardenView.witnessRest). */
const wardenNow = async (page: Page) => (await warden(page)) as Awaited<ReturnType<typeof warden>> & { witnessRest: boolean }
const shot = (page: Page, name: string) => page.screenshot({ path: `.agent/screens/coop-${name}.png` })
/** No banner on screen or waiting (an area card lasts ~2.6 s after arriving). */
const noBanner = (page: Page) =>
  expect.poll(() => page.evaluate(() => (window as unknown as { __fsBanners: () => { current: unknown } }).__fsBanners().current), { timeout: 10_000 }).toBeNull()

const PHONE = { width: 390, height: 844 }

/** A fresh context on the title's sign-in guide (`touch`: a phone with a touchscreen). */
async function guest(browser: Browser, baseURL: string, viewport = { width: 1200, height: 760 }, touch = false): Promise<{ ctx: BrowserContext; other: Page }> {
  const ctx = await browser.newContext({ baseURL, viewport, ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) })
  await routeHabitica(ctx)
  const other = await ctx.newPage()
  await openTitleGuide(other)
  return { ctx, other }
}

/** Nothing on the page scrolls sideways, and the control is on screen once scrolled to. */
async function fits(page: Page, control: ReturnType<Page['getByTestId']>): Promise<void> {
  const vp = page.viewportSize()!
  const overflow = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.panel')].filter((e) => e.offsetParent !== null).map((e) => e.scrollWidth - e.clientWidth))
  for (const o of overflow) expect(o).toBeLessThanOrEqual(1)
  await control.scrollIntoViewIfNeeded()
  const b = (await control.boundingBox())!
  expect(b.x).toBeGreaterThanOrEqual(0)
  expect(b.x + b.width).toBeLessThanOrEqual(vp.width)
  expect(b.y + b.height).toBeLessThanOrEqual(vp.height)
}

test('a newcomer in a party is asked where to live, is asked again after closing the tab, and joins the party', async ({ page, browser, baseURL }) => {
  const { party, world } = await partyOwner(page)
  const rue = newUser()
  await setHabitica(rue, { name: 'Rue', party })
  const { ctx, other } = await guest(browser, baseURL!)
  await pasteAndConnect(other, rue)

  const gate = other.getByTestId('world-choice')
  await expect(gate.getByRole('heading')).toHaveText('Welcome, Rue. Where will you set down your pack?')
  await expect(gate.getByTestId('world-choice-party')).toContainText('Join your party’s world')
  await expect(gate.getByTestId('world-choice-party')).toContainText('One traveler calls it home.')
  await expect(gate.getByTestId('world-choice-own')).toContainText('Start a world of your own')
  // Rue came in through the party: codes aren't hers to give, and the gate says so.
  await expect(gate.getByTestId('world-choice-own')).toContainText('Invite codes come from whoever keeps this server')
  await expect(gate).toContainText('the first move is open at once, then travelers rest a day between worlds.')
  await animationsDone(other)
  await shot(other, '01-choice-desktop')
  // Signed in once, the token not kept: the server holds the sign-in, and
  // nothing else goes on until the world is chosen.
  const held = await serverState(other)
  expect(held.status).toBe(409)
  expect(held.body.error.code).toBe('world-choice-required')

  // Closing the tab mid-choice: the next visit asks again, no second sign-in.
  await other.close()
  const again = await ctx.newPage()
  await again.goto('/')
  const resume = again.getByTestId('continue-world')
  await expect(resume).toContainText('Choose where to live.')
  await resume.click()
  await expect(again.getByTestId('world-choice').getByTestId('world-choice-party')).toContainText('One traveler calls it home.')
  await again.getByTestId('world-choice-party').click()
  await waitForWorld(again)
  expect((await serverState(again)).body.worldId).toBe(world)
  // Olive is right there, and the party's offer isn't put to Rue again.
  await expect.poll(async () => (await remotes(again)).map((r) => r.name), { timeout: 15_000 }).toEqual(['Olive'])
  await expect(again.getByTestId('party-prompt')).toHaveCount(0)
  await ctx.close()
})

test('a newcomer on a phone starts a world of their own, and the party’s world stays on offer', async ({ page, browser, baseURL }) => {
  const { party, world } = await partyOwner(page)
  const sam = newUser()
  await setHabitica(sam, { name: 'Sam', party })
  const { ctx, other } = await guest(browser, baseURL!, PHONE, true)
  await pasteAndConnect(other, sam)
  const gate = other.getByTestId('world-choice')
  await expect(gate.getByTestId('world-choice-party')).toBeVisible()
  await fits(other, gate.getByTestId('world-choice-party'))
  await gate.getByRole('heading').scrollIntoViewIfNeeded()
  await animationsDone(other)
  await shot(other, '02-choice-phone')
  await fits(other, gate.getByTestId('world-choice-own'))
  await shot(other, '03-choice-phone-scrolled')
  await gate.getByTestId('world-choice-own').click()
  await waitForWorld(other)
  const own = (await serverState(other)).body.worldId
  expect(own).not.toBe(world)
  // Not prompted at once (they just chose), but the Menu keeps the offer.
  await expect(other.getByTestId('party-prompt')).toHaveCount(0)
  await other.getByRole('button', { name: /Menu/ }).first().click()
  const offer = other.getByTestId('world-party-offer')
  await expect(offer).toContainText('Your party has a world of its own here.')
  await offer.scrollIntoViewIfNeeded()
  await shot(other, '04-own-world-menu-phone')
  // Let in through the party, Sam makes no invite codes, even from his own world.
  const invites = other.getByTestId('invite-party-admitted')
  await expect(invites).toContainText('You came in with your party, so codes aren’t yours to give.')
  expect((await other.request.post('/api/invites', { data: {} })).status()).toBe(403)
  await ctx.close()
})

test('a second player watches the naming, sees the warden rest a moment, and keeps the line', async ({ page, browser, baseURL }) => {
  const { olive, party, world } = await partyOwner(page)
  // Hal comes in through Olive's party, and chooses to live with them.
  const hal = newUser()
  await setHabitica(hal, { name: 'Hal', party })
  const { ctx, other } = await signInPage(browser, baseURL!, hal)
  expect((await serverState(other)).body.worldId).toBe(world)

  // Olive carries the mark up to the shrine path; the warden wakes for her.
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await warp(page, 'ruin', 15, 3)
  await talkThrough(page, /Copy the naming from the stone/)
  await expect.poll(async () => (await warden(page)).state).toBe('active')
  // Hal stands beside her. His own warden hasn't woken: his story is his.
  await warp(other, 'ruin', 15, 3)
  await expect.poll(async () => (await warden(other)).state).toBe('dormant')
  await expect.poll(async () => (await remotes(other)).map((r) => r.name), { timeout: 15_000 }).toEqual(['Olive'])
  await expect.poll(async () => (await remotes(page)).map((r) => r.name), { timeout: 15_000 }).toEqual(['Hal'])

  // (Let the place's title card clear first, for the screenshot.)
  await noBanner(other)
  await settleWarden(page)
  await expectToast(other, 'Olive speaks the naming. The warden’s arms come down, its heart-lamp guttering low. You were there.')
  await expect.poll(async () => (await wardenNow(other)).witnessRest).toBe(true)
  await shot(other, '05-witness-rest')
  // A moment later the stone remembers its pose, and goes on waiting for Hal.
  await expectToast(other, 'The stone remembers its pose.', { timeout: 10_000 })
  const after = await wardenNow(other)
  expect(after.witnessRest).toBe(false)
  expect(after.state).toBe('dormant')

  // The journal line, kept once; Hal's story didn't move.
  await expect
    .poll(async () => {
      const s = (await serverState(other)).body
      return { quest: s.state.quest, seen: s.state.flags.filter((f: string) => f.startsWith('witness:')) }
    })
    .toEqual({ quest: 'new', seen: [`witness:warden:${olive}:Olive`] })
  await other.keyboard.press('j')
  const journal = other.getByRole('dialog', { name: 'Journal' })
  await expect(journal).toContainText('You Were There')
  await expect(journal).toContainText('I stood on the shrine path while Olive spoke the naming.')
  await animationsDone(other)
  await shot(other, '06-witness-journal')
  await ctx.close()
})

