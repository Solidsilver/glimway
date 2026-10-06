import type { Page } from './fixtures'
import { expect, test } from './fixtures'
import { claimDeed, freshPlayer, fund, giveInstance, homeAt, shot, toMyLand } from './home-helpers'
import { expectToast, frames, player, readDialogue, waitForLive, waitForWilds, warp } from './helpers'

/**
 * Gathering against the worker's own Go server (docs/items/crafting-and-repair.md,
 * "Gathering"): chopping a tree in the Tangle wears the axe, pays timber and
 * leaves a stump you can dig; the woods regrow when you leave and come back
 * (the drift); at the visit cap the wood's soft line shows and the trees
 * shuffle out of reach. On your own land, inside lamplight a stump stays,
 * and a sapling planted from the inventory stands where you put it.
 * SCREENS=1 saves screenshots to .agent/screens/.
 */
test.use({ server: true })

type GatherView = {
  area: string
  spots: { target: string; tx: number; ty: number; lit: boolean }[]
  prompt: { target: string; tx: number; ty: number; label: string } | null
  last: string
  lights: { x: number; y: number; radius: number }[]
}

const gather = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fsGather: () => GatherView | null }).__fsGather())

/** The tool's uses left (-1 before the item model has loaded). */
const usesLeft = (page: Page, tool: string) =>
  page.evaluate(
    (t) => (window as unknown as { __fsItems: () => { instances: { id: string; usesLeft: number }[] } | null }).__fsItems()?.instances.find((i) => i.id === t)?.usesLeft ?? -1,
    tool
  )

type Spot = { target: string; tx: number; ty: number; lit?: boolean }
type Candidate = { spot: Spot; hero: { x: number; y: number } }

/**
 * Places where one of `targets` could be worked: walkable, in-bounds tiles
 * beside the spot, off the exits, away from live creatures (a wisp's
 * knockback would move the hero and the prompt — and striking first would
 * make the camps claimable, whose claims eat the press), and — strictly —
 * only where the scene's own nearest-spot rule would prompt this spot: a
 * Wilds claim within its 44 px outranks gathering, and a tie between two
 * pieces goes to the one listed first. The list is loose first, strict when
 * the spot's identity matters.
 */
async function candidates(page: Page, targets: string[], lit?: boolean, strict = true): Promise<Candidate[]> {
  return page.evaluate(([targets, lit, strict]) => {
    const g = (window as unknown as { __fsGather: () => GatherView | null }).__fsGather()
    const w = (window as unknown as { __fsWorld: () => { solid: boolean[][]; exits: { tx: number; ty: number; tw: number; th: number }[] } }).__fsWorld()
    const wilds = (window as unknown as { __fsWilds?: () => { entities: { chunk: { cx: number; cy: number }; tx: number; ty: number; claimable: boolean }[]; sites: { tx: number; ty: number }[]; chunk: { cx: number; cy: number } } | null }).__fsWilds?.()
    const spots = g?.spots ?? []
    const out: Candidate[] = []
    const px = (s: { tx: number; ty: number }) => ({ x: s.tx * 16 + 8, y: (s.ty + 1) * 16 })
    const creatures = (window as unknown as { __fsEnemies?: () => { x: number; y: number; state: string }[] }).__fsEnemies?.() ?? []
    const live = creatures.filter((e) => e.state !== 'dead')
    const here = /^chunk:(.+):(-?\d+):(-?\d+)$/.exec(g?.area ?? '')
    const cx = here ? Number(here[2]) : -1
    const cy = here ? Number(here[3]) : -1
    const claims = [
      ...(wilds?.entities ?? []).filter((e) => e.claimable && e.chunk.cx === cx && e.chunk.cy === cy),
      ...(wilds?.sites ?? [])
    ]
    const inExit = (x: number, y: number) => (w.exits ?? []).some((e) => x >= e.tx && x < e.tx + e.tw && y >= e.ty && y < e.ty + e.th)
    for (const s of spots) {
      if (!targets.includes(s.target)) continue
      if (lit !== undefined && s.lit !== lit) continue
      const at = px(s)
      const me = spots.indexOf(s)
      for (const [x, y] of [
        [s.tx, s.ty + 1],
        [s.tx, s.ty - 1],
        [s.tx - 1, s.ty],
        [s.tx + 1, s.ty]
      ]) {
        if (x < 0 || y < 0 || y >= w.solid.length || x >= (w.solid[y]?.length ?? 0)) continue
        if (w.solid[y][x] || inExit(x, y)) continue
        const hero = { x: x * 16 + 8, y: y * 16 + 12 }
        if (live.some((e) => Math.hypot(e.x - hero.x, e.y - hero.y) < 180)) continue
        if (claims.some((e) => Math.hypot(hero.x - (e.tx * 16 + 8), hero.y - (e.ty + 1) * 16) <= 44)) continue
        const d = Math.hypot(hero.x - at.x, hero.y - 8 - at.y)
        if (d > 36) continue
        if (strict) {
          // The scene prompts the NEAREST spot; a tie goes to the one listed first.
          const beaten = spots.some((o) => {
            if (o === s) return false
            const b = px(o)
            const od = Math.hypot(hero.x - b.x, hero.y - 8 - b.y)
            return od < d || (od === d && spots.indexOf(o) < me)
          })
          if (beaten) continue
        }
        out.push({ spot: s, hero })
      }
    }
    return out
  }, [targets, lit, strict] as const)
}

/** The DOM prompt's text once it matches (or null). The game's own election. */
async function promptIs(page: Page, pattern: RegExp): Promise<string | null> {
  for (let w = 0; w < 4; w++) {
    const dom = await page.locator('.prompt').textContent().catch(() => null)
    if (dom && pattern.test(dom)) return dom
    await frames(page, 12)
  }
  return null
}

/** Candidates nearest the hero first: small moves, fewer merges in flight. */
async function candidatesNear(page: Page, targets: string[], lit?: boolean, strict = true): Promise<Candidate[]> {
  const cands = await candidates(page, targets, lit, strict)
  const at = await player(page)
  return cands.sort((a, b) => Math.hypot(a.hero.x - at.x, a.hero.y - at.y) - Math.hypot(b.hero.x - at.x, b.hero.y - at.y))
}

/** Set the hero down (its save's position follows) and make sure it took —
 * false when something moved it (a knockback, a stale merge's snap-back):
 * the caller just tries the next candidate. */
async function settle(page: Page, at: { x: number; y: number }): Promise<boolean> {
  for (let tries = 0; tries < 2; tries++) {
    await page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [at.x, at.y] as const)
    await frames(page, 4)
    try {
      await expect
        .poll(async () => {
          const p = await player(page)
          return Math.hypot(p.x - at.x, p.y - at.y) <= 2
        }, { timeout: 1_500 })
        .toBe(true)
      return true
    } catch {
      continue
    }
  }
  return false
}

/**
 * The game's own prompt is on this spot and says the wanted words (both the
 * hook and the screen: a Wilds claim outranks gathering and reads differently).
 */
async function promptOn(page: Page, spot: { tx: number; ty: number }, prompt: RegExp): Promise<boolean> {
  for (let w = 0; w < 6; w++) {
    const g = await gather(page)
    if (g?.prompt && g.prompt.tx === spot.tx && g.prompt.ty === spot.ty && prompt.test(g.prompt.label)) {
      const dom = await page.locator('.prompt').textContent().catch(() => null)
      if (dom !== null && dom.includes(g.prompt.label)) return true
    }
    await frames(page, 12)
  }
  return false
}

/** Work the nearest electable piece: stand, prompt, press, and hear the wood pay. */
async function chopOne(page: Page, targets: string[], prompt: RegExp, lit?: boolean): Promise<Spot> {
  const cands = await candidatesNear(page, targets, lit)
  for (const c of cands) {
    await settle(page, c.hero)
    if (!(await promptOn(page, c.spot, prompt))) continue
    await waitForLive(page)
    await page.keyboard.press('e')
    // A claim's discovery (a POI was the nearest press) opens a reading
    // panel that holds the screen: read it away before going on.
    await readDialogue(page).catch(() => null)
    await expectToast(page, /Found: /, { timeout: 15_000 })
    return c.spot
  }
  throw new Error(`nothing to work (${targets.join('/')})`)
}

test('chopping a tree in the Tangle: wear, timber, a stump to dig, and regrowth', async ({ page }) => {
  test.setTimeout(120_000)
  const id = await freshPlayer(page, 'Teo')
  const axe = giveInstance(id, 'bench-axe', { max: 90 })

  await warp(page, 'wilds', 20, 20)
  await waitForWilds(page)
  const spot = await chopOne(page, ['tree', 'ash'], /Chop the (tree|ash)/)
  // The axe wore one use; the tree paid timber and left a stump to dig.
  await expect.poll(async () => usesLeft(page, axe)).toBe(29)
  const timber = await page.evaluate(
    () => (window as unknown as { __fsItems: () => { stacks: { itemDef: string; qty: number }[] } | null }).__fsItems()?.stacks.find((s) => s.itemDef === 'timber')?.qty ?? 0
  )
  expect(timber).toBeGreaterThanOrEqual(2)
  await expect.poll(async () => (await gather(page))!.spots.some((s) => s.target === 'stump' && s.tx === spot.tx && s.ty === spot.ty)).toBe(true)
  await shot(page, 'gathering-tangle-chop')

  // The drift: leave, come back, and the woods have regrown.
  await warp(page, 'commons', 23, 19)
  await warp(page, 'wilds', 20, 20)
  await waitForWilds(page)
  await expect.poll(async () => (await gather(page))!.spots.some((s) => s.target === 'tree' && s.tx === spot.tx && s.ty === spot.ty)).toBe(true)
})

test('the wood gives enough for one visit, and says so in words', async ({ page }) => {
  test.setTimeout(240_000)
  const id = await freshPlayer(page, 'Ash')
  const heirloom = giveInstance(id, 'brack-felling-axe', { max: 240 })

  await warp(page, 'wilds', 20, 20)
  await waitForWilds(page)
  // Press until eight gathers have landed (the axe's wear count is the
  // server's own tally: one wear is one gather, so this is exact whatever
  // the presses did — a press a claim ate just doesn't count). Loose: the
  // game's own prompt is the election, and which tree it elects doesn't
  // matter. The walks rotate through the candidate list, so a crowding fern
  // cannot clog the same first five.
  const areaBefore = (await gather(page))?.area
  const from80 = await usesLeft(page, heirloom)
  await expect.poll(async () => usesLeft(page, heirloom)).toBeGreaterThanOrEqual(from80) // the model is read
  let from = 0
  let cands: Candidate[] = []
  for (let presses = 0; presses < 24; presses++) {
    const left = await usesLeft(page, heirloom)
    if (left >= 0 && left <= from80 - 8) break
    if (from >= cands.length - 1) {
      cands = await candidatesNear(page, ['tree', 'ash'], undefined, false)
      from = 0
    }
    for (const c of cands.slice(from, from + 5)) {
      from++
      if (!(await settle(page, c.hero))) continue
      if (!(await promptIs(page, /Chop the (tree|ash)/))) continue
      await waitForLive(page)
      await page.keyboard.press('e')
      await readDialogue(page).catch(() => null)
      break
    }
    await frames(page, 100)
  }
  await expect.poll(async () => usesLeft(page, heirloom)).toBe(from80 - 8)
  // The ninth gather: the wood's soft line, said in words, and every tree
  // shuffles out of reach.
  {
    if (from >= cands.length - 1) {
      cands = await candidatesNear(page, ['tree', 'ash'], undefined, false)
      from = 0
    }
    let pressed = false
    for (const c of cands.slice(from, from + 8)) {
      from++
      if (!(await settle(page, c.hero))) continue
      if (!(await promptIs(page, /Chop the (tree|ash)/))) continue
      await waitForLive(page)
      await page.keyboard.press('e')
      await readDialogue(page).catch(() => null)
      pressed = true
      break
    }
    expect(pressed, 'a tree still standing for the ninth press').toBe(true)
    await expectToast(page, /given enough here today/, { timeout: 20_000 })
    await expect.poll(async () => usesLeft(page, heirloom)).toBe(from80 - 8)
  }
  // The trees shuffled out of reach — unless a stale merge rebuilt the chunk
  // (fresh woods, the same server-side cap).
  if ((await gather(page))?.area === areaBefore) {
    await expect.poll(async () => (await gather(page))!.spots.filter((s) => s.target === 'tree' || s.target === 'ash').length).toBe(0)
  }
  // Back another visit (leave and return): the woods give again.
  await warp(page, 'commons', 23, 19)
  await warp(page, 'wilds', 20, 20)
  await waitForWilds(page)
  await expect.poll(async () => (await gather(page))!.spots.some((s) => s.target === 'tree')).toBe(true)
})

test('on your land: inside the lamps a stump stays, and a planted sapling stands', async ({ page }) => {
  test.setTimeout(180_000)
  const id = await freshPlayer(page, 'Ruta')
  const axe = giveInstance(id, 'bench-axe', { max: 90 })
  fund(id, { items: { 'birch-sapling': 1 } })
  await claimDeed(page)
  const land = await toMyLand(page)
  await expect.poll(async () => (await gather(page))?.spots.length ?? 0).toBeGreaterThan(0)

  const spot = await chopOne(page, ['tree', 'iron-oak'], /Chop the/, true)
  // The map rebuilds from the homestead state: the stump is kept, not regrown.
  await expect.poll(async () => (await homeAt(page, land.gate))?.stumps ?? []).toContainEqual([spot.tx, spot.ty])
  await expect.poll(async () => (await gather(page))!.spots.some((s) => s.target === 'stump' && s.tx === spot.tx && s.ty === spot.ty)).toBe(true)
  await shot(page, 'gathering-land-stump')

  // Plant a sapling where you stand (the hero kept the spot through the rebuild).
  const here = await player(page)
  const tile = { tx: Math.floor(here.x / 16), ty: Math.floor(here.y / 16) }
  await page.keyboard.press('i')
  const dialog = page.getByRole('dialog', { name: 'Inventory' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('tab', { name: /Supplies/ }).click()
  const sapling = dialog.locator('[data-item="item:birch-sapling"]')
  await sapling.getByRole('button', { name: 'Plant' }).click()
  await expect(dialog.getByTestId('inv-message')).toHaveText('You planted a birch sapling.')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await homeAt(page, land.gate))?.plants ?? []).toContainEqual(
    expect.objectContaining({ itemDef: 'birch-sapling', x: tile.tx, y: tile.ty })
  )

  // It survives a reload, and the stump with it.
  await page.reload()
  await page.getByRole('button', { name: /Continue/ }).click()
  await page.waitForFunction((a) => {
    const s = (window as unknown as { __fsSafety?: () => { areaId: string; transitioning: boolean } | null }).__fsSafety?.()
    return !!s && !s.transitioning && s.areaId === a
  }, `home:${land.gate}`)
  const after = await homeAt(page, land.gate)
  expect(after?.stumps ?? []).toContainEqual([spot.tx, spot.ty])
  expect(after?.plants ?? []).toContainEqual(expect.objectContaining({ itemDef: 'birch-sapling', x: tile.tx, y: tile.ty }))
  await expect.poll(async () => usesLeft(page, axe)).toBe(29)
})
