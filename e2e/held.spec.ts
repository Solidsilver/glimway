import { expect, test, type Page } from './fixtures'
import { freshPlayer, giveInstance } from './home-helpers'
import { expectToast, frames, waitForLive, warp } from './helpers'

/**
 * Held items (src/game/held.ts, src/lib/belt.ts): the belt is the weapon and
 * one slot per tool kind carried; number keys take one in hand; only what
 * the held tool works gets a prompt (the wrong one shows a faint hint after
 * a moment, never an E); the mouse works the piece under the cursor; on a
 * phone the small buttons around the action button switch.
 */
test.use({ server: true })

type Held = { kind: string; belt: string[] }
type Gather = { spots: { target: string; tx: number; ty: number }[]; prompt: { target: string; label: string } | null; hint: { tx: number; ty: number } | null; last: string }
const heldNow = (page: Page) => page.evaluate(() => (window as unknown as { __fsHeld: () => Held }).__fsHeld())
const gather = (page: Page) => page.evaluate(() => (window as unknown as { __fsGather: () => Gather | null }).__fsGather())
const park = (page: Page) => page.evaluate(() => (window as unknown as { __fsDevParkCreatures?: () => void }).__fsDevParkCreatures?.())

/** Three tools in the pack, read into the belt. */
async function withTools(page: Page): Promise<void> {
  const id = await freshPlayer(page, 'Teo')
  giveInstance(id, 'bench-axe', { max: 90 })
  giveInstance(id, 'bench-pick', { max: 90 })
  giveInstance(id, 'bench-spade', { max: 90 })
  await page.evaluate(() => (window as unknown as { __fsItems: { load: () => Promise<unknown> } }).__fsItems.load())
  await expect.poll(async () => (await heldNow(page)).belt).toEqual(['weapon', 'chop', 'break', 'dig'])
}

/** Stand on open ground just below a tree in Brackenwood (the woods' trees), nothing else in reach. */
async function besideTree(page: Page): Promise<{ tx: number; ty: number; x: number; y: number }> {
  await warp(page, 'woodland', 15, 20)
  await park(page)
  const at = await page.evaluate(() => {
    const g = (window as unknown as { __fsGather: () => { spots: { target: string; tx: number; ty: number }[] } | null }).__fsGather()
    const w = (window as unknown as { __fsWorld: () => { solid: boolean[][] } }).__fsWorld()
    const spots = g?.spots ?? []
    for (const s of spots) {
      if (s.target !== 'tree') continue
      const x = s.tx
      const y = s.ty + 1
      if (w.solid[y]?.[x] !== false) continue
      const hero = { x: x * 16 + 8, y: y * 16 + 12 }
      // Nothing else workable as near: the tree is the piece in reach.
      const d = (o: { tx: number; ty: number }) => Math.hypot(hero.x - (o.tx * 16 + 8), hero.y - 8 - (o.ty + 1) * 16)
      if (spots.some((o) => o !== s && d(o) <= 40)) continue
      return { tx: s.tx, ty: s.ty, x: hero.x, y: hero.y }
    }
    return null
  })
  expect(at, 'a tree with open ground below it').not.toBeNull()
  await page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [at!.x, at!.y] as const)
  await frames(page, 6)
  await waitForLive(page)
  return at!
}

test('keys take the belt in hand; only the held tool’s pieces prompt, the wrong one hints', async ({ page }) => {
  test.setTimeout(120_000)
  await withTools(page)
  const tree = await besideTree(page)
  expect((await heldNow(page)).kind).toBe('weapon')

  // The blade out: the tree keeps quiet, and after a moment a faint axe hints over it.
  await frames(page, 20)
  expect((await gather(page))?.prompt).toBeNull()
  await expect.poll(async () => (await gather(page))?.hint).toEqual({ tx: tree.tx, ty: tree.ty })
  await expect(page.locator('.prompt')).toHaveCount(0)

  // 2: the axe. The tree answers.
  await page.keyboard.press('2')
  await expect.poll(async () => (await heldNow(page)).kind).toBe('chop')
  await expect.poll(async () => (await gather(page))?.prompt?.target).toBe('tree')
  await expect(page.locator('.prompt')).toContainText('Chop the tree')
  expect((await gather(page))?.hint).toBeNull()
  // The hero holds it: a layered avatar puts its own weapon away and shows the axe.
  const drawn = () => page.evaluate(() => (window as unknown as { __fsDebug: () => { avatar: boolean; holding: string } }).__fsDebug())
  if ((await drawn()).avatar) await expect.poll(async () => (await drawn()).holding).toBe('bench-axe')

  // 3: the pick. Trees aren't its work.
  await page.keyboard.press('3')
  await expect.poll(async () => (await heldNow(page)).kind).toBe('break')
  await expect.poll(async () => (await gather(page))?.prompt ?? null).toBeNull()

  // The wheel steps back to the axe.
  const canvas = page.locator('canvas')
  await canvas.hover()
  await page.mouse.wheel(0, -120)
  await expect.poll(async () => (await heldNow(page)).kind).toBe('chop')

  // A click on the tree works it with the axe in hand.
  const at = await page.evaluate(([x, y]) => (window as unknown as { __fsDevToScreen: (x: number, y: number) => { x: number; y: number } }).__fsDevToScreen(x, y), [tree.tx * 16 + 8, (tree.ty + 1) * 16 - 6] as const)
  const box = (await canvas.boundingBox())!
  await page.mouse.click(box.x + at.x, box.y + at.y)
  await expectToast(page, /Found: /, { timeout: 20_000 })
})

test('phone: the small buttons by the action button take a tool in hand', async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
  const page = await context.newPage()
  await withTools(page)
  await besideTree(page)
  const act = page.locator('.controls .act')
  await expect(act).toHaveAttribute('data-held', 'weapon')
  // The weapon is in hand, so the ring holds the three tools.
  const ring = page.locator('.controls .belt button')
  await expect(ring).toHaveCount(3)
  await page.locator('.controls .belt button[data-kind="chop"]').tap()
  await expect.poll(async () => (await heldNow(page)).kind).toBe('chop')
  await expect(act).toHaveAttribute('data-held', 'chop')
  await expect(act.locator('.cap')).toHaveText('Chop')
  // Now the weapon waits in the ring.
  await expect(page.locator('.controls .belt button[data-kind="weapon"]')).toHaveCount(1)
  await context.close()
})
