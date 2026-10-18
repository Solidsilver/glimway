import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from './fixtures'
import { accountOf, pinWorld, reenter, seedMarks, sql, wickSlack } from './connected'
import { claimDeed, freshPlayer, fund, homes, shot } from './home-helpers'
import { atTile, parkCreatures, waitForWilds, warp, windowWhole } from './helpers'
import { anchorPoint } from './positions'

/**
 * The HUD's land chip and the dimming notice (lamps.md 1.1, 2.5), against
 * the real Go server: wild land says it turns; a camp you set says it's
 * held and yours; town has no chip. The camp's oil runs out (forced) while
 * you're away: the next session tells you once, and the chip says it's
 * dimming when you're back. The once-per-dimming rules are the server's
 * tests (lamp_notices_test.go); the words are tests/land-chip.test.ts.
 */

const S = 24
const SEED = 'e2e-camps'

type Hooks = {
  __fsImagesNamed: (p: string) => { key: string; x: number; y: number }[]
  __fsCamps: () => { camps: { id: string; cx: number; cy: number; x: number; y: number; oil: number }[]; spot: { tx: number; ty: number } | null } | null
  __fsPathTile: (tx: number, ty: number) => { surface: string | null; baseSolid: boolean; decor: string[]; occupied: boolean; change: unknown } | null
  __fsHomes: { fresh: () => Promise<void> }
  __fsToasts: () => { seen: { text: string }[] }
}

const camps = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__fsCamps())
const toasts = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__fsToasts().seen.map((t) => t.text))
const DIMMING_NOTICE = /Your way-lamp is dimming\. A flask of oil keeps the camp lit\./

/** The next lamp-notices answer (a new session asks with its first calendar): kind and id of each light told. */
const noticesAnswer = (page: Page) =>
  page.waitForResponse((r) => new URL(r.url()).pathname === '/api/lamp-notices' && r.status() === 200, { timeout: 60_000 })
    .then(async (r) => ((await r.json()) as { notices: { kind: string; id: string }[] }).notices.map((n) => ({ kind: n.kind, id: n.id })))

/** Open land with open land above it in a wick chunk past the Whitequiet, where a lamp could stand (camps.spec.ts). */
async function standInTheWilds(page: Page): Promise<{ tx: number; ty: number }> {
  for (const [cx, cy] of [[2, -4], [-2, -4], [2, -7], [-2, -7], [3, -1], [-3, -1]] as const) {
    await warp(page, 'outdoors', cx * S + 12, cy * S + 12)
    await windowWhole(page)
    const open = await page.evaluate(([cx, cy]) => {
      const w = window as unknown as Hooks
      const ok = (tx: number, ty: number) => {
        const t = w.__fsPathTile(tx, ty)
        return !!t && t.surface === 'land' && !t.baseSolid && !t.occupied && !t.change && t.decor.length === 0
      }
      for (let r = 0; r < 8; r++)
        for (let ty = cy * 24 + 12 - r; ty <= cy * 24 + 12 + r; ty++)
          for (let tx = cx * 24 + 12 - r; tx <= cx * 24 + 12 + r; tx++) if (ok(tx, ty) && ok(tx, ty - 1)) return { tx, ty }
      return null
    }, [cx, cy] as const)
    if (!open) continue
    await warp(page, 'outdoors', open.tx, open.ty)
    await waitForWilds(page)
    await parkCreatures(page)
    if ((await camps(page))?.spot) return open
  }
  throw new Error(`no open land for a way-lamp (seed ${SEED})`)
}

test('the land chip: turning, held and yours, none in town, dimming; the dimming is told once', async ({ page }) => {
  test.setTimeout(300_000)
  const id = await freshPlayer(page, 'Wren')
  await wickSlack(page)
  await pinWorld(page, SEED)
  await claimDeed(page)
  seedMarks(id, 'keeper:hand')
  await reenter(page)
  const lamp = randomUUID()
  sql(`INSERT INTO homestead_items(id,item_def,location,account_id) VALUES('${lamp}','way-lamp','inventory','${accountOf(id)}');`)
  fund(id, { items: { 'hearth-oil': 1 } })
  await page.evaluate(() => (window as unknown as Hooks).__fsHomes.fresh())
  await expect.poll(async () => (await homes(page)).mine?.items?.length ?? 0).toBeGreaterThanOrEqual(1)

  // Out in the Wilds: unheld land turns.
  const at = await standInTheWilds(page)
  const chip = page.getByTestId('land-chip')
  await expect(chip).toHaveText(/Turning|Common/)

  // A way-lamp set here holds the chunk, and it's yours.
  await page.keyboard.press('i')
  const bag = page.getByRole('dialog', { name: 'Inventory' })
  await bag.getByRole('tab', { name: /Home/ }).click()
  const goods = bag.getByTestId('inv-page-home')
  await goods.locator('[data-cell="decoration:way-lamp"]').click()
  await goods.locator('[data-item="decoration:way-lamp"]').locator('[data-act="set-lamp"]').click()
  await expect.poll(async () => (await camps(page))?.camps.find((c) => c.id === lamp)?.oil ?? null).toBe(1)
  if (await bag.isVisible()) await page.keyboard.press('Escape')
  await expect(chip).toHaveText('Held · your camp')
  await expect(chip).toHaveAttribute('title', /Lamplight holds this land/)
  // The sentence on a tap, and the chip is a named button.
  await chip.click()
  await expect(chip).toHaveAttribute('aria-expanded', 'true')
  await shot(page, 'land-chip-held')

  // Town is outside upkeep: no chip.
  await atTile(page, anchorPoint('hearthwick:arch'))
  await expect(chip).toHaveCount(0)

  // The oil runs out while you're away: the next session says so, once.
  // Its last wick (the oil gone at a turning, not yet guttering) is dimming already.
  sql(`UPDATE camps SET oil=0,dimming=0 WHERE id='${lamp}';`)
  let told = noticesAnswer(page)
  await reenter(page)
  expect(await told).toEqual([{ kind: 'way-lamp', id: lamp }])
  await expect.poll(() => toasts(page), { timeout: 15_000 }).toContainEqual(expect.stringMatching(DIMMING_NOTICE))

  // Back at the camp: the chip says it's dimming, in words and a dashed edge.
  await warp(page, 'outdoors', at.tx, at.ty)
  await waitForWilds(page)
  await expect(chip).toHaveText('Dimming · your camp')
  await expect(chip).toHaveClass(/dimming/)
  await expect(chip).toHaveAttribute('title', /last wick/)
  // The lamp itself agrees: drawn dimming on its last wick.
  await expect.poll(async () => (await camps(page))?.camps.find((c) => c.id === lamp)?.oil ?? null).toBe(0)
  const set = (await camps(page))!.camps.find((c) => c.id === lamp)!
  await expect.poll(() => page.evaluate(([x, y]) => (window as unknown as Hooks).__fsImagesNamed('om-art:way-lamp-')
    .filter((i) => Math.abs(i.x - x) < 9 && Math.abs(i.y - y) < 9).map((i) => i.key), [set.x * 16 + 8, set.y * 16 + 16] as const)).toEqual(['om-art:way-lamp-2'])
  await shot(page, 'land-chip-dimming')

  // Told once: another session says nothing more.
  await atTile(page, anchorPoint('hearthwick:arch'))
  told = noticesAnswer(page)
  await reenter(page)
  expect(await told).toEqual([])
  expect((await toasts(page)).filter((t) => DIMMING_NOTICE.test(t))).toEqual([])
})
