import { expect, test, type Page } from './fixtures'
import { devices, type BrowserContext } from '@playwright/test'
import { accountOf, calendarOnServer, pinWorld, sql, wickSlack, CONTRACT } from './connected'
import { freshPlayer, fund, giveInstance } from './home-helpers'
import { diagnose, dialogueState, expectTarget, expectToast, parkCreatures, pressOn, readDialogue, steady, targetNow, waitForLive, waitForWilds, warp, wilds, windowWhole } from './helpers'

/**
 * Paths players make (docs/design/open-map.md section 3, decisions 5, 7 and
 * 23), against the worker's own Go server: clear a thicket with a spade, lay
 * stone after the turning-land confirm, see it from a second account in the
 * same world, lift it; and lay the joining tile of a run between two places
 * so it becomes a named way, with its signs and its name on the world map.
 * SCREENS=1 saves images to .agent/screens/.
 */

const S = 24

type PathTile = { surface: string | null; baseSolid: boolean; decor: string[]; occupied: boolean; change: { change: string; by: string } | null; changes: number }
type PathsView = { clearAt: { tx: number; ty: number } | null; queued: number; last: string; buttons: string; materials: Record<string, number> | null; ways: { id: string; name: string; a: string; b: string; by: string; signA: { x: number; y: number } | null; signB: { x: number; y: number } | null; path: number }[] }
type Hooks = {
  __fsPaths: () => PathsView | null
  __fsPathTile: (tx: number, ty: number) => PathTile | null
  __fsMarks: () => { signs: string[]; asked: string[]; discoveries: { id: string; by: string; name: string }[]; places: { id: string; kind: string; tx: number; ty: number }[] } | null
  __fsHeld: () => { kind: string; belt: string[] }
  __fsItems: { load: () => Promise<unknown> }
  __fsDevParkCreatures: () => number
  __fsDevWalk: (p: { x: number; y: number }[]) => void
  __fsDevWalking: () => boolean
  __fsPlayer: () => { x: number; y: number }
}

async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.SCREENS) return
  await page.waitForTimeout(500)
  await page.screenshot({ path: `.agent/screens/${name}.png` })
}

const paths = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__fsPaths())
const tileAt = (page: Page, tx: number, ty: number) => page.evaluate(([x, y]) => (window as unknown as Hooks).__fsPathTile(x, y), [tx, ty] as const)

/** The tool for a kind of work in hand, by its belt key, as a player would. */
async function hold(page: Page, kind: string): Promise<void> {
  const held = () => page.evaluate(() => (window as unknown as Hooks).__fsHeld())
  if (!(await held()).belt.includes(kind)) {
    await page.evaluate(() => (window as unknown as Hooks).__fsItems.load())
    await expect.poll(async () => (await held()).belt, { message: `a ${kind} tool on the belt` }).toContain(kind)
  }
  if ((await held()).kind === kind) return
  await waitForLive(page)
  await page.keyboard.press(String((await held()).belt.indexOf(kind) + 1))
  await expect.poll(async () => (await held()).kind).toBe(kind)
}

/** Step onto a neighbouring tile (dev walk) and wait to arrive. */
async function stepTo(page: Page, tx: number, ty: number): Promise<void> {
  await page.evaluate(([x, y]) => (window as unknown as Hooks).__fsDevWalk([{ x: x * 16 + 8, y: y * 16 + 10 }]), [tx, ty] as const)
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).__fsDevWalking()), { timeout: 10_000 }).toBe(false)
  const p = await page.evaluate(() => (window as unknown as Hooks).__fsPlayer())
  expect([Math.floor(p.x / 16), Math.floor(p.y / 16)]).toEqual([tx, ty])
}

/** The outcome of the last path operation, once the queue has emptied. */
async function landed(page: Page, what: string): Promise<void> {
  await expect.poll(async () => {
    const p = await paths(page)
    return p && p.queued === 0 ? p.last : 'waiting'
  }, { timeout: 15_000, message: `the ${what} landed` }).toBe(`landed:${what}`)
}

/**
 * Open land tiles beside a clearable thicket in the window, nearest the hero
 * first: geometry only (a tile to stand on, with room to step on and off).
 * Which prompt wins there is the game's to say: see `standByThicket`.
 */
async function thicketSpots(page: Page): Promise<{ stand: { tx: number; ty: number }; thicket: { tx: number; ty: number } }[]> {
  return page.evaluate(() => {
    const w = window as unknown as Hooks
    const p = w.__fsPlayer()
    const cx = Math.floor(p.x / 16 / 24)
    const cy = Math.floor(p.y / 16 / 24)
    const open = (t: PathTile | null) => !!t && t.surface === 'land' && !t.baseSolid && !t.occupied && !t.change && t.decor.length === 0
    const out: { stand: { tx: number; ty: number }; thicket: { tx: number; ty: number } }[] = []
    for (let ty = cy * 24 - 20; ty < cy * 24 + 44; ty++)
      for (let tx = cx * 24 - 20; tx < cx * 24 + 44; tx++) {
        const t = w.__fsPathTile(tx, ty)
        if (!t || !t.decor.includes('thicket') || t.surface !== 'land' || t.occupied || t.change) continue
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          const n = w.__fsPathTile(tx + dx!, ty + dy!)
          const more = [[0, 1], [0, -1], [1, 0], [-1, 0]].filter(([ex, ey]) => open(w.__fsPathTile(tx + dx! + ex!, ty + dy! + ey!))).length
          if (open(n) && more >= 1) out.push({ stand: { tx: tx + dx!, ty: ty + dy! }, thicket: { tx, ty } })
        }
      }
    const d = (s: { tx: number; ty: number }) => Math.hypot(s.tx * 16 + 8 - p.x, s.ty * 16 + 8 - p.y)
    return out.sort((a, b) => d(a.stand) - d(b.stand))
  })
}

/**
 * Stand beside a thicket where the game itself elects clearing it: the
 * hero set down on each candidate in turn (the clear prompt follows where
 * the hero stands), with the spade in hand, until the action button's target
 * is `wilds:path-clear` on that thicket. A dig in reach (a fern three rows
 * north, a stump) or a claim outranks clearing, whatever a square of tiles
 * around the spot says (review 2026-10-11; tests/interactables.test.ts).
 */
async function standByThicket(page: Page, why: string[]): Promise<{ stand: { tx: number; ty: number }; thicket: { tx: number; ty: number } } | null> {
  for (const c of (await thicketSpots(page)).slice(0, 24)) {
    await page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [c.stand.tx * 16 + 8, c.stand.ty * 16 + 8] as const)
    const seen = await steady(page, async () => ({ target: (await targetNow(page)).target?.id ?? null, clearAt: (await paths(page))?.clearAt ?? null }), { frames: 3, seconds: 3, message: 'the prompt settles' })
    if (seen.target === 'wilds:path-clear' && seen.clearAt?.tx === c.thicket.tx && seen.clearAt?.ty === c.thicket.ty) return c
    why.push(`${c.stand.tx},${c.stand.ty}→${seen.target ?? 'nothing'}`)
  }
  return null
}

/** The paths specs' worlds: pinned, so a failure names land that can be read again (within the wick). */
const SEED = 'e2e-paths'

test('clear a thicket with a spade, lay stone after the turning-land confirm, see it from a second account, lift it', async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000)
  const id = await freshPlayer(page)
  // Both clocks a day or more from the turning: the path has to outlast the second account's read.
  await wickSlack(page)
  await pinWorld(page, SEED)
  giveInstance(id, 'bench-spade', { max: 90 })
  fund(id, { materials: { stone: 40, timber: 10 } })

  // Out past the Whitequiet: land that turns at the wick. The spade in hand
  // while looking: what it digs is what can take the prompt from the thicket.
  let spot: Awaited<ReturnType<typeof standByThicket>> = null
  const why: string[] = []
  for (const [cx, cy] of [[2, -4], [-2, -4], [2, -7], [-2, -7], [0, -7], [3, -1], [-3, -1]] as const) {
    await warp(page, 'wilds', cx * S + 12, cy * S + 12)
    await windowWhole(page)
    await parkCreatures(page)
    await hold(page, 'dig')
    why.push(`[${cx},${cy}]`)
    spot = await standByThicket(page, why)
    if (spot) break
  }
  expect(spot, `a tile beside a thicket where clearing is the prompt (seed ${SEED}; ${await diagnose(page)}; tried ${why.join(' ')})`).not.toBeNull()
  const { stand } = spot!
  // (Walking in can find a place first, and its find can bring stone or timber: count from here.)
  await expect.poll(async () => (await paths(page))?.materials?.stone ?? 0, { message: 'the pack’s stone, read' }).toBeGreaterThanOrEqual(40)
  const stone = (await paths(page))!.materials!.stone!
  const timber = (await paths(page))!.materials!.timber!

  // With the weapon in hand nothing offers to clear; with the spade, the thicket does.
  await waitForLive(page)
  await page.keyboard.press('1')
  await expect.poll(async () => page.evaluate(() => (window as unknown as Hooks).__fsHeld().kind)).toBe('weapon')
  await expect.poll(async () => (await paths(page))!.clearAt).toBeNull()
  await hold(page, 'dig')
  await expect.poll(async () => (await paths(page))!.clearAt).toEqual(spot!.thicket)
  await expectTarget(page, 'wilds:path-clear')
  await expect(page.locator('.prompt')).toContainText('Clear the thicket')
  const cleared = (await paths(page))!.clearAt!
  await shot(page, '90-paths-clear-prompt-desktop')
  await pressOn(page, 'wilds:path-clear', spot!.thicket)
  await landed(page, 'clear')
  expect((await tileAt(page, cleared.tx, cleared.ty))!.change).toEqual({ change: 'cleared', by: accountOf(id) })
  await expectToast(page, /There’s a way through now|The trunk rolls aside/)
  expect(sql(`SELECT state FROM world_changes WHERE kind='ground' AND realm='hearthwick';`)).toContain('"cleared"')

  // Lay stone underfoot: the first lay on turning land this wick asks first.
  await page.keyboard.press('l')
  await expect.poll(async () => (await dialogueState(page)).open).toBe(true)
  expect((await dialogueState(page)).said.join(' ')).toMatch(/This land turns in (a day|\d+ days)\. A path here goes with it\./)
  await shot(page, '91-paths-turning-confirm-desktop')
  await readDialogue(page, { pick: /Lay it/ })
  await landed(page, 'lay')
  expect((await tileAt(page, stand.tx, stand.ty))!.change).toEqual({ change: 'stone', by: accountOf(id) })
  await expect.poll(async () => (await paths(page))!.materials!.stone).toBe(stone - 1)
  expect(sql(`SELECT state FROM world_changes WHERE kind='ground' AND realm='hearthwick';`)).toContain('"stone"')
  // On your own path, with the spade in hand: Lift, not Lay.
  await expect.poll(async () => (await paths(page))!.buttons).toContain('path-lift')

  // A plank on the cleared tile: no second confirm this wick.
  await stepTo(page, cleared.tx, cleared.ty)
  await page.keyboard.press('p')
  await landed(page, 'lay')
  expect((await dialogueState(page)).open).toBe(false)
  expect((await tileAt(page, cleared.tx, cleared.ty))!.change).toEqual({ change: 'plank', by: accountOf(id) })
  await expect.poll(async () => (await paths(page))!.materials!.timber).toBe(timber - 1)
  await stepTo(page, stand.tx, stand.ty)
  await shot(page, '92-paths-laid-desktop')

  // Someone else in the world sees it, and can't lift it.
  const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json()
  const ctx: BrowserContext = await browser.newContext({ baseURL, viewport: { width: 1200, height: 760 } })
  const other = await ctx.newPage()
  try {
    await freshPlayer(other, 'Wren', invite.code)
    await calendarOnServer(other)
    await warp(other, 'wilds', stand.tx, stand.ty)
    await waitForWilds(other)
    await other.evaluate(() => (window as unknown as Hooks).__fsDevParkCreatures())
    await expect.poll(async () => (await tileAt(other, stand.tx, stand.ty))?.change ?? null, { timeout: 20_000 }).toEqual({ change: 'stone', by: accountOf(id) })
    expect((await tileAt(other, cleared.tx, cleared.ty))!.change).toEqual({ change: 'plank', by: accountOf(id) })
    await shot(other, '93-paths-second-player-desktop')
    await waitForLive(other)
    await other.keyboard.press('l')
    await expectToast(other, 'There’s a path here already.')
  } finally {
    await ctx.close()
  }

  // Lift it: the stone comes back, and the tile is as it was.
  await waitForLive(page)
  await page.keyboard.press('l')
  await landed(page, 'lift')
  expect((await tileAt(page, stand.tx, stand.ty))!.change).toBeNull()
  await expect.poll(async () => (await paths(page))!.materials!.stone).toBe(stone)
  // The plank on the cleared thicket lifts back to cleared ground (it was solid before).
  await stepTo(page, cleared.tx, cleared.ty)
  await page.keyboard.press('l')
  await landed(page, 'lift')
  expect((await tileAt(page, cleared.tx, cleared.ty))!.change).toEqual({ change: 'cleared', by: accountOf(id) })
  await expect.poll(async () => (await paths(page))!.materials!.timber).toBe(timber)
  // Hold L and walk: a stone on each tile you step on.
  const line = await page.evaluate(([sx, sy]) => {
    const w = window as unknown as Hooks
    const open = (t: PathTile | null) => !!t && t.surface === 'land' && (!t.baseSolid || !!t.change) && !t.occupied && !(t.change && t.change.change !== 'cleared')
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const run = [0, 1, 2, 3].map((i) => ({ tx: sx + dx! * i, ty: sy + dy! * i }))
      if (run.every((t) => open(w.__fsPathTile(t.tx, t.ty)))) return run
    }
    return null
  }, [stand.tx, stand.ty] as const)
  if (line) {
    await stepTo(page, line[0]!.tx, line[0]!.ty)
    await waitForLive(page)
    await page.keyboard.down('l')
    await page.evaluate((run) => (window as unknown as Hooks).__fsDevWalk(run.map((t) => ({ x: t.tx * 16 + 8, y: t.ty * 16 + 10 }))), line.slice(1))
    await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).__fsDevWalking()), { timeout: 15_000 }).toBe(false)
    await page.keyboard.up('l')
    for (const t of line) await expect.poll(async () => (await tileAt(page, t.tx, t.ty))?.change?.change ?? null, { timeout: 15_000, message: `stone at ${t.tx},${t.ty}` }).toBe('stone')
    await landed(page, 'lay')
    await shot(page, '92b-paths-held-l-desktop')
    // And lift them again, one by one, walking back.
    for (const t of [...line].reverse()) {
      await stepTo(page, t.tx, t.ty)
      await page.keyboard.press('l')
      await landed(page, 'lift')
    }
    await expect.poll(async () => (await paths(page))!.materials!.stone).toBe(stone)
  }

  // Out of timber (the pack emptied elsewhere): the server refuses, the plank goes, and it says why.
  sql(`DELETE FROM item_stacks WHERE location='pack' AND owner='${accountOf(id)}' AND item_def='timber';`)
  await stepTo(page, stand.tx, stand.ty)
  await page.keyboard.press('p')
  await expect.poll(async () => (await paths(page))!.last, { timeout: 15_000 }).toBe('refused:insufficient-materials')
  await expectToast(page, "You're out of timber.")
  expect((await tileAt(page, stand.tx, stand.ty))!.change).toBeNull()
  // The refusal showed the pack was wrong: a fresh read says what it holds now.
  await expect.poll(async () => (await paths(page))!.materials!.timber, { timeout: 15_000, message: 'timber read again' }).toBe(0)
})

test('the joining tile of a run between two places makes a named way, with signs at its ends and its name on the world map', async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000)
  const id = await freshPlayer(page)
  fund(id, { materials: { stone: 20 } })
  // Two neighbouring places, both in view: search from the middle of the ring past the Whitequiet.
  let plan: { a: string; b: string; run: { tx: number; ty: number }[] } | null = null
  for (const [cx, cy] of [[0, -6], [2, -4], [-2, -4], [2, -1], [-2, -1], [2, -7], [-2, -7]] as const) {
    await warp(page, 'wilds', cx * S + 12, cy * S + 12)
    await waitForWilds(page)
    plan = await page.evaluate(() => {
      const w = window as unknown as Hooks
      const marks = w.__fsMarks()
      if (!marks) return null
      const placeKinds: Record<string, number> = { 'camp-glade': 3, ruin: 3, outcrop: 3, 'lone-tree': 3 }
      const places = marks.places
      // Land that takes a path, on the wick's land (the Tangle keeps its own epoch).
      const tangle = (x: number, y: number) => Math.floor(x / 24) >= -1 && Math.floor(x / 24) <= 1 && Math.floor(y / 24) >= -2 && Math.floor(y / 24) <= 0
      const tileOk = (t: PathTile | null) => !!t && t.surface === 'land' && (!t.baseSolid || !!t.change) && !t.occupied && !(t.change && t.change.change !== 'cleared')
      const near = (p: { tx: number; ty: number; kind: string }, x: number, y: number) => Math.max(Math.abs(x - p.tx), Math.abs(y - p.ty)) <= (placeKinds[p.kind] ?? 3)
      const pairs = []
      for (let i = 0; i < places.length; i++) for (let j = i + 1; j < places.length; j++) pairs.push([places[i]!, places[j]!] as const)
      pairs.sort((x, y) => Math.max(Math.abs(x[0].tx - x[1].tx), Math.abs(x[0].ty - x[1].ty)) - Math.max(Math.abs(y[0].tx - y[1].tx), Math.abs(y[0].ty - y[1].ty)))
      for (const [a, b] of pairs.slice(0, 4)) {
        // Breadth first from every layable tile inside a's radius to one inside b's.
        const key = (x: number, y: number) => `${x},${y}`
        const from = new Map<string, string | null>()
        const queue: [number, number][] = []
        for (let y = a.ty - 3; y <= a.ty + 3; y++) for (let x = a.tx - 3; x <= a.tx + 3; x++) if (near(a, x, y) && !tangle(x, y) && tileOk(w.__fsPathTile(x, y))) { from.set(key(x, y), null); queue.push([x, y]) }
        while (queue.length) {
          const [x, y] = queue.shift()!
          if (near(b, x, y) && !near(a, x, y)) {
            const run: { tx: number; ty: number }[] = []
            let k: string | null = key(x, y)
            while (k) {
              const [px, py] = k.split(',').map(Number)
              run.unshift({ tx: px!, ty: py! })
              k = from.get(k) ?? null
            }
            if (run.length >= 6) return { a: a.id, b: b.id, run }
            break
          }
          for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
            const nx = x + dx!
            const ny = y + dy!
            if (from.has(key(nx, ny)) || Math.abs(nx - a.tx) > 90 || Math.abs(ny - a.ty) > 90 || tangle(nx, ny) || !tileOk(w.__fsPathTile(nx, ny))) continue
            from.set(key(nx, ny), key(x, y))
            queue.push([nx, ny])
          }
        }
      }
      return null
    })
    if (plan) break
  }
  expect(plan, 'two places joined by open land in view').not.toBeNull()
  const { run } = plan!
  // Everything but one tile in the middle is laid already (as if over a few days), by this player.
  const gap = run[Math.floor(run.length / 2)]!
  const dump = await wilds(page)
  const account = accountOf(id)
  const world = sql(`SELECT world_id FROM players WHERE account_id='${account}';`)
  const byChunk = new Map<string, { tx: number; ty: number }[]>()
  for (const t of run) {
    if (t === gap) continue
    const k = `${Math.floor(t.tx / S)}:${Math.floor(t.ty / S)}`
    byChunk.set(k, [...(byChunk.get(k) ?? []), { tx: t.tx - Math.floor(t.tx / S) * S, ty: t.ty - Math.floor(t.ty / S) * S }])
  }
  const now = Math.floor(Date.now() / 1000)
  for (const [chunk, tiles] of byChunk) {
    const state = JSON.stringify({ changes: tiles.sort((p, q) => p.ty - q.ty || p.tx - q.tx).map((t) => ({ tx: t.tx, ty: t.ty, change: 'stone', by: account, at: now })) })
    sql(`INSERT OR REPLACE INTO world_changes(world_id,realm,layer,chunk,epoch,entity,kind,state,changed_at,changed_by,ends_at) VALUES('${world}','hearthwick',0,'${chunk}','${dump.wickEpoch}','ground','ground','${state}',${now},'${account}',NULL);`)
  }

  // Stand in the gap (a fresh read brings the run) and lay the joining stone.
  await warp(page, 'wilds', gap.tx, gap.ty)
  await waitForWilds(page)
  await page.evaluate(() => (window as unknown as Hooks).__fsDevParkCreatures())
  await expect.poll(async () => (await tileAt(page, run[0]!.tx, run[0]!.ty))?.change?.change ?? null, { timeout: 15_000 }).toBe('stone')
  await waitForLive(page)
  await page.keyboard.press('l')
  await expect.poll(async () => (await dialogueState(page)).open).toBe(true)
  await readDialogue(page, { pick: /Lay it/ })
  await landed(page, 'lay')
  const named = await expectToast(page, /It’s Tansy's way now\./)
  expect(named).toMatch(/^The path joins the .+ and the .+\. It’s Tansy's way now\.$/)
  const way = (await paths(page))!.ways.find((w) => [w.a, w.b].sort().join() === [plan!.a, plan!.b].sort().join())
  expect(way, 'the way, named').toBeTruthy()
  expect(way!.name).toBe("Tansy's way")
  expect(way!.by).toBe(account)
  expect(way!.signA && way!.signB).toBeTruthy()

  // Its signs stand at each end, named.
  await warp(page, 'wilds', way!.signA!.x, way!.signA!.y + 1)
  await waitForWilds(page)
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as Hooks).__fsMarks()))?.signs ?? []).toContain(way!.id)
  await shot(page, '94-paths-way-sign-desktop')

  // The world map (M): the walked land, the way along its tiles, its name on the map and in Details.
  await page.keyboard.press('m')
  await expect(page.getByTestId('map-canvas')).toBeVisible()
  await expect(page.locator('[data-label="you"]')).toBeVisible()
  await expect(page.locator('[data-label="way"]')).toContainText("Tansy's way")
  await page.getByTestId('map-details-toggle').click()
  await expect(page.getByTestId('map-ways')).toContainText("Tansy's way")
  await shot(page, '95-world-map-way-desktop')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('map-canvas')).toBeVisible()
  await shot(page, '95-world-map-way-phone')
  await page.setViewportSize({ width: 1200, height: 760 })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('world-map')).toHaveCount(0)

  // Someone else in the world sees the way, by the gap.
  const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json()
  const ctx: BrowserContext = await browser.newContext({ baseURL, viewport: { width: 1200, height: 760 } })
  const other = await ctx.newPage()
  await freshPlayer(other, 'Wren', invite.code)
  const otherWays = async () => ((await paths(other))?.ways ?? []).map((w) => w.id)
  await warp(other, 'wilds', gap.tx, gap.ty + 1)
  await waitForWilds(other)
  await expect.poll(otherWays, { timeout: 15_000 }).toContain(way!.id)

  // Lift the joining stone: the run no longer joins the two places, and the way is broken.
  await warp(page, 'wilds', gap.tx, gap.ty)
  await waitForWilds(page)
  await page.evaluate(() => (window as unknown as Hooks).__fsDevParkCreatures())
  await waitForLive(page)
  await page.keyboard.press('l')
  await landed(page, 'lift')
  await expectToast(page, "Tansy's way is broken. Close the gap and it joins again.")
  expect((await paths(page))!.ways.some((w) => w.id === way!.id)).toBe(false)
  // Wren's next read of that land no longer names it: its name, its signs and its line go there too.
  try {
    await warp(other, 'wilds', gap.tx + 1, gap.ty + 1)
    await waitForWilds(other)
    await expect.poll(otherWays, { timeout: 15_000 }).not.toContain(way!.id)
    await expect.poll(async () => (await other.evaluate(() => (window as unknown as Hooks).__fsMarks()))?.signs ?? []).not.toContain(way!.id)
  } finally {
    await ctx.close()
  }
})

test.describe('on a phone', () => {
  const { defaultBrowserType: _browser, ...phone } = devices['iPhone 13']
  test.use(phone)

  test('the path buttons press once on a tap, and also on Enter (a click with no pointer)', async ({ page }) => {
    test.setTimeout(180_000)
    const id = await freshPlayer(page)
    giveInstance(id, 'bench-spade', { max: 90 })
    fund(id, { materials: { stone: 10 } })
    // The Tangle keeps its paths (no turning-land confirm): an open tile in its middle chunk.
    await warp(page, 'wilds', 12, -12)
    await waitForWilds(page)
    const open = await page.evaluate(() => {
      const w = window as unknown as Hooks
      for (let r = 0; r < 12; r++)
        for (let ty = -12 - r; ty <= -12 + r; ty++)
          for (let tx = 12 - r; tx <= 12 + r; tx++) {
            const t = w.__fsPathTile(tx, ty)
            if (t && t.surface === 'land' && !t.baseSolid && !t.occupied && !t.change && t.decor.length === 0) return { tx, ty }
          }
      return null
    })
    expect(open).not.toBeNull()
    await warp(page, 'wilds', open!.tx, open!.ty)
    await waitForWilds(page)
    await page.evaluate(() => (window as unknown as Hooks).__fsDevParkCreatures())
    await hold(page, 'dig')
    await expect.poll(async () => (await paths(page))?.materials?.stone ?? 0).toBeGreaterThanOrEqual(10)
    const stone = (await paths(page))!.materials!.stone!
    const lay = page.locator('[data-ctx="path-lay-stone"]')
    await expect(lay).toBeVisible()
    await expect(lay, 'the touch row (it presses on pointerdown)').toHaveAttribute('data-inset', 'ctx')
    await lay.tap()
    await landed(page, 'lay')
    await page.waitForTimeout(600)
    expect((await paths(page))!.materials!.stone, 'one stone: the tap’s click is not a second press').toBe(stone - 1)
    const lift = page.locator('[data-ctx="path-lift"]')
    await expect(lift).toBeVisible()
    await lift.focus()
    await page.keyboard.press('Enter')
    await landed(page, 'lift')
    expect((await tileAt(page, open!.tx, open!.ty))!.change).toBeNull()
    await expect.poll(async () => (await paths(page))!.materials!.stone).toBe(stone)
  })
})
