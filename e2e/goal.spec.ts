import { expect, test, type Page } from './fixtures'
import { beginNewJourney, frames, talkThrough, waitForLive, warp } from './helpers'

/**
 * The goal is shown, not only told: the HUD says it in a few words with a
 * needle toward it (the way out in another area, the goal itself in its
 * own), and an off-screen goal gets a glint on the screen's edge.
 */
type Goal = { target: { x: number; y: number; here: boolean } | null; dir: { angle: number | null; here: boolean }; glint: boolean }
const goal = (page: Page) => page.evaluate(() => (window as unknown as { __fsGoal: () => Goal }).__fsGoal())

test('the HUD names the goal in a few words, and the needle points the way', async ({ page }) => {
  await beginNewJourney(page)
  // Before the quest: Mara, here in the village.
  await expect(page.locator('.hud .goal-text')).toHaveText('Find Mara in the village square')
  await warp(page, 'village', 4, 18)
  await frames(page, 10)
  let g = await goal(page)
  expect(g.dir.here, 'Mara is in this area').toBe(true)
  await expect(page.getByTestId('goal-needle')).toBeVisible()
  // Mara stands east and north of the library door.
  expect(Math.cos(g.dir.angle!), 'toward Mara: east').toBeGreaterThan(0)

  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await expect(page.locator('.hud .goal-text')).toHaveText('Copy the route stone in Ashwatch Ruin')
  await waitForLive(page)
  await frames(page, 10)
  g = await goal(page)
  // The ruin is past Brackenwood: the needle points at the east gate, onward.
  expect(g.dir.here).toBe(false)
  expect(Math.cos(g.dir.angle!), 'toward the east gate').toBeGreaterThan(0.5)
  expect(g.glint, 'the east gate is off screen: a glint on the edge').toBe(true)

  // In the ruin the route stone itself; standing at it, no glint (it's on screen).
  await warp(page, 'ruin', 15, 4)
  await frames(page, 10)
  g = await goal(page)
  expect(g.dir.here).toBe(true)
  expect(g.glint).toBe(false)

  // Opened, the goal line reads the whole objective.
  await page.locator('.hud .objective').click()
  await expect(page.locator('.hud .goal-text')).toContainText('Leave by the east gate')
})
