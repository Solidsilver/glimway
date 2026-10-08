import { expect, test, type Page } from './fixtures'
import { serverState, sql, accountOf } from './connected'
import { dialogueState, holdUntil, readDialogue, untilChoices, untilLine, waitForLive, waitForWilds, warp, wilds, type WildsDump } from './helpers'
import { freshPlayer, fund } from './home-helpers'
import { chunkAreaId } from '../src/game/wilds/regions.ts'
import { chunkTerrain, type Epoch } from '../src/lib/wilds/index.ts'
import { siteChunks } from '../src/lib/wilds/outer.ts'
import { echoAssignments } from '../src/lib/wilds/stories.ts'
import { calendarAt } from '../src/lib/calendar.ts'


/**
 * Leaving keepsakes at Echo camps (docs/items/overview.md, "Returning
 * keepsakes"): a keepsake with no living owner can be left at that person's
 * Echo camp, and the echo settles a little softer. Nan's eleven stamped
 * road-nails at her camp in the outer Wilds, against the real Go server:
 * the camp offers the leave ("not yet" never closes the door), the leave is
 * the server's `return` item op (`keep:return:road-nails:nan`, one time,
 * `returned:road-nails` and `echo:nan:softened` on the world's word), the
 * echo's own register answers, and a settling that comes after ends softer.
 */

const OUTER = 'outer-1'

type ItemsView = { stacks: { itemDef: string; qty: number }[] } | null
const items = (page: Page) => page.evaluate(() => (window as unknown as { __fsItems: () => ItemsView }).__fsItems())

/** The pack (re)read holding `def`: opening the inventory asks the server for the item model. */
async function packHolds(page: Page, def: string): Promise<void> {
  await page.keyboard.press('i')
  await expect(page.getByRole('dialog', { name: 'Inventory' })).toBeVisible()
  await expect.poll(() => items(page), { timeout: 15_000 }).not.toBeNull()
  await expect
    .poll(async () => (await items(page))!.stacks.some((s) => s.itemDef === def), { message: `the pack holds ${def}`, timeout: 15_000 })
    .toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Inventory' })).toBeHidden()
}

const areaNow = (page: Page) => page.evaluate(() => String((window as unknown as { __fsSafety: () => { areaId: string } }).__fsSafety().areaId))

/** From the Tangle's far side, walk north over the crossing into the outer Wilds. */
async function crossOver(page: Page): Promise<string> {
  await warp(page, chunkAreaId(1, 0), 12, 2)
  await holdUntil(page, 'ArrowUp', async () => (await areaNow(page)).startsWith(`chunk:${OUTER}`))
  return waitForWilds(page, OUTER)
}

/** Read a conversation through to its end. */
async function readThrough(page: Page): Promise<void> {
  const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
  await expect(dialogue).toBeVisible()
  await readDialogue(page)
  await expect(dialogue).toBeHidden()
}

/** The flags on the server's word (the state read). */
const serverFlags = async (page: Page): Promise<string[]> => (await serverState(page)).body?.state?.flags ?? []

/**
 * A seed whose outer Wilds wait for Nan at an Echo camp this wick, with her
 * camp's chunk and placed tile (the same assignment the client computes).
 */
function nanCamp(late: boolean): { seed: string; epoch: Epoch; site: { id: string; cx: number; cy: number; tx: number; ty: number } } {
  const day = calendarAt(Math.floor(Date.now() / 1000))
  const season = `t:${day.startsAt}:${day.nextTurning}`
  for (let n = 0; n < 80; n++) {
    const seed = `echo-keepsake-${n}`
    const epoch: Epoch = { worldSeed: seed, regionId: OUTER, generatorVersion: 1, season }
    const sites = siteChunks(epoch)
    const assigned = echoAssignments(epoch, sites, late)
    for (const s of sites.filter((s) => s.kind === 'echo')) {
      if (assigned.get(s.id)?.member !== 'nan') continue
      const placed = chunkTerrain(epoch, s.cx, s.cy).sites.find((x) => x.id === s.id)!
      return { seed, epoch, site: { id: s.id, cx: s.cx, cy: s.cy, tx: placed.tx, ty: placed.ty } }
    }
  }
  throw new Error('no seed in reach waits for Nan this wick')
}

test('leaving Nan’s road-nails at her Echo camp, then the softer settling', async ({ page }) => {
  test.setTimeout(150_000)
  const id = await freshPlayer(page, 'Merrit')

  // A world whose outer Wilds wait for Nan at a camp this wick (the epoch is
  // created from the world's seed on the first read of the region).
  const camp = nanCamp(false)
  sql(`UPDATE worlds SET seed='${camp.seed}' WHERE id=(SELECT world_id FROM players WHERE account_id='${accountOf(id)}') AND id NOT IN (SELECT world_id FROM region_epochs);`)

  // The Wilds gave the road-nails back some turning ago: they're in the pack.
  fund(id, { items: { 'road-nails': 1 } })
  await packHolds(page, 'road-nails')

  await crossOver(page)
  await warp(page, chunkAreaId(camp.site.cx, camp.site.cy, OUTER), camp.site.tx, camp.site.ty + 1)
  await waitForWilds(page, OUTER)
  const site = (await wilds(page)).sites.find((s) => s.kind === 'echo' && s.echo === 'nan')!
  expect(site).toMatchObject({ settled: false })

  // The camp's interaction offers the leave while the nails are carried.
  await expect(page.locator('.prompt')).toContainText('Leave the eleven road-nails here')
  await waitForLive(page)
  await page.keyboard.press('e')
  const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
  await expect(dialogue).toBeVisible()
  const choices = await untilChoices(page)
  expect(choices.map((c) => c.text)).toEqual(['Leave the eleven road-nails here', 'Strike the light she was reaching for', 'Not yet'])
  // "Not yet" never closes the door: the nails stay, and the camp asks again.
  await readDialogue(page, { pick: /Not yet/ })
  expect((await items(page))!.stacks.find((s) => s.itemDef === 'road-nails')?.qty).toBe(1)
  expect((await wilds(page)).sites.find((s) => s.id === site.id)!.settled).toBe(false)
  await waitForLive(page)

  // The leave: the server's `return` op (one time), the echo's own register.
  await page.keyboard.press('e')
  await expect(dialogue).toBeVisible()
  await untilChoices(page)
  await readDialogue(page, { pick: /Leave the eleven road-nails here/ })
  await expect
    .poll(async () => {
      const flags = await serverFlags(page)
      return [flags.includes('returned:road-nails'), flags.includes('echo:nan:softened')]
    }, { timeout: 15_000, message: 'the world’s word: returned and softened' })
    .toEqual([true, true])
  await expect
    .poll(async () => (await dialogueState(page)).seen.some((x) => /road-nails out by the lamp|reaching hand stills/.test(x.text)), { message: 'the echo’s leaving lines' })
    .toBe(true)
  if ((await dialogueState(page)).open) await readDialogue(page)
  expect((await items(page))!.stacks.find((s) => s.itemDef === 'road-nails')).toBeUndefined()
  await waitForLive(page)

  // Settling now comes out a little softer: one closing line more.
  await expect(page.locator('.prompt')).toContainText('Strike the light she was reaching for')
  await page.keyboard.press('e')
  await expect(dialogue).toBeVisible()
  await untilLine(page, /every post of it/)
  await readDialogue(page)
  await expect
    .poll(async () => (await serverFlags(page)).includes('echo:nan'), { timeout: 15_000, message: 'the echo settled' })
    .toBe(true)

  // Left and settled: the offer is over, and the camp keeps only its lamp.
  await waitForLive(page)
  const after: WildsDump = await wilds(page)
  expect(after.sites.find((s) => s.id === site.id)!.settled).toBe(true)
  await expect(page.locator('.prompt')).toContainText('Take Nan’s lamplighter pole')
})
