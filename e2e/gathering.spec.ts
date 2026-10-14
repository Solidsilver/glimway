import type { Page } from './fixtures'
import { expect, test } from './fixtures'
import { sql, accountOf, moveServerClock, pinWorld, refusal } from './connected'
import { claimDeed, freshPlayer, fund, giveInstance, homeAt, landOf, shot, toMyLand, type Home } from './home-helpers'
import { chunkWhole, diagnose, expectToast, parkCreatures, player, pressOn, readDialogue, standFor, targetNow, waitForLive, warp, windowWhole } from './helpers'
import { HOMESTEAD_DATA, plantable } from '../src/lib/homestead.ts'
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

/** A gathering piece's interaction point (src/game/entities/gathering.ts). */
const gatherId = (s: { tx: number; ty: number }) => `gather:${s.tx},${s.ty}`

/**
 * Places where one of `targets` could be worked: walkable tiles beside the
 * spot, off the exits, away from live creatures (a wisp's knockback would
 * move the hero and the prompt), and where the game itself elects that
 * piece (`__fsTarget` at those feet: rank, reach and the tool in hand, so a
 * Wilds claim, a nearer piece or a tie is the game's to settle, not a copy
 * of its rules here). Hold the tool first: a piece answers only to its own.
 */
async function candidates(page: Page, targets: string[], lit?: boolean): Promise<Candidate[]> {
  return page.evaluate(([targets, lit]) => {
    type T = { target: { id: string } | null }
    const w = window as unknown as {
      __fsGather: () => GatherView | null
      __fsWorld: () => { exits: { tx: number; ty: number; tw: number; th: number }[] }
      __fsTileSolid: (x: number, y: number) => boolean
      __fsEnemies?: () => { x: number; y: number; state: string }[]
      __fsTarget: (x: number, y: number) => T
    }
    const spots = w.__fsGather()?.spots ?? []
    const exits = w.__fsWorld().exits ?? []
    const live = (w.__fsEnemies?.() ?? []).filter((e) => e.state !== 'dead')
    const inExit = (x: number, y: number) => exits.some((e) => x >= e.tx && x < e.tx + e.tw && y >= e.ty && y < e.ty + e.th)
    const out: Candidate[] = []
    for (const s of spots) {
      if (!targets.includes(s.target)) continue
      if (lit !== undefined && s.lit !== lit) continue
      for (const [x, y] of [[s.tx, s.ty + 1], [s.tx, s.ty - 1], [s.tx - 1, s.ty], [s.tx + 1, s.ty]] as const) {
        if (w.__fsTileSolid(x, y) || inExit(x, y)) continue
        const hero = { x: x * 16 + 8, y: y * 16 + 12 }
        if (live.some((e) => Math.hypot(e.x - hero.x, e.y - hero.y) < 180)) continue
        if (w.__fsTarget(hero.x, hero.y).target?.id !== `gather:${s.tx},${s.ty}`) continue
        out.push({ spot: s, hero })
      }
    }
    return out
  }, [targets, lit] as const)
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

/** Candidates nearest the hero first: small moves, fewer merges in flight. */
async function candidatesNear(page: Page, targets: string[], lit?: boolean): Promise<Candidate[]> {
  const cands = await candidates(page, targets, lit)
  const at = await player(page)
  return cands.sort((a, b) => Math.hypot(a.hero.x - at.x, a.hero.y - at.y) - Math.hypot(b.hero.x - at.x, b.hero.y - at.y))
}

/**
 * Stand on a candidate: the hero set down there, and the game electing its
 * piece with the prompt saying `prompt`. False (and why) when it doesn't hold.
 * Once it does, the prompt on screen must say it too: a fixture chosen and
 * not shown is a failure, never a reason to try the next one.
 */
async function standOn(page: Page, c: Candidate, prompt: RegExp, why: string[]): Promise<boolean> {
  const stood = await standFor(page, gatherId(c.spot), [c.hero], why)
  if (!stood) return false
  const label = (await targetNow(page)).target?.label ?? ''
  if (!prompt.test(label)) {
    why.push(`${gatherId(c.spot)} says “${label}”`)
    return false
  }
  await expect(page.locator('.prompt'), `the prompt on screen for ${gatherId(c.spot)}`).toBeVisible()
  await expect(page.locator('.prompt'), `the prompt on screen for ${gatherId(c.spot)}`).toContainText(label)
  return true
}

/**
 * Work the nearest piece the game elects (or the one at `at`): stand, its
 * own target, press, and hear the answer. On the open map, `at`'s chunk
 * must be whole first (its pieces registered).
 */
async function workOne(page: Page, targets: string[], prompt: RegExp, opts: { lit?: boolean; says?: RegExp; at?: { tx: number; ty: number } } = {}): Promise<Spot & { from: { x: number; y: number } }> {
  const why: string[] = []
  // The right tool in hand: only what it works answers.
  await hold(page, gatheringTarget(targets[0])?.action ?? 'chop')
  // A quiet chunk: the creatures set aside (a wisp near every tree empties
  // the candidate list, and its knockback moves the hero off the prompt).
  await parkCreatures(page)
  const cands = (await candidatesNear(page, targets, opts.lit)).filter((c) => !opts.at || (c.spot.tx === opts.at.tx && c.spot.ty === opts.at.ty))
  for (const c of cands.slice(0, 8)) {
    if (!(await standOn(page, c, prompt, why))) continue
    await pressOn(page, gatherId(c.spot))
    // A claim's discovery (a POI was the nearest press) opens a reading
    // panel that holds the screen: read it away before going on.
    await readDialogue(page).catch(() => null)
    try {
      await expectToast(page, opts.says ?? /Found: /, { timeout: 15_000 })
    } catch (err) {
      throw new Error(`no answer at ${c.spot.target} ${c.spot.tx},${c.spot.ty}: last=${(await gather(page))?.last}; ${await diagnose(page)}; ${String(err).slice(0, 200)}`)
    }
    return { ...c.spot, from: c.hero }
  }
  throw new Error(`nothing to work (${targets.join('/')}${opts.at ? ` at ${opts.at.tx},${opts.at.ty}` : ''}): ${cands.length} candidates; ${why.join(' ')}; ${await diagnose(page)}`)
}

/** Work the piece at a spot again from where you stood (the felled tree's stump). */
async function workAgain(page: Page, spot: Spot & { from: { x: number; y: number } }, prompt: RegExp, kind = 'dig'): Promise<void> {
  await hold(page, kind)
  await parkCreatures(page)
  const why: string[] = []
  expect(await standOn(page, { spot, hero: spot.from }, prompt, why), `back where you stood, the prompt on ${spot.tx},${spot.ty}: ${why.join(' ')}`).toBe(true)
  await pressOn(page, gatherId(spot))
  await expectToast(page, /Found: /, { timeout: 15_000 })
}

/** Set the hero down (its save's position follows) and make sure it took. */
async function settle(page: Page, at: { x: number; y: number }): Promise<boolean> {
  await page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [at.x, at.y] as const)
  return expect
    .poll(async () => {
      const p = await player(page)
      return Math.hypot(p.x - at.x, p.y - at.y) <= 2
    }, { timeout: 3_000 })
    .toBe(true)
    .then(() => true, () => false)
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

/** What is drawn on screen for a tile's piece (window.__fsArtAt): frames, and whether each fades. */
const artAt = (page: Page, s: { tx: number; ty: number }) =>
  page.evaluate(([x, y]) => (window as unknown as { __fsArtAt: (x: number, y: number) => { frame: string; fades: boolean }[] }).__fsArtAt(x, y), [s.tx, s.ty] as const)

/** The gathering specs' world (pinned: the Tangle is still land, the same trees on every run). */
const GATHER_SEED = 'e2e-gathering'

/** The first UTC noon after `unix` (at most a day on). */
const nextUtcNoon = (unix: number) => Math.floor(unix / 86400) * 86400 + 43200 + (unix % 86400 >= 43200 ? 86400 : 0)

test('chopping a tree in the Tangle: wear, timber, a stump to dig, and regrowth', async ({ page }) => {
  test.setTimeout(150_000)
  const id = await freshPlayer(page, 'Teo')
  const axe = giveInstance(id, 'bench-axe', { max: 90 })
  const spade = giveInstance(id, 'bench-spade', { max: 90 })

  // The Tangle of a pinned world (still land: the same trees every run).
  await pinWorld(page, GATHER_SEED)
  await warp(page, 'outdoors', 20, 20)
  await windowWhole(page)
  // A path-side tree: its canopy is drawn by the foreground pass (it fades
  // when walked under). That canopy used to stay standing over the stump.
  // The first, nearest the warp, whose standing spot the game gives to its chop.
  await hold(page, 'chop')
  await parkCreatures(page)
  let tree: Spot | null = null
  const why: string[] = []
  for (const c of await candidatesNear(page, ['tangle-tree', 'ash'])) {
    if (!(await artAt(page, c.spot)).some((a) => a.fades)) continue
    if (!(await standOn(page, c, /Chop the (tree|ash)/, why))) continue
    tree = c.spot
    break
  }
  expect(tree, `a path-side tree to fell (seed ${GATHER_SEED}): ${why.join(' ')}; ${await diagnose(page)}`).not.toBeNull()
  await chunkWhole(page, tree!)
  const standing = await artAt(page, tree!)

  // Refused: the whole tree stays, canopy and all, and it can still be chopped.
  await page.route('**/api/items/gather', async (route) => route.fulfill(await refusal(page, 'too-far-away')))
  await workOne(page, ['tangle-tree', 'ash'], /Chop the (tree|ash)/, { at: tree!, says: /You need to be right there/ })
  await page.unroute('**/api/items/gather')
  expect(await artAt(page, tree!)).toEqual(standing)
  expect(await spotAt(page, tree!)).toMatch(/^(tangle-tree|ash)$/)

  const spot = await workOne(page, ['tangle-tree', 'ash'], /Chop the (tree|ash)/, { at: tree! })
  // The axe wore one use; the tree paid timber and left a stump to dig.
  await expect.poll(async () => usesLeft(page, axe)).toBe(29)
  expect(await stack(page, 'timber')).toBeGreaterThanOrEqual(2)
  await expect.poll(async () => spotAt(page, spot)).toBe('stump')
  // Felled whole: nothing of the tree is drawn there any more (the stump is the gathering's own).
  expect(await artAt(page, spot)).toEqual([])
  await shot(page, 'gathering-tangle-chop')

  // The stump digs out (turncap spawn), and the ground opens.
  await workAgain(page, spot, /Dig the stump/)
  await expect.poll(async () => usesLeft(page, spade)).toBe(29)
  expect(await stack(page, 'turncap-spawn')).toBeGreaterThanOrEqual(1)
  await expect.poll(async () => spotAt(page, spot)).toBeNull()

  // The same chunk built again within the visit: the dug-out tree stays
  // open ground, with nothing drawn on it (its canopy neither).
  const chunk = (await gather(page))!.area
  await warp(page, 'outdoors', 20, 20)
  await chunkWhole(page, spot)
  expect((await gather(page))!.area).toBe(chunk)
  await expect.poll(async () => spotAt(page, spot)).toBeNull()
  expect((await gather(page))!.left.filter((l) => l.tx === spot.tx && l.ty === spot.ty)).toEqual([])
  expect(await artAt(page, spot)).toEqual([])

  // The drift: leave the outdoor space, come back, and the woods have regrown.
  // The Commons is part of the same outdoor visit now.
  await warp(page, 'village', 23, 19)
  await warp(page, 'outdoors', 20, 20)
  await chunkWhole(page, spot)
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
  // One tree short of the day's cap (numbers live on the server only). The
  // cap counts by the server's UTC day: its clock is set to the next noon,
  // twelve hours from either midnight, and the seeded day is that one's (a
  // run that crossed midnight before its chops would count on a new day).
  await pinWorld(page, GATHER_SEED)
  const noon = await moveServerClock(page, nextUtcNoon(await moveServerClock(page, 0)))
  const day = Math.floor(noon / 86400)
  sql(`INSERT INTO gathering_caps(account_id,action,day,day_count,area,visit_id,visit_count,updated_at) VALUES('${accountOf(id)}','chop',${day},29,'','',0,0);`)

  await warp(page, 'outdoors', 20, 20)
  await windowWhole(page)
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
  const ground = await landOf(page, land.gate)
  const lights = homeLights(home.items.filter((i) => i.itemDef === 'lantern-post' && i.scene === 'outdoor' && i.x !== null) as { x: number; y: number }[])
  const at = await player(page)
  const open: [number, number][] = []
  for (let y = 1; y < 29; y++) for (let x = 1; x < 39; x++) if (isLit(lights, x, y) && plantable({ ...home, items: home.items as never, plants: home.plants ?? [] }, x, y, HOMESTEAD_DATA, ground)) open.push([x, y])
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
