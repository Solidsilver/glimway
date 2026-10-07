import { expect, test, type Page } from './fixtures'
import { linkRev, linkStatus, serverState } from './connected'
import { beginNewJourney, dialogueState, frames, readDialogue, expectToast } from './helpers'
import { claimDeed, earnEmbers, freshPlayer, fund, go, homes, myHome, onMyLand, silasSays } from './home-helpers'

/**
 * Regressions for the phase 3 review, against the real
 * Go server: lost answers, the closed Wilds arch, redraw/tween hygiene,
 * modal input ownership, materials on home reads, and Space on the tray.
 */
test.use({ server: true })

type Stats = { gateDraws: number; tweens: number; deadTweens: number }
const stats = (page: Page) => page.evaluate(() => (window as unknown as { __fsHomes: () => { stats: Stats } }).__fsHomes().stats)

async function claim(page: Page): Promise<void> {
  await claimDeed(page)
}

/** Let the server commit the next matching POST, then lose its answer. */
async function loseNextAnswer(page: Page, path: string): Promise<void> {
  let done = false
  await page.route(`**${path}`, async (route) => {
    if (done || route.request().method() !== 'POST') return route.continue()
    done = true
    await route.fetch() // the server commits it…
    await route.abort('failed') // …and the browser never hears back
  })
}

test('finding 1: a purchase and an upgrade whose answers are lost resolve on reconnect, never charged twice', async ({ page }) => {
  test.setTimeout(150_000)
  const id = await freshPlayer(page)
  await earnEmbers(page, id)
  await claim(page)
  const before = (await serverState(page)).body.state.embers
  await loseNextAnswer(page, '/api/homestead/buy')
  await silasSays(page, /See what you’ve finished/)
  const shop = page.getByRole('dialog', { name: 'Silas’s Yard' })
  await shop.locator('[data-buy="wooden-stool"]').click()
  await expect(shop.locator('.msg.error')).toContainText('may have gone through')
  await shop.getByRole('button', { name: 'Close Silas’s yard' }).click()
  // A step while offline: the reconnect has a write of its own to send before
  // it replays the purchase (whose stored answer then carries an older rev).
  await expect.poll(() => linkStatus(page)).toBe('offline')
  const silas = (await homes(page)).features!.silas
  await go(page, 'commons', silas.tx, silas.ty + 3)
  // The link reconnects by itself and replays the same request: it landed.
  await expectToast(page, 'went through after all', { timeout: 30_000 })
  await expect.poll(() => linkStatus(page)).toBe('online')
  expect((await myHome(page, id)).items.filter((i) => i.itemDef === 'wooden-stool')).toHaveLength(1)
  await expect.poll(async () => (await homes(page)).mine?.items.length).toBe(1)
  expect((await serverState(page)).body.state.embers).toBe(before - 2)

  // A lost upgrade: tier 1 lands, and Orrin's foundation paper still arrives.
  // (expectToast below needs a newer 'went through' toast than the purchase's.)
  // The replay leaves the link on the server's revision, so the next spend
  // isn't refused as stale (bugs #4: it used to fall a revision behind).
  await expect
    .poll(async () => (await linkRev(page)) === (await serverState(page)).body.rev, { message: 'the link is on the server’s revision', timeout: 5_000 })
    .toBe(true)
  await loseNextAnswer(page, '/api/homestead/upgrade')
  await silasSays(page, /Raise a cottage/)
  await expectToast(page, 'may have gone through')
  // The server has it at once; the client learns on the reconnect (8 s retry) and says so.
  await expect.poll(async () => (await myHome(page, id)).tier).toBe(1)
  await expectToast(page, 'went through after all', { timeout: 30_000 })
  await expect.poll(async () => (await homes(page)).mine?.tier, { timeout: 15_000 }).toBe(1)
  // The paper is granted on recovery and reaches the server with the next upload.
  await expect.poll(async () => (await serverState(page)).body.state.flags, { timeout: 15_000 }).toContain('paper:orrins-drift-slap-foundation-standard')
  expect((await serverState(page)).body.state.embers).toBe(before - 2 - 15)
})

test('finding 2: an exit to an unregistered area is overgrown (no crash, the save stays put)', async ({ page, pageErrors }) => {
  // The Commons arch leads into the Wilds now; a test-only exit stands in for
  // any destination this build has no area kind for.
  await beginNewJourney(page)
  await go(page, 'commons', 21, 19)
  const saved = () => page.evaluate(() => (window as unknown as { __fsDevSaved: () => { area: string; position: { x: number; y: number } } }).__fsDevSaved())
  const before = await saved()
  expect(before.area).toBe('commons')
  await page.evaluate(() => (window as unknown as { __fsDevAddExit: (e: unknown) => void }).__fsDevAddExit({ tx: 22, ty: 19, tw: 1, th: 1, to: 'nowhere-yet' }))
  await page.keyboard.down('ArrowRight')
  await expectToast(page, 'The way is overgrown', { timeout: 10_000 })
  await page.keyboard.up('ArrowRight')
  await frames(page, 24)
  const s = await page.evaluate(() => (window as unknown as { __fsSafety: () => { areaId: string; transitioning: boolean } }).__fsSafety())
  expect(s).toEqual(expect.objectContaining({ areaId: 'commons', transitioning: false }))
  // The save never named the unregistered area.
  const after = await saved()
  expect(after.area).toBe('commons')
  // The hero was stepped back off the exit tile.
  const p = await page.evaluate(() => (window as unknown as { __fsPlayer: () => { x: number } }).__fsPlayer())
  expect(Math.floor(p.x / 16)).toBeLessThan(22)
  expect(pageErrors).toEqual([])
})

test('findings 4 and 6: materials show on a fresh read; purchases redraw one plot and leave no orphaned tweens', async ({ page }) => {
  test.setTimeout(150_000)
  const id = await freshPlayer(page)
  await earnEmbers(page, id)
  fund(id, { materials: { fiber: 20 } })
  await claim(page)
  const loaded = await stats(page)
  // The lane's gates drawn once at start, plus the claimed gate: never N² rebuilds.
  expect(loaded.gateDraws).toBeLessThanOrEqual(12)
  await silasSays(page, /See what you’ve finished/)
  const shop = page.getByRole('dialog', { name: 'Silas’s Yard' })
  // The basket costs 4 fiber: the read's materials (20) make it buyable straight away.
  await expect(shop.locator('[data-buy="woven-basket"]')).toHaveText('Buy')
  for (const item of ['wooden-stool', 'wooden-stool', 'potted-fern', 'woven-basket']) {
    await shop.locator(`[data-buy="${item}"]`).click()
    await expect(shop.locator('.msg.ok')).toBeVisible()
    await expect(shop.locator('button[data-buy]', { hasText: 'Buying…' })).toHaveCount(0)
  }
  await shop.getByRole('button', { name: 'Close Silas’s yard' }).click()
  await frames(page, 18)
  const after = await stats(page)
  expect(after.deadTweens).toBe(0)
  expect(after.gateDraws - loaded.gateDraws).toBeLessThanOrEqual(4)
})

test('findings 5 and 7: placement ignores keys under a modal; Space presses a focused tray button', async ({ page }) => {
  test.setTimeout(150_000)
  const id = await freshPlayer(page)
  await earnEmbers(page, id)
  await claim(page)
  await silasSays(page, /Raise a cottage/)
  await expect.poll(async () => (await myHome(page, id)).tier).toBe(1)
  // Silas may say a word more on his own: read it if he does.
  await frames(page, 36)
  if ((await dialogueState(page)).open) await readDialogue(page)
  await silasSays(page, /See what you’ve finished/)
  const shop = page.getByRole('dialog', { name: 'Silas’s Yard' })
  await shop.locator('[data-buy="wooden-stool"]').click()
  await expect(shop.locator('.msg.ok')).toBeVisible()
  await shop.getByRole('button', { name: 'Close Silas’s yard' }).click()

  await onMyLand(page, 2, 2)
  await page.getByTestId('arrange').click()
  const tray = page.getByTestId('placement-tray')
  await tray.locator('[data-piece="wooden-stool"]').click()
  // Open the Menu from the HUD, press E: nothing is placed underneath it.
  await page.getByRole('button', { name: /^Menu/ }).click()
  await expect(tray).toBeHidden()
  // Any homestead write the page sends from here on (there must be none).
  const writes: string[] = []
  page.on('request', (r) => void (r.method() === 'POST' && r.url().includes('/api/homestead/') && writes.push(r.url())))
  await page.keyboard.press('e')
  // Nothing may happen: the world reads keys every frame, so after 30 a
  // placement would have been sent.
  await frames(page, 30)
  expect(writes, 'no placement was sent').toEqual([])
  expect((await myHome(page, id)).items.find((i) => i.itemDef === 'wooden-stool')!.scene).toBeNull()
  // Escape closes the Menu only: the piece is still in hand.
  await page.keyboard.press('Escape')
  await expect(tray).toBeVisible()
  await expect(tray.locator('[data-piece="wooden-stool"]')).toHaveAttribute('aria-pressed', 'true')
  // Space on the focused Done button presses it.
  await tray.getByRole('button', { name: /Done/ }).focus()
  // The world lets go of Space for a focused tray control on its next frame.
  await frames(page, 3)
  await page.keyboard.press('Space')
  await expect(tray).toBeHidden()
})
