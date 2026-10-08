import type { Page } from './fixtures'
import { expect, test } from './fixtures'
import { sql, accountOf } from './connected'
import { claimDeed, freshPlayer, fund, giveInstance, homeAt, shot, toMyLand, type Home } from './home-helpers'
import { expectToast, frames, player, readDialogue, waitForLive, waitForWilds, warp } from './helpers'
import { plantable } from '../src/lib/homestead.ts'
import { gatheringTarget } from '../src/lib/gathering.ts'
import { homeLights, isLit } from '../src/lib/homestead-land.ts'

/**
 * Gathering against the worker's own Go server (docs/items/crafting-and-repair.md,
 * "Gathering"): chopping a tree in the Tangle wears the axe, pays timber and
 * leaves a stump you can dig; the woods regrow when you leave and come back
 * (the drift); past the cap the wood's soft line shows and the trees
 * shuffle out of reach. On your own land, inside lamplight a stump stays
 * while your unlit edge regrows, and a sapling planted from the inventory
 * stands where you put it.
 * SCREENS=1 saves screenshots to .agent/screens/.
 */

type GatherView = {
  area: string
  spots: { target: string; tx: number; ty: number; lit: boolean }[]
  prompt: { target: string; tx: number; ty: number; label: string } | null
  left: { tx: number; ty: number; frame: string }[]
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

/**
 * Take the tool for a kind of work in hand (src/game/held.ts): its number
 * key on the belt, as a player would. The pack is read again first when the
 * belt doesn't show the tool yet.
 */
async function hold(page: Page, kind: string): Promise<void> {
  const held = () => page.evaluate(() => (window as unknown as { __fsHeld: () => { kind: string; belt: string[] } }).__fsHeld())
  if (!(await held()).belt.includes(kind)) {
    await page.evaluate(() => (window as unknown as { __fsItems: { load: () => Promise<unknown> } }).__fsItems.load())
    await expect.poll(async () => (await held()).belt, { message: `a ${kind} tool on the belt` }).toContain(kind)
  }
  if ((await held()).kind === kind) return
  await waitForLive(page)
  await page.keyboard.press(String((await held()).belt.indexOf(kind) + 1))
  await expect.poll(async () => (await held()).kind, { message: `the ${kind} tool in hand` }).toBe(kind)
}

/** Set the area's creatures aside (dev hook): frozen, off the map, back on the next build. */
const parkCreatures = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fsDevParkCreatures?: () => number }).__fsDevParkCreatures?.() ?? 0)

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

/**
 * Work the nearest electable piece (or the one at `at`): stand, prompt,
 * press, and hear the answer. Strict first (the spot the game would
 * elect), then loose (any spot the prompt lands on), in case a wandering
 * creature or a merge spoiled the first round.
 */
async function workOne(page: Page, targets: string[], prompt: RegExp, opts: { lit?: boolean; says?: RegExp; at?: { tx: number; ty: number } } = {}): Promise<Spot & { from: { x: number; y: number } }> {
  const tried: string[] = []
  // The right tool in hand: only what it works answers.
  await hold(page, gatheringTarget(targets[0])?.action ?? 'chop')
  // A quiet chunk: the creatures set aside (a wisp near every tree empties
  // the candidate list, and its knockback moves the hero off the prompt).
  await parkCreatures(page)
  for (const strict of [true, false]) {
    // The list can be empty for a moment (a rebuild, a creature on its way
    // out): look again for a few seconds before giving up on this round.
    let cands: Candidate[] = []
    for (let look = 0; look < 6; look++) {
      cands = (await candidatesNear(page, targets, opts.lit, strict)).filter((c) => !opts.at || (c.spot.tx === opts.at.tx && c.spot.ty === opts.at.ty))
      if (cands.length) break
      await parkCreatures(page)
      await frames(page, 30)
    }
    tried.push(`${strict ? 'strict' : 'loose'}:${cands.length}`)
    for (const c of cands.slice(0, 8)) {
      if (!(await settle(page, c.hero))) {
        tried.push('unsettled')
        continue
      }
      if (!(await promptOn(page, c.spot, prompt))) {
        tried.push(`prompt=${JSON.stringify((await gather(page))?.prompt)}/${await page.locator('.prompt').textContent().catch(() => null)}`)
        continue
      }
      await waitForLive(page)
      await page.keyboard.press('e')
      // A claim's discovery (a POI was the nearest press) opens a reading
      // panel that holds the screen: read it away before going on.
      await readDialogue(page).catch(() => null)
      try {
        await expectToast(page, opts.says ?? /Found: /, { timeout: 15_000 })
      } catch (err) {
        throw new Error(`no answer at ${c.spot.target} ${c.spot.tx},${c.spot.ty}: last=${(await gather(page))?.last}, hero=${JSON.stringify(await player(page))} vs ${JSON.stringify(c.hero)}; ${String(err).slice(0, 200)}`)
      }
      return { ...c.spot, from: c.hero }
    }
  }
  throw new Error(`nothing to work (${targets.join('/')}): ${tried.join(' ')}`)
}

/** Work the piece at a spot again from where you stood (the felled tree's stump). */
async function workAgain(page: Page, spot: Spot & { from: { x: number; y: number } }, prompt: RegExp, kind = 'dig'): Promise<void> {
  await hold(page, kind)
  await parkCreatures(page)
  expect(await settle(page, spot.from), 'back where you stood').toBe(true)
  expect(await promptOn(page, spot, prompt), `the prompt on ${spot.tx},${spot.ty}`).toBe(true)
  await waitForLive(page)
  await page.keyboard.press('e')
  await expectToast(page, /Found: /, { timeout: 15_000 })
}

const stack = (page: Page, def: string) =>
  page.evaluate(
    (d) => (window as unknown as { __fsItems: () => { stacks: { itemDef: string; qty: number }[] } | null }).__fsItems()?.stacks.find((s) => s.itemDef === d)?.qty ?? 0,
    def
  )

/** A home as the gathering sees it (the stumps kept in lamplight, the plants). */
type LandHome = Home & { stumps?: [number, number][]; plants?: { id: string; itemDef: string; x: number; y: number; lit?: boolean }[] }
const landAt = async (page: Page, gate: number) => (await homeAt(page, gate)) as LandHome | null

const spotAt = async (page: Page, s: { tx: number; ty: number }) => (await gather(page))?.spots.find((o) => o.tx === s.tx && o.ty === s.ty)?.target ?? null

test('chopping a tree in the Tangle: wear, timber, a stump to dig, and regrowth', async ({ page }) => {
  test.setTimeout(150_000)
  const id = await freshPlayer(page, 'Teo')
  const axe = giveInstance(id, 'bench-axe', { max: 90 })
  const spade = giveInstance(id, 'bench-spade', { max: 90 })

  await warp(page, 'wilds', 20, 20)
  await waitForWilds(page)
  const spot = await workOne(page, ['tangle-tree', 'ash'], /Chop the (tree|ash)/)
  // The axe wore one use; the tree paid timber and left a stump to dig.
  await expect.poll(async () => usesLeft(page, axe)).toBe(29)
  expect(await stack(page, 'timber')).toBeGreaterThanOrEqual(2)
  await expect.poll(async () => spotAt(page, spot)).toBe('stump')
  await shot(page, 'gathering-tangle-chop')

  // The stump digs out (turncap spawn), and the ground opens.
  await workAgain(page, spot, /Dig the stump/)
  await expect.poll(async () => usesLeft(page, spade)).toBe(29)
  expect(await stack(page, 'turncap-spawn')).toBeGreaterThanOrEqual(1)
  await expect.poll(async () => spotAt(page, spot)).toBeNull()

  // The same chunk built again within the visit: the dug-out tree stays
  // open ground, with nothing drawn on it.
  const chunk = (await gather(page))!.area
  await warp(page, 'wilds', 20, 20)
  await waitForWilds(page)
  expect((await gather(page))!.area).toBe(chunk)
  await expect.poll(async () => spotAt(page, spot)).toBeNull()
  expect((await gather(page))!.left.filter((l) => l.tx === spot.tx && l.ty === spot.ty)).toEqual([])

  // The drift: leave, come back, and the woods have regrown.
  await warp(page, 'commons', 23, 19)
  await warp(page, 'wilds', 20, 20)
  await waitForWilds(page)
  await expect.poll(async () => spotAt(page, spot)).toMatch(/^(tangle-tree|ash)$/)
})

test('in the woods a boulder breaks to open ground, and a worn-out pick says so', async ({ page }) => {
  test.setTimeout(120_000)
  const id = await freshPlayer(page, 'Oriel')
  // One use left: this break is its last.
  const pick = giveInstance(id, 'bench-pick', { uses: 1, max: 90 })

  await warp(page, 'woodland', 2, 15)
  const rock = await workOne(page, ['boulder'], /Break the boulder/)
  await expectToast(page, 'Your bench pick gave out.')
  await expect.poll(async () => usesLeft(page, pick)).toBe(-1)
  expect(await stack(page, 'stone')).toBeGreaterThanOrEqual(2)
  // The rock's body went with it: no invisible wall where it stood.
  await expect.poll(async () => spotAt(page, rock)).toBeNull()
  expect(await page.evaluate(([x, y]) => (window as unknown as { __fsSolidAt: (x: number, y: number) => boolean }).__fsSolidAt(x, y), [rock.tx, rock.ty] as const)).toBe(false)
  expect((await gather(page))!.left).toContainEqual(expect.objectContaining({ tx: rock.tx, ty: rock.ty, frame: 'pebbles-0' }))
  await shot(page, 'gathering-woods-boulder')
})

test('past the cap the wood says so in words, and the trees shuffle out of reach', async ({ page }) => {
  test.setTimeout(120_000)
  const id = await freshPlayer(page, 'Ash')
  const axe = giveInstance(id, 'bench-axe', { max: 90 })
  // One tree short of the day's cap (numbers live on the server only).
  const day = Math.floor(Date.now() / 1000 / 86400)
  sql(`INSERT INTO gathering_caps(account_id,action,day,day_count,area,visit_id,visit_count,updated_at) VALUES('${accountOf(id)}','chop',${day},29,'','',0,0);`)

  await warp(page, 'wilds', 20, 20)
  await waitForWilds(page)
  await workOne(page, ['tangle-tree', 'ash'], /Chop the (tree|ash)/)
  await expect.poll(async () => usesLeft(page, axe)).toBe(29)
  // The next: the soft line, no number, no wear, and no tree answers again.
  await workOne(page, ['tangle-tree', 'ash'], /Chop the (tree|ash)/, { says: /The wood’s given enough here today\./ })
  await expect.poll(async () => (await gather(page))?.last).toBe('refused:gathered-enough')
  expect(await usesLeft(page, axe)).toBe(29)
  await expect.poll(async () => (await gather(page))!.spots.filter((s) => s.target === 'tangle-tree' || s.target === 'ash').length).toBe(0)
  await shot(page, 'gathering-soft-line')
  // The boulders are another kind of work, and still answer.
  expect((await gather(page))!.spots.some((s) => s.target === 'boulder')).toBe(true)
})

test('on your land: inside the lamps a stump stays, the unlit edge regrows, and a planted sapling stands', async ({ page }) => {
  test.setTimeout(180_000)
  const id = await freshPlayer(page, 'Ruta')
  const axe = giveInstance(id, 'bench-axe', { max: 90 })
  fund(id, { items: { 'birch-sapling': 1 } })
  await claimDeed(page)
  const land = await toMyLand(page)
  await expect.poll(async () => (await gather(page))?.spots.length ?? 0).toBeGreaterThan(0)

  // Inside the lamplight: the stump is kept by the server.
  const lit = await workOne(page, ['tree', 'iron-oak'], /Chop the/, { lit: true })
  await expect.poll(async () => (await landAt(page, land.gate))?.stumps ?? []).toContainEqual([lit.tx, lit.ty])
  await expect.poll(async () => spotAt(page, lit)).toBe('stump')
  await shot(page, 'gathering-land-stump')
  // Out on the unlit edge: felled here and now, never kept.
  const dark = await workOne(page, ['tree', 'iron-oak'], /Chop the/, { lit: false })
  await expect.poll(async () => spotAt(page, dark)).toBe('stump')
  expect((await landAt(page, land.gate))?.stumps ?? []).not.toContainEqual([dark.tx, dark.ty])
  await expect.poll(async () => usesLeft(page, axe)).toBe(28)

  // Plant a sapling on open grass in the lamplight, from the inventory.
  const home = (await landAt(page, land.gate))!
  const lights = homeLights(home.items.filter((i) => i.itemDef === 'lantern-post' && i.scene === 'outdoor' && i.x !== null) as { x: number; y: number }[])
  const at = await player(page)
  const open: [number, number][] = []
  for (let y = 1; y < 29; y++) for (let x = 1; x < 39; x++) if (isLit(lights, x, y) && plantable({ ...home, items: home.items as never, plants: home.plants ?? [] }, x, y)) open.push([x, y])
  open.sort((a, b) => Math.hypot(a[0] * 16 - at.x, a[1] * 16 - at.y) - Math.hypot(b[0] * 16 - at.x, b[1] * 16 - at.y))
  let tile: [number, number] | null = null
  for (const t of open) {
    if (await settle(page, { x: t[0] * 16 + 8, y: t[1] * 16 + 10 })) {
      tile = t
      break
    }
  }
  expect(tile, 'open grass in the lamplight to stand on').not.toBeNull()
  await page.keyboard.press('i')
  const dialog = page.getByRole('dialog', { name: 'Inventory' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('tab', { name: /Supplies/ }).click()
  await dialog.locator('[data-cell="item:birch-sapling"]').click()
  await dialog.locator('[data-item="item:birch-sapling"]').getByRole('button', { name: 'Plant' }).click()
  await expect(dialog.getByTestId('inv-message')).toHaveText('You planted a birch sapling.')
  // Escape closes the card, then the bag.
  await page.keyboard.press('Escape')
  if (await dialog.isVisible()) await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await landAt(page, land.gate))?.plants ?? []).toContainEqual(expect.objectContaining({ itemDef: 'birch-sapling', x: tile![0], y: tile![1], lit: true }))
  // Step off it to see it standing there.
  const beside = open.find((t) => t !== tile && Math.abs(t[0] - tile![0]) + Math.abs(t[1] - tile![1]) === 2)
  if (beside) await settle(page, { x: beside[0] * 16 + 8, y: beside[1] * 16 + 10 })
  await shot(page, 'gathering-land-planted')

  // Leave and come back: the lit stump and the sapling stay, the edge has regrown.
  await toMyLand(page)
  await expect.poll(async () => spotAt(page, lit)).toBe('stump')
  await expect.poll(async () => spotAt(page, dark)).toMatch(/^(tree|iron-oak)$/)
  // And through a reload.
  await page.reload()
  await page.getByRole('button', { name: /Continue/ }).click()
  await page.waitForFunction((a) => {
    const s = (window as unknown as { __fsSafety?: () => { areaId: string; transitioning: boolean } | null }).__fsSafety?.()
    return !!s && !s.transitioning && s.areaId === a
  }, `home:${land.gate}`)
  const after = await landAt(page, land.gate)
  expect(after?.stumps ?? []).toContainEqual([lit.tx, lit.ty])
  expect(after?.plants ?? []).toContainEqual(expect.objectContaining({ itemDef: 'birch-sapling', x: tile![0], y: tile![1] }))
  await expect.poll(async () => usesLeft(page, axe)).toBe(28)
})
