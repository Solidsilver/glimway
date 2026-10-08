import { expect, test, type Page } from './fixtures'
import { expectStage, frames, holdUntil, player, settleWarden, talkThrough, warp, waitForArea, world, expectAreaCard } from './helpers'
import { freshPlayer } from './home-helpers'

const TILE = 16

const areaNow = (page: Page) => page.evaluate(() => (window as unknown as { __fsSafety: () => { areaId: string } }).__fsSafety().areaId)

test('the whole quest can be played from a fresh start to the ending', async ({ page }) => {
  await freshPlayer(page)

  // Mara, just south of her spot by the well.
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await expectStage(page, 'accepted')

  // The route marker in the ruin's alcove.
  await warp(page, 'ruin', 15, 3)
  await talkThrough(page, /Copy the naming from the stone/)
  await expectStage(page, 'clue-found')

  // The warden wakes once the clue is found; skip the encounter.
  await settleWarden(page)
  await expectStage(page, 'guardian-defeated')

  // Light the shrine lantern (plays a short cinematic).
  await warp(page, 'ruin', 17, 12)
  await talkThrough(page, /Light the lantern/)
  await expectStage(page, 'lantern-lit')

  // Home to Mara for the ending.
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await expectStage(page, 'complete')
  await expect(page.getByRole('dialog', { name: 'The Road Is Lit' })).toBeVisible({ timeout: 15_000 })
})

test('exits connect left-to-right and you come back the way you came', { tag: '@smoke' }, async ({ page }) => {
  await freshPlayer(page)

  // Village east gate → arrive on Brackenwood's west side.
  await warp(page, 'village', 38, 10)
  await holdUntil(page, 'ArrowRight', async () => (await areaNow(page)) !== 'village')
  await waitForArea(page, 'woodland')
  expect((await player(page)).x).toBeLessThan(6 * TILE)

  // Brackenwood west edge → arrive on the village's east side.
  await holdUntil(page, 'ArrowLeft', async () => (await areaNow(page)) !== 'woodland')
  await waitForArea(page, 'village')
  const w = await world(page)
  expect((await player(page)).x).toBeGreaterThan(w.widthPx - 6 * TILE)
})

test('the hero is confined to each map', async ({ page }) => {
  await freshPlayer(page)
  for (const [area, tx, ty] of [['village', 20, 2], ['woodland', 30, 3], ['ruin', 20, 3]] as const) {
    await warp(page, area, tx, ty)
    const w = await world(page)
    expect(w.bounds).toEqual({ x: 0, y: 0, w: w.widthPx, h: w.heightPx })
    // Walk north until the hero stops (the map edge or a wall).
    let last = NaN
    await holdUntil(page, 'ArrowUp', async () => {
      await frames(page, 8)
      const y = (await player(page)).y
      const still = y === last
      last = y
      return still
    })
    const p = await player(page)
    expect(p.y).toBeGreaterThan(0)
    expect(p.y).toBeLessThanOrEqual(w.heightPx)
  }
})

test('the area title card always names the area you are in', async ({ page }) => {
  await freshPlayer(page)
  // Leave while Hearthwick's card is still up, then again while Brackenwood's is.
  await expectAreaCard(page, 'Hearthwick')
  await warp(page, 'woodland', 15, 20)
  await expectAreaCard(page, 'Brackenwood Path')
  await warp(page, 'ruin', 3, 13)
  await expectAreaCard(page, 'Ashwatch Ruin')
})
