import { expect, test, type Page } from './fixtures'
import { reenter } from './connected'
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

/** Walk (as if steered) along a route, and wait until the hero gets there. */
async function walk(page: Page, path: { x: number; y: number }[]): Promise<void> {
  await page.evaluate((p) => (window as unknown as { __fsDevWalk: (p: { x: number; y: number }[]) => void }).__fsDevWalk(p), path)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fsDevWalking: () => boolean }).__fsDevWalking()), { timeout: 60_000 }).toBe(false)
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
    const target = { maxTy: cy * S + S - 3 }
    let path = await route(page, target)
    for (let tries = 0; !path && tries < 20; tries++) {
      await page.waitForTimeout(250)
      path = await route(page, target)
    }
    expect(path, `a way north into chunk row ${cy}`).not.toBeNull()
    const timing = page.evaluate(() => (window as unknown as { __fsDevFrameTimes: (ms: number) => Promise<{ gap: { p50: number; p95: number } }> }).__fsDevFrameTimes(2500))
    await walk(page, path!)
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
  expect(paints.some((p) => p.thread === 'worker'), 'chunks painted off the main thread while walking').toBe(true)
  await shot(page, '62-open-map-beyond-desktop')

  // Reload: the place is the server's; Continue puts you back where you stood.
  const before = await player(page)
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
  const path = await route(page, { maxTy: -8 * S }, 40)
  if (!path) test.skip(true, 'no open tile on this world’s north edge near the warp')
  await walk(page, path!)
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
