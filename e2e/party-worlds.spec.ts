import { expect, test, type Page } from './fixtures'
import { newUser, serverState, setHabitica, TOKEN, waitForWorld, CONTRACT } from './connected'
import { partyOwner, settledElsewhere, signInPage } from './party-helpers'
import { expectToast, waitForWilds, warp, wilds } from './helpers'

/**
 * Party worlds (docs/expansion-design.md "Worlds"): a party's world belongs
 * to the party, its members sign in with no code, a settled member is asked
 * once whether to join it, the move itself, and a day between moves.
 */

type Remote = { id: string; name: string }
const remotes = (page: Page) => page.evaluate(() => ((window as unknown as { __fsRemote?: () => Remote[] }).__fsRemote?.() ?? []) as Remote[])

const worldView = async (page: Page) => (await page.request.get('/api/world', CONTRACT)).json()

test('a party member signs in with no code and, choosing it, lands in the party’s world', async ({ page, browser, baseURL }) => {
  const { party, world } = await partyOwner(page)
  // Not allowlisted, no invite code: the party is enough.
  const rue = newUser()
  await setHabitica(rue, { name: 'Rue', party })
  const { ctx, other } = await signInPage(browser, baseURL!, rue)
  expect((await serverState(other)).body.worldId).toBe(world)
  // Olive is right there in the village (and sees Rue).
  await expect.poll(async () => (await remotes(other)).map((r) => r.name), { timeout: 15_000 }).toEqual(['Olive'])
  await expect.poll(async () => (await remotes(page)).map((r) => r.name), { timeout: 15_000 }).toEqual(['Rue'])
  // Already where the party plays: nothing to ask.
  expect((await worldView(other)).prompt).toBe(false)
  await expect(other.getByTestId('party-prompt')).toHaveCount(0)
  await other.keyboard.press('Escape')
  await expect(other.getByTestId('world-settings')).toContainText('You live in your party’s world.')
  await expect(other.getByTestId('world-settings')).toContainText('2 travelers call it home.')
  await expect(other.getByTestId('world-party-home')).toContainText('Party members come straight in, no code needed.')
  await ctx.close()
})

test('someone outside the party still needs a code', async ({ page, browser, baseURL }) => {
  await partyOwner(page)
  const ned = newUser()
  await setHabitica(ned, { name: 'Ned', party: newUser() })
  // Ned signs in from a device of his own (the page's session cookie would
  // answer for Olive).
  const ned_ctx = await browser.newContext({ baseURL })
  const res = await ned_ctx.request.post('/api/session', { data: { userId: ned, token: TOKEN }, ...CONTRACT })
  expect(res.status()).toBe(403)
  expect((await res.json()).error.code).toBe('access-denied')
  await ned_ctx.close()
})

test('a settled member is asked once, then moves into the party’s world', async ({ page, browser, baseURL }) => {
  // Two sign-ins, a move and both worlds' Wilds: more than the usual budget.
  test.setTimeout(150_000)
  const { party, world } = await partyOwner(page)
  const hal = await settledElsewhere(browser, baseURL!, 'Hal')
  expect(hal.world).not.toBe(world)
  // Hal joins the party; the next sign-in reads it.
  await setHabitica(hal.id, { party })
  const { ctx, other } = await signInPage(browser, baseURL!, hal.id)

  const prompt = other.getByTestId('party-prompt')
  await expect(prompt).toContainText('Your party has a world of its own here. Join them?')
  await expect.poll(async () => (await worldView(other)).prompt).toBe(false)
  await prompt.getByRole('button', { name: 'Not now' }).click()
  await expect(prompt).toHaveCount(0)

  // Shown once: a reload and Continue don't ask again.
  await other.reload()
  const resume = other.getByRole('button', { name: /Continue/ })
  await expect(resume).toBeVisible()
  await resume.click()
  await waitForWorld(other)
  await expect(other.locator('.hud')).toBeVisible()
  await expect(other.getByTestId('party-prompt')).toHaveCount(0)

  // A look at Hal's own Wilds first (the region read is kept a while).
  await warp(other, 'wilds', 2, 22)
  await waitForWilds(other)
  const ownEpoch = (await wilds(other)).epochId

  // Found again in the Menu. Not from the woods, though.
  await warp(other, 'woodland', 15, 20)
  await other.keyboard.press('Escape')
  const offer = other.getByTestId('world-party-offer')
  await expect(offer).toContainText('Your party has a world of its own here.')
  await offer.getByRole('button', { name: 'Join them…' }).click()
  const move = other.getByRole('dialog', { name: 'Move to your party’s world?' })
  await expect(move).toBeVisible()
  await expect(move.getByTestId('move-blocks')).toContainText('Walk to the village or the Commons first.')
  await expect(move.getByRole('button', { name: 'Move to your party’s world' })).toBeDisabled()
  await move.getByRole('button', { name: 'Stay here' }).click()
  await expect(move).toHaveCount(0)

  await warp(other, 'village', 16, 14)
  await other.keyboard.press('Escape')
  // The Menu's world card draws the offer only once its GET /api/world has
  // landed (WorldCard refreshes on mount): wait for the reply's button before
  // clicking it, or the click waits out the test on an empty Menu.
  const joinOffer = other.getByTestId('world-party-offer').getByRole('button', { name: 'Join them…' })
  await expect(joinOffer).toBeVisible()
  await joinOffer.click()
  await expect(move).toContainText('Comes with you')
  await expect(move).toContainText('Your personal chest')
  await expect(move).toContainText('Stays behind')
  await expect(move).toContainText('Village project gifts, still credited there')
  await expect(move.getByTestId('move-blocks')).toHaveCount(0)
  await move.getByRole('button', { name: 'Move to your party’s world' }).click()
  await expectToast(other, 'You set down your pack in your party’s world.')
  await expect(move).toHaveCount(0)
  await waitForWorld(other)

  expect((await serverState(other)).body.worldId).toBe(world)
  // Presence came along: they see each other in Olive's village.
  await expect.poll(async () => (await remotes(other)).map((r) => r.name), { timeout: 15_000 }).toEqual(['Olive'])
  await expect.poll(async () => (await remotes(page)).map((r) => r.name), { timeout: 15_000 }).toEqual(['Hal'])
  // The Menu knows: living in the party's world, with the way home on offer,
  // though not for a day.
  await other.keyboard.press('Escape')
  await expect(other.getByTestId('world-settings')).toContainText('You live in your party’s world.')
  await expect(other.getByTestId('world-party-offer')).toHaveCount(0)
  await other.getByTestId('world-own-offer').getByRole('button', { name: 'Go back…' }).click()
  const back = other.getByRole('dialog', { name: 'Go back to your own world?' })
  await expect(back.getByTestId('move-blocks')).toContainText('Travelers rest a day between worlds. The road opens again in about 24 hours.')
  await expect(back.getByRole('button', { name: 'Go back home' })).toBeDisabled()
  await back.getByRole('button', { name: 'Stay here' }).click()
  await expect(back).toHaveCount(0)
  await other.keyboard.press('Escape')
  const road = other.getByRole('button', { name: 'Back to the road' })
  await expect(road).toBeVisible()

  // The Wilds are Olive's now, not the ones Hal walked a minute ago.
  await road.click()
  await warp(page, 'wilds', 2, 22)
  await waitForWilds(page)
  await warp(other, 'wilds', 2, 22)
  await waitForWilds(other)
  const now = (await wilds(other)).epochId
  expect(now).not.toBe(ownEpoch)
  expect(now).toBe((await wilds(page)).epochId)
  await ctx.close()
})

test('a party’s world takes no invite codes, and a member who leaves the party is warned and can leave at once', async ({ page, browser, baseURL }) => {
  const { party, world } = await partyOwner(page)
  const rue = newUser()
  await setHabitica(rue, { name: 'Rue', party })
  let { ctx, other } = await signInPage(browser, baseURL!, rue)
  // The Menu says why there's no invite button here: for Olive (the
  // operator's), this world takes none; Rue came in through the party, so
  // she makes none anywhere.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('invite-party-world')).toContainText('This world is for your party alone, so it takes no invite codes.')
  await expect(page.getByRole('button', { name: 'Create an invite code' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await other.keyboard.press('Escape')
  await expect(other.getByTestId('invite-party-admitted')).toContainText('You came in with your party, so codes aren’t yours to give.')
  await expect(other.getByRole('button', { name: 'Create an invite code' })).toHaveCount(0)
  // Signing out lets the play lease go, so the next sign-in plays at once.
  expect((await other.request.delete('/api/session', CONTRACT)).ok()).toBe(true)
  await ctx.close()

  // Rue leaves the party; her next sign-in says what will happen.
  await setHabitica(rue, { party: '' })
  ;({ ctx, other } = await signInPage(browser, baseURL!, rue))
  const notice = other.getByTestId('party-leaver')
  await expect(notice).toContainText('You’ve left your party. Unless you rejoin it, you’ll be moved out of its world in 3 days.')
  await notice.getByRole('button', { name: 'Leave now…' }).click()
  const move = other.getByRole('dialog', { name: 'Go to a world of your own?' })
  await expect(move.getByTestId('move-again')).toContainText('Rejoin your party and you can come back')
  await move.getByRole('button', { name: 'Leave now' }).click()
  await expectToast(other, 'You set down your pack in a world of your own.')
  await waitForWorld(other)
  expect((await serverState(other)).body.worldId).not.toBe(world)
  await other.keyboard.press('Escape')
  await expect(other.getByTestId('world-settings')).toContainText('You live in your own world.')
  // Her own world now, but still no codes: party admission doesn't chain.
  const invites = await other.request.get('/api/invites', CONTRACT)
  expect(invites.ok()).toBe(true)
  expect(await invites.json()).toMatchObject({ partyAdmitted: true, partyWorld: false, remaining: 5, outstandingLimit: 3, invites: [] })
  await expect(other.getByTestId('invite-party-admitted')).toBeVisible()
  await expect(other.getByRole('button', { name: 'Create an invite code' })).toHaveCount(0)
  await ctx.close()
})
