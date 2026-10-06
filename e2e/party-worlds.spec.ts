import { expect, test, type Page } from './fixtures'
import { allow, newUser, serverState, setHabitica, waitForWorld } from './connected'
import { partyOwner, settledElsewhere, signInPage } from './party-helpers'
import { expectToast, warp } from './helpers'

/**
 * Party-linked worlds (docs/expansion-design.md "Worlds"): being in the same
 * Habitica party counts as an invite, a settled member is asked once whether
 * to join their party's world, and the move itself.
 */
test.use({ server: true })

type Remote = { id: string; name: string }
const remotes = (page: Page) => page.evaluate(() => ((window as unknown as { __fsRemote?: () => Remote[] }).__fsRemote?.() ?? []) as Remote[])

const worldView = async (page: Page) => (await page.request.get('/api/world')).json()

test('a party member signs in and lands in the owner’s world', async ({ page, browser, baseURL }) => {
  const { party, world } = await partyOwner(page)
  const rue = newUser()
  allow(rue)
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
  await expect(other.getByTestId('world-settings')).toContainText('You live in Olive’s world.')
  await expect(other.getByTestId('world-settings')).toContainText('2 travelers call it home.')
  await ctx.close()
})

test('a settled member is asked once, then moves into the party’s world', async ({ page, browser, baseURL }) => {
  const { party, world } = await partyOwner(page)
  const hal = await settledElsewhere(browser, baseURL!, 'Hal')
  expect(hal.world).not.toBe(world)
  // Hal joins the party; the next sign-in reads it.
  await setHabitica(hal.id, { party })
  const { ctx, other } = await signInPage(browser, baseURL!, hal.id)

  const prompt = other.getByTestId('party-prompt')
  await expect(prompt).toContainText('Your party plays in Olive’s world. Join them?')
  await expect.poll(async () => (await worldView(other)).prompt).toBe(false)
  await prompt.getByRole('button', { name: 'Not now' }).click()
  await expect(prompt).toHaveCount(0)

  // Shown once: a reload and Continue don't ask again.
  await other.reload()
  await other.getByRole('button', { name: /Continue/ }).click()
  await waitForWorld(other)
  await expect(other.locator('.hud')).toBeVisible()
  await expect(other.getByTestId('party-prompt')).toHaveCount(0)

  // Found again in the Menu. Not from the woods, though.
  await warp(other, 'woodland', 15, 20)
  await other.keyboard.press('Escape')
  const offer = other.getByTestId('world-party-offer')
  await expect(offer).toContainText('Your party plays in Olive’s world.')
  await offer.getByRole('button', { name: 'Join them…' }).click()
  const move = other.getByRole('dialog', { name: 'Move to Olive’s world?' })
  await expect(move).toBeVisible()
  await expect(move.getByTestId('move-blocks')).toContainText('Walk to the village or the Commons first.')
  await expect(move.getByRole('button', { name: 'Move to Olive’s world' })).toBeDisabled()
  await move.getByRole('button', { name: 'Stay here' }).click()
  await expect(move).toHaveCount(0)

  await warp(other, 'village', 16, 14)
  await other.keyboard.press('Escape')
  await other.getByTestId('world-party-offer').getByRole('button', { name: 'Join them…' }).click()
  await expect(move).toContainText('Comes with you')
  await expect(move).toContainText('Your personal chest')
  await expect(move).toContainText('Stays behind')
  await expect(move).toContainText('Village project gifts, still credited there')
  await expect(move.getByTestId('move-blocks')).toHaveCount(0)
  await move.getByRole('button', { name: 'Move to Olive’s world' }).click()
  await expectToast(other, 'You set down your pack in Olive’s world.')
  await expect(move).toHaveCount(0)
  await waitForWorld(other)

  expect((await serverState(other)).body.worldId).toBe(world)
  // Presence came along: they see each other in Olive's village.
  await expect.poll(async () => (await remotes(other)).map((r) => r.name), { timeout: 15_000 }).toEqual(['Olive'])
  await expect.poll(async () => (await remotes(page)).map((r) => r.name), { timeout: 15_000 }).toEqual(['Hal'])
  // The Menu knows: living in Olive's world, with the way home on offer.
  await other.keyboard.press('Escape')
  await expect(other.getByTestId('world-settings')).toContainText('You live in Olive’s world.')
  await expect(other.getByTestId('world-own-offer')).toBeVisible()
  await expect(other.getByTestId('world-party-offer')).toHaveCount(0)
  await ctx.close()
})
