import { expect, test, type Page } from './fixtures'
import type { BrowserContext } from '@playwright/test'
import { allow, newUser, openTitleGuide, pasteAndConnect, reenter, routeHabitica, serverState, setHabitica, waitForWorld, CONTRACT } from './connected'
import { expectToast, holdUntil, player, settled, waitForWilds, warp, wilds, wildsWindow } from './helpers'
import { freshPlayer } from './home-helpers'

/**
 * The open map (docs/design/open-map.md 2.5, 2.6, 4): one Wilds scene, a
 * window of chunks moving with the hero. Out through the Commons gate,
 * through the Tangle and into the Whitequiet and beyond, across chunk edges
 * with no scene change and no long frames; a reload puts you back where you
 * stood; the drift at the frontier stops you and says why.
 * SCREENS=1 saves images to .agent/screens/.
 */

const TILE = 16
const S = 24

async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.SCREENS) return
  await page.waitForTimeout(400)
  await page.screenshot({ path: `.agent/screens/${name}.png` })
}

/**
 * A walkable route (world px waypoints) from the hero to the nearest open
 * tile matching `goal`, over the tiles the open map knows now (breadth
 * first, 4-way, within `reach` tiles); null when there is none yet.
 */
async function route(page: Page, goal: { minTy?: number; maxTy?: number; minTx?: number; maxTx?: number }, reach = 70): Promise<{ x: number; y: number }[] | null> {
  return page.evaluate(([g, reach]) => {
    const w = window as unknown as { __fsPlayer: () => { x: number; y: number }; __fsTileSolid: (x: number, y: number) => boolean }
    const p = w.__fsPlayer()
    const sx = Math.floor(p.x / 16)
    const sy = Math.floor(p.y / 16)
    const ok = (x: number, y: number) => (g.minTy === undefined || y >= g.minTy) && (g.maxTy === undefined || y <= g.maxTy) && (g.minTx === undefined || x >= g.minTx) && (g.maxTx === undefined || x <= g.maxTx)
    const key = (x: number, y: number) => `${x},${y}`
    const from = new Map<string, string | null>([[key(sx, sy), null]])
    const queue: [number, number][] = [[sx, sy]]
    while (queue.length) {
      const [x, y] = queue.shift()!
      if (ok(x, y)) {
        const out: { x: number; y: number }[] = []
        let k: string | null = key(x, y)
        while (k) {
          const [a, b] = k.split(',').map(Number)
          out.unshift({ x: a * 16 + 8, y: b * 16 + 12 })
          k = from.get(k) ?? null
        }
        return out
      }
      for (const [dx, dy] of [[0, -1], [1, 0], [-1, 0], [0, 1]]) {
        const nx = x + dx
        const ny = y + dy
        if (Math.abs(nx - sx) > reach || Math.abs(ny - sy) > reach || from.has(key(nx, ny)) || w.__fsTileSolid(nx, ny)) continue
        from.set(key(nx, ny), key(x, y))
        queue.push([nx, ny])
      }
    }
    return null
  }, [goal, reach] as const)
}

/**
 * Walk (as if steered) to the nearest open tile matching `goal`, and wait
 * until the hero gets there. Creatures are set aside first (a camp's
 * knockback would push the hero off the route); a walk that stalls is
 * planned again from where the hero stands.
 */
async function walkTo(page: Page, goal: Parameters<typeof route>[1]): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.evaluate(() => (window as unknown as { __fsDevParkCreatures: () => void }).__fsDevParkCreatures())
    let path = await route(page, goal)
    for (let tries = 0; !path && tries < 20; tries++) {
      await page.waitForTimeout(250)
      path = await route(page, goal)
    }
    expect(path, `a way to ${JSON.stringify(goal)}`).not.toBeNull()
    if (path!.length <= 1) return
    await page.evaluate((p) => (window as unknown as { __fsDevWalk: (p: { x: number; y: number }[]) => void }).__fsDevWalk(p), path!)
    const done = await expect
      .poll(() => page.evaluate(() => (window as unknown as { __fsDevWalking: () => boolean }).__fsDevWalking()), { timeout: 20_000 })
      .toBe(false)
      .then(() => true, () => false)
    if (done) return
  }
  throw new Error(`the walk to ${JSON.stringify(goal)} kept stalling`)
}

test('walk from the gate through the Tangle into the Whitequiet and on, with no scene change; reload in place', async ({ page }) => {
  test.setTimeout(240_000)
  await freshPlayer(page)
  // North through the Commons arch: the open map, just inside the gate.
  await warp(page, 'commons', 23, 2)
  const inWilds = () => page.evaluate(() => (window as unknown as { __fsSafety?: () => { areaId: string } | null }).__fsSafety?.()?.areaId === 'wilds')
  await holdUntil(page, 'ArrowUp', inWilds)
  await waitForWilds(page)
  const start = await wilds(page)
  expect(start.chunk).toEqual({ cx: 0, cy: 0 })
  expect(start.position).toEqual({ x: 40, y: 360 })
  expect(start.epochId).toBe(start.stillEpoch)
  const win = (await wildsWindow(page))!
  expect(win.attached.length).toBe(6) // the 3×3 minus the row south of the gate (the village side)
  expect(win.drift.sort()).toEqual(['-1,1', '0,1', '1,1'])
  await shot(page, '60-open-map-gate-desktop')

  // North chunk by chunk: (0,-1), (0,-2) in the Tangle, over the crossing into
  // the Whitequiet (0,-3), (0,-4), and out of its far side into the Beyond.
  const frames: { p95: number; p50: number }[] = []
  for (let cy = -1; cy >= -6; cy--) {
    const timing = page.evaluate(() => (window as unknown as { __fsDevFrameTimes: (ms: number) => Promise<{ gap: { p50: number; p95: number } }> }).__fsDevFrameTimes(2500))
    await walkTo(page, { maxTy: cy * S + S - 3 })
    frames.push((await timing).gap)
    const here = await wilds(page)
    expect(here.chunk.cy, 'the hero walked into the next row').toBe(cy)
    const w = (await wildsWindow(page))!
    expect(w.id, 'the same window: the scene never restarted').toBe(win.id)
    expect(w.center).toEqual(here.chunk)
    expect(await page.evaluate(() => (window as unknown as { __fsSafety: () => { areaId: string } }).__fsSafety().areaId)).toBe('wilds')
    if (cy === -3) {
      expect(here.epochId, 'the Whitequiet turns: the wick’s epoch').toBe(here.wickEpoch)
      await shot(page, '61-open-map-whitequiet-desktop')
    }
  }
  // No long frames crossing the edges (painting is off the walking frame).
  for (const f of frames) expect(f.p95, `frame gaps while crossing: ${JSON.stringify(frames)}`).toBeLessThan(120)
  const paints = (await wildsWindow(page))!.paints.filter((p) => !p.drift)
  // For the report: frame gaps per row crossed, and how long the chunks took to paint (and where).
  console.log('open-map walk', JSON.stringify({ frames, paints: paints.map((p) => [p.chunk, p.ms, p.thread]) }))
  expect(paints.some((p) => p.thread === 'worker'), 'chunks painted off the main thread while walking').toBe(true)
  await shot(page, '62-open-map-beyond-desktop')

  // Reload: the place is the server's; Continue puts you back where you stood
  // (once the report after the walk has reached it).
  const before = await player(page)
  await expect.poll(async () => {
    const st = (await serverState(page)).body.state as { area: string; position: { x: number; y: number } }
    return st.area === 'wilds' && Math.hypot(st.position.x - before.x, st.position.y - before.y) <= 17
  }, { timeout: 20_000 }).toBe(true)
  // And this tab's own record has it (a reload starts from the place the page last saved).
  await page.evaluate(() => (window as unknown as { __fsDevSaveSoon: () => void }).__fsDevSaveSoon())
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fsDevSaved: () => { pending: boolean } }).__fsDevSaved().pending)).toBe(false)
  await reenter(page, 'wilds')
  await waitForWilds(page)
  const after = await player(page)
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(17)
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(17)
})

test('the drift at the frontier stops you, and says so the first time', async ({ page }) => {
  test.setTimeout(150_000)
  await freshPlayer(page)
  // The north edge of the frontier is cy -8 (three chunks past the Whitequiet).
  await warp(page, 'wilds', 12, -8 * S + 12)
  await waitForWilds(page)
  const w = (await wildsWindow(page))!
  expect(w.drift.length, 'past the edge is the drift').toBeGreaterThan(0)
  const frontierTop = -8 * S * TILE
  // Walk to the northmost open tile in reach; if it is on the edge row, push into the drift.
  if (!(await route(page, { maxTy: -8 * S }, 40))) test.skip(true, 'no open tile on this world’s north edge near the warp')
  await walkTo(page, { maxTy: -8 * S })
  await page.keyboard.down('ArrowUp')
  try {
    await expectToast(page, /The drift is thick here\. Not without a lamp\./, { timeout: 8_000 })
  } finally {
    await page.keyboard.up('ArrowUp')
  }
  expect((await player(page)).y, 'the hero never passes the frontier').toBeGreaterThanOrEqual(frontierTop)
  await shot(page, '63-open-map-drift-desktop')
  await settled(page, { area: 'wilds' })
})

type Remote = { name: string; x: number; y: number; alpha: number }
const remotes = (p: Page) => p.evaluate(() => ((window as unknown as { __fsRemote?: () => Remote[] }).__fsRemote?.() ?? []) as Remote[])

test('two players in neighbouring chunks see each other; two chunks apart they don’t', async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000)
  const ash = newUser()
  const rowan = newUser()
  allow(ash)
  await setHabitica(ash, { name: 'Ash' })
  await setHabitica(rowan, { name: 'Rowan' })
  await routeHabitica(page.context())
  await openTitleGuide(page)
  await pasteAndConnect(page, ash)
  await waitForWorld(page)
  const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json()
  const ctx: BrowserContext = await browser.newContext({ baseURL, viewport: { width: 1200, height: 760 } })
  await routeHabitica(ctx)
  const other = await ctx.newPage()
  await openTitleGuide(other)
  await pasteAndConnect(other, rowan, { invite: invite.code })
  await waitForWorld(other)

  // Ash by the east edge of the Tangle's middle chunk (0, -1); Rowan just over it in (1, -1).
  await warp(page, 'wilds', 22, -12)
  await waitForWilds(page)
  await warp(other, 'wilds', 25, -12)
  await waitForWilds(other)
  expect((await wilds(page)).chunk).toEqual({ cx: 0, cy: -1 })
  expect((await wilds(other)).chunk).toEqual({ cx: 1, cy: -1 })
  await expect.poll(async () => (await remotes(page)).map((r) => r.name), { timeout: 20_000 }).toEqual(['Rowan'])
  await expect.poll(async () => (await remotes(other)).map((r) => r.name), { timeout: 20_000 }).toEqual(['Ash'])
  const seen = (await remotes(page))[0]!
  const there = await player(other)
  expect(Math.hypot(seen.x - there.x, seen.y - there.y), 'drawn where Rowan stands (world pixels)').toBeLessThan(24)
  await expect.poll(async () => (await remotes(page))[0]?.alpha ?? 0).toBe(1)
  await shot(page, '64-open-map-two-players-desktop')

  // Rowan goes two chunks further east: out of Ash's 3×3, so they part.
  await warp(other, 'wilds', 3 * S + 12, -12)
  await waitForWilds(other)
  await expect.poll(async () => (await remotes(page)).length, { timeout: 15_000 }).toBe(0)
  await ctx.close()
})
