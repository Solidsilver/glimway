import { expect, test, type Page } from './fixtures'
import { allow, linkStatus, newUser, openTitleGuide, pasteAndConnect, routeHabitica, TOKEN, waitForWorld } from './connected'
import { beginNewJourney, talkThrough, warp, waitForArea } from './helpers'

/**
 * Layout checks and screenshots for the connected-play screens, at desktop
 * and phone sizes. SCREENS=1 saves images to .agent/screens/.
 */
test.use({ server: true })

const sizes = [
  ['desktop', { width: 1200, height: 760 }],
  ['phone', { width: 390, height: 844 }]
] as const

const hurt = (page: Page, n: number) => page.evaluate((d) => (window as unknown as { __fsDevHurt: (n: number) => void }).__fsDevHurt(d), n)

/** Nothing scrolls sideways, and the named control is on screen once scrolled to. */
async function fits(page: Page, vp: { width: number; height: number }, control?: ReturnType<Page['getByRole']>): Promise<void> {
  const overflow = await page.evaluate(() => {
    const els = [...document.querySelectorAll<HTMLElement>('.panel, .title-col, .hud .card')]
    return els.filter((e) => e.offsetParent !== null).map((e) => e.scrollWidth - e.clientWidth)
  })
  for (const o of overflow) expect(o).toBeLessThanOrEqual(1)
  if (control) {
    await control.scrollIntoViewIfNeeded()
    const b = (await control.boundingBox())!
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.x + b.width).toBeLessThanOrEqual(vp.width)
    expect(b.y).toBeGreaterThanOrEqual(0)
    expect(b.y + b.height).toBeLessThanOrEqual(vp.height)
  }
}

for (const [name, vp] of sizes) {
  const shot = async (page: Page, n: string) => {
    if (!process.env.SCREENS) return
    await page.waitForTimeout(350)
    await page.screenshot({ path: `.agent/screens/${n}-${name}.png` })
  }

  test(`screens: sign-in, invite-only, origin choice (${name})`, async ({ page, context }) => {
    await page.setViewportSize(vp)
    await routeHabitica(context)
    // Phase 1 screens, reviewed in this pass.
    await page.goto('/')
    await page.getByRole('button', { name: /Play as your Habitica hero/ }).waitFor()
    await page.evaluate(() => document.fonts.ready)
    await fits(page, vp)
    await shot(page, '01-title-choice')
    await page.getByRole('button', { name: /Play as your Habitica hero/ }).click()
    await fits(page, vp, page.getByRole('button', { name: 'I have them' }))
    await shot(page, '02-guide-find')
    await page.getByRole('button', { name: 'I have them' }).click()
    await page.getByLabel('Paste both values').fill(`${TOKEN}\n${newUser()}`)
    await page.getByText('Have an invite code?').click()
    await fits(page, vp, page.getByRole('button', { name: 'Looks right — Connect' }))
    await shot(page, '03-guide-paste-swap-invite')

    // Invite-only.
    await page.getByLabel('Paste both values').fill(`User ID: ${newUser()}\nAPI Token: ${TOKEN}`)
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    const box = page.getByTestId('invite-only')
    await expect(box).toBeVisible()
    await fits(page, vp, box.getByRole('button', { name: 'Play on this device instead' }))
    await shot(page, '04-invite-only')

    // Origin choice: a guest with progress signs in from the Menu.
    const id = newUser()
    allow(id)
    await page.goto('/')
    await page.evaluate(async () => indexedDB.deleteDatabase('fingersnap'))
    await beginNewJourney(page)
    await warp(page, 'village', 16, 14)
    await talkThrough(page, /Talk to Mara/)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'I have them' }).click()
    await pasteAndConnect(page, id)
    const origin = page.getByRole('dialog', { name: 'Welcome, Tansy' })
    await expect(origin).toBeVisible()
    await fits(page, vp, origin.getByRole('button', { name: /Start fresh/ }))
    await origin.getByRole('button', { name: /Bring this device’s save/ }).scrollIntoViewIfNeeded()
    await shot(page, '05-origin-choice')
    await origin.getByRole('button', { name: /Bring this device’s save/ }).click()
    await waitForWorld(page)
  })

  test(`screens: world title, lease, offline, notice, menu (${name})`, async ({ page, context, browser, baseURL }) => {
    await page.setViewportSize(vp)
    const id = newUser()
    allow(id)
    await routeHabitica(context)
    await openTitleGuide(page)
    await pasteAndConnect(page, id)
    await waitForWorld(page)

    // Menu: world card, connected guide, invites with a fresh code.
    await page.keyboard.press('Escape')
    const invites = page.getByTestId('invites-card')
    await invites.getByRole('button', { name: 'Create an invite code' }).click()
    await expect(invites.getByTestId('invite-code')).toBeVisible()
    await page.getByTestId('world-card').scrollIntoViewIfNeeded()
    await fits(page, vp, page.getByTestId('world-card').getByRole('button', { name: 'Log out' }))
    await shot(page, '06-menu-world')
    await invites.scrollIntoViewIfNeeded()
    await fits(page, vp, invites.getByRole('button', { name: 'Copy' }))
    await shot(page, '07-menu-invites')
    await page.getByTestId('world-card').getByRole('button', { name: 'Log out' }).click()
    await shot(page, '08-logout-confirm')
    await page.getByRole('alertdialog').getByRole('button', { name: 'Never mind' }).click()
    await page.getByRole('button', { name: 'Back to the road' }).click()

    // Server trouble (500s): plays on locally, says so, backs off.
    await page.route('**/api/progress', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal' } }) })
    )
    await hurt(page, 2)
    await expect(page.getByTestId('net-trouble')).toBeVisible()
    await fits(page, vp)
    await shot(page, '18-hud-server-trouble')
    await page.unroute('**/api/progress')
    await expect.poll(() => linkStatus(page), { timeout: 30_000 }).toBe('online')

    // Pending: the world waits for the server's answer to a spend.
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Sync character' }).click()
    await expect(page.locator('.toast', { hasText: 'embers into your hand' })).toBeVisible()
    await page.getByRole('button', { name: 'Back to the road' }).click()
    await hurt(page, 6)
    await page.route('**/api/spend', async (route) => {
      await new Promise((r) => setTimeout(r, 1500))
      await route.continue()
    })
    await warp(page, 'village', 11, 13)
    await page.keyboard.press('e')
    const rest = page.locator('.choice', { hasText: 'Rest by the flame' })
    for (let i = 0; i < 10 && !(await rest.isVisible()); i++) {
      await page.keyboard.press('e')
      await page.waitForTimeout(200)
    }
    await page.keyboard.press('1')
    await expect(page.getByTestId('net-pending')).toBeVisible()
    await shot(page, '09-hud-pending')
    await expect(page.getByTestId('net-pending')).toBeHidden()

    // Offline.
    await context.setOffline(true)
    await hurt(page, 3)
    await expect(page.getByTestId('net-offline')).toBeVisible()
    await fits(page, vp)
    await shot(page, '10-hud-offline')
    await warp(page, 'village', 16, 14)
    await talkThrough(page, /Talk to Mara/)

    // Another device plays meanwhile; back online this one is asked to take over.
    const otherContext = await browser.newContext({ storageState: await context.storageState(), baseURL, viewport: vp })
    const other = await otherContext.newPage()
    await other.goto('/')
    await other.getByTestId('continue-world').waitFor()
    await other.evaluate(() => document.fonts.ready)
    if (process.env.SCREENS) await other.screenshot({ path: `.agent/screens/11-title-world-${name}.png` })
    await other.getByTestId('continue-world').click()
    await expect(other.getByRole('alertdialog', { name: 'Playing on another device' })).toBeVisible()
    if (process.env.SCREENS) await other.screenshot({ path: `.agent/screens/12-lease-elsewhere-title-${name}.png` })
    await other.getByRole('button', { name: 'Take over here' }).click()
    await waitForWorld(other)
    await hurt(other, 8)
    await expect.poll(async () => (await other.request.get('/api/state').then((r) => r.json())).rev).toBeGreaterThan(1)

    await context.setOffline(false)
    const gate = page.getByRole('alertdialog', { name: 'Playing on another device' })
    await expect(gate).toBeVisible({ timeout: 20_000 })
    await fits(page, vp, gate.getByRole('button', { name: 'Take over here' }))
    await shot(page, '13-lease-elsewhere-in-play')
    await gate.getByRole('button', { name: 'Take over here' }).click()
    await expect(page.getByTestId('link-notice')).toBeVisible()
    await fits(page, vp, page.getByRole('button', { name: 'Got it' }))
    await shot(page, '14-reconnect-notice')
    await page.getByRole('button', { name: 'Got it' }).click()
    await otherContext.close()

    // Signed out mid-play (the session ended on the server).
    await page.request.delete('/api/session')
    await hurt(page, 2)
    const out = page.getByRole('alertdialog', { name: 'You’ve been signed out' })
    await expect(out).toBeVisible()
    await shot(page, '15-signed-out')

    // Offline title: no server answers, but this device has the world's cache.
    await page.route((url) => url.pathname.startsWith('/api/') && url.host === new URL(baseURL!).host, (r) => r.abort('internetdisconnected'))
    await page.goto('/')
    await expect(page.getByText('Offline · saves on this device')).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await shot(page, '16-title-world-offline')
    await page.unrouteAll()

    // Signed out with a guest save: the title offers to sign in again.
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Sign in to your world' })).toBeVisible()
    await shot(page, '17-title-sign-in-again')
    await page.getByRole('button', { name: 'Sign in to your world' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in to your world' })).toBeVisible()
  })
}
