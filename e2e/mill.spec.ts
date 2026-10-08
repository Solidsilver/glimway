import { expect, test, type Page } from './fixtures'
import { serverState } from './connected'
import { talkText, warp, waitForLive } from './helpers'
import { freshPlayer, fund, go, shot } from './home-helpers'

/**
 * The Tolley mill (src/game/mill-art.ts, drawn and turned by
 * src/game/entities/village-life.ts): on the village pond's west edge, its
 * old wheel groaning round; Finn at the door; the hopper's tally. Finishing
 * the mill-wheel village project mends the wheel. SCREENS=1 saves desktop
 * and phone screens to .agent/screens/.
 */

type MillView = { mended: boolean; frame: number; turns: number; x: number; y: number }
const mill = (page: Page) => page.evaluate(() => (window as unknown as { __fsMill: () => MillView | null }).__fsMill())

/** Talk at the prompt and read it through; returns what was said. */
const readThrough = (page: Page, prompt: RegExp): Promise<string> => talkText(page, prompt)

test('the Tolley mill: its wheel groans round, Finn is at the door, the hopper keeps a tally', async ({ page }) => {
  test.setTimeout(90_000)
  await freshPlayer(page)
  await warp(page, 'village', 29, 24)
  const first = await mill(page)
  expect(first).not.toBeNull()
  expect(first!.mended).toBe(false)
  // It turns (in fits, but it turns).
  await expect.poll(async () => (await mill(page))!.turns, { timeout: 10_000 }).toBeGreaterThan(0)
  await shot(page, 'mill-desktop')
  // Finn stands at his door.
  await warp(page, 'village', 31, 23)
  await shot(page, 'mill-finn-desktop')
  const finn = await readThrough(page, /Talk to Finn/)
  expect(finn).toMatch(/This is the mill: Dad’s, then mine/)
  // The hopper on the west wall.
  await warp(page, 'village', 26, 22)
  const hopper = await readThrough(page, /Look at the hopper/)
  expect(hopper).toMatch(/tallies in clusters of five/)
  expect(hopper).not.toMatch(/fox|Aldo/)
})

test.describe('connected', () => {

  test('finishing the mill-wheel project mends the wheel: new paddles, and it turns smooth', async ({ page }) => {
    test.setTimeout(150_000)
    const id = await freshPlayer(page)
    fund(id, { materials: { timber: 120, fiber: 60 } })
    await go(page, 'village', 15, 10)
    await expect(page.locator('.prompt')).toContainText('Read the notice board')
    await waitForLive(page)
    await page.keyboard.press('e')
    const board = page.getByRole('dialog', { name: 'Notice Board' })
    await expect(board).toBeVisible()
    const card = board.locator('[data-project="mill-wheel"]')
    for (const all of await card.getByRole('button', { name: 'All' }).all()) await all.click()
    await card.locator('[data-contribute="mill-wheel"]').click()
    await expect(card.locator('.msg.ok')).toContainText('Finished!')
    await page.keyboard.press('Escape')
    // The wheel is mended where it stands.
    await go(page, 'village', 29, 24)
    await expect.poll(async () => (await mill(page))?.mended).toBe(true)
    await expect.poll(async () => (await mill(page))!.turns, { timeout: 10_000 }).toBeGreaterThan(0)
    await shot(page, 'mill-mended-desktop')
    // Finn hears the difference. (His late papers wait for the lit road.)
    await go(page, 'village', 31, 23)
    const finn = await readThrough(page, /Talk to Finn/)
    expect(finn).toMatch(/This is the mill/)
    const flags = (await serverState(page)).body.state.flags as string[]
    expect(flags).not.toContain('paper:note-in-the-linseed-box')
  })
})
