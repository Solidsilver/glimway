import { expect, test, type Page } from './fixtures'
import { setHabitica } from './connected'
import { warp } from './helpers'
import { homesteadAlone, partyOwner, settledElsewhere, signInPage } from './party-helpers'

/**
 * Screenshots of the party prompt, the Menu's world card and the move
 * confirmation, on a desktop and on a touchscreen phone (on-screen controls
 * showing). Hal holds a deed alone, so the confirmation shows the land going
 * quiet. Only with SCREENS=1 (saved to .agent/screens/).
 */
test.use({ server: true })

const sizes = [
  ['desktop', { width: 1200, height: 760 }],
  ['phone', { width: 390, height: 844 }]
] as const

/** Nothing scrolls sideways, and the control is on screen once scrolled to. */
async function fits(page: Page, vp: { width: number; height: number }, control: ReturnType<Page['getByRole']>): Promise<void> {
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.panel')].filter((e) => e.offsetParent !== null).map((e) => e.scrollWidth - e.clientWidth)
  )
  for (const o of overflow) expect(o).toBeLessThanOrEqual(1)
  await control.scrollIntoViewIfNeeded()
  const b = (await control.boundingBox())!
  expect(b.x).toBeGreaterThanOrEqual(0)
  expect(b.x + b.width).toBeLessThanOrEqual(vp.width)
  expect(b.y + b.height).toBeLessThanOrEqual(vp.height)
}

for (const [name, vp] of sizes) {
  test(`party screens: the prompt and the move (${name})`, async ({ page, browser, baseURL }) => {
    test.skip(!process.env.SCREENS, 'screenshots only (SCREENS=1)')
    const shot = async (p: Page, n: string) => {
      await p.waitForTimeout(350)
      await p.screenshot({ path: `.agent/screens/${n}-${name}.png` })
    }
    const { party } = await partyOwner(page)
    const hal = await settledElsewhere(browser, baseURL!, 'Hal')
    homesteadAlone(hal.id, hal.world)
    await setHabitica(hal.id, { party })
    const phone = name === 'phone'
    const { ctx, other } = await signInPage(browser, baseURL!, hal.id, vp, phone)
    await other.evaluate(() => document.fonts.ready)

    const prompt = other.getByTestId('party-prompt')
    await expect(prompt).toBeVisible()
    await fits(other, vp, prompt.getByRole('button', { name: 'Join them…' }))
    if (phone) {
      // The touch controls are up, and the card sits clear of them.
      const pad = other.locator('.controls')
      await expect(pad).toBeVisible()
      const card = (await prompt.boundingBox())!
      for (const b of await other.locator('.controls .pad, .controls button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top))) {
        expect(card.y + card.height).toBeLessThanOrEqual(b)
      }
    }
    await shot(other, 'party-01-prompt')

    await prompt.getByRole('button', { name: 'Join them…' }).click()
    const move = other.getByRole('dialog', { name: 'Move to your party’s world?' })
    await expect(move).toBeVisible()
    await expect(move.getByRole('button', { name: 'Move to your party’s world' })).toBeEnabled()
    await expect(move.getByTestId('move-last')).toContainText('the land will slowly go quiet')
    await expect(move.getByTestId('move-deed')).toBeVisible()
    await shot(other, 'party-02-move-confirm')
    // Scroll the panel itself to its end, as a thumb would.
    const panel = move.locator('.panel')
    const scrolled = await panel.evaluate((el) => {
      el.scrollTop = el.scrollHeight
      return el.scrollTop
    })
    if (phone) expect(scrolled).toBeGreaterThan(0)
    await expect(move.getByText('Old homes aren’t kept for you.')).toBeInViewport()
    await fits(other, vp, move.getByRole('button', { name: 'Move to your party’s world' }))
    await shot(other, 'party-03-move-confirm-scrolled')
    await move.getByRole('button', { name: 'Stay here' }).click()

    await other.keyboard.press('Escape')
    const card = other.getByTestId('world-settings')
    await expect(card).toContainText('Your party has a world of its own here.')
    await card.scrollIntoViewIfNeeded()
    await shot(other, 'party-04-menu-world')

    // Blocked: not from the woods.
    await other.getByRole('button', { name: 'Back to the road' }).click()
    await warp(other, 'woodland', 15, 20)
    await other.keyboard.press('Escape')
    await card.getByRole('button', { name: 'Join them…' }).click()
    await expect(move.getByTestId('move-blocks')).toBeVisible()
    await expect(move.getByRole('button', { name: 'Move to your party’s world' })).toBeDisabled()
    await move.getByTestId('move-blocks').scrollIntoViewIfNeeded()
    await shot(other, 'party-05-move-blocked')
    await ctx.close()
  })
}
