import { expect, test, type Page } from './fixtures'
import { residentsOut } from './room-helpers'
import { seasonOf, serverState } from './connected'
import { earnGlims, freshPlayer, fund, giveInstance } from './home-helpers'
import { expectToast, openTalk, readDialogue, untilChoices, waitForLive, warp } from './helpers'
import { calendarAt } from '../src/lib/calendar.ts'
import { sellerFor } from '../src/lib/items.ts'

/**
 * The seasons against the worker's own Go server (docs/items/crafting-and-repair.md,
 * "Seasonal materials"; docs/items/catalogue.md, tallow): Hazel sells a lump
 * of tallow at her kitchen door for a glim, in her own words; and in the
 * Quiet the frozen village pond is broken for frost-glass. The dev calendar
 * hook moves only the client's clock and the server reads its own, so both
 * are set (seasonOf, e2e/connected.ts): inside the Quiet the pond answers
 * with frost-glass; with only the screen in the Quiet, with the season's
 * refusal (no wear, nothing gathered). Neither depends on today's date.
 */

const stack = (page: Page, def: string) =>
  page.evaluate(
    (d) => (window as unknown as { __fsItems: () => { stacks: { itemDef: string; qty: number }[] } | null }).__fsItems()?.stacks.find((s) => s.itemDef === d)?.qty ?? 0,
    def
  )

const usesLeft = (page: Page, tool: string) =>
  page.evaluate(
    (t) => (window as unknown as { __fsItems: () => { instances: { id: string; usesLeft: number }[] } | null }).__fsItems()?.instances.find((i) => i.id === t)?.usesLeft ?? -1,
    tool
  )

/** Opening the inventory reads the pack again (these things went in by hand). */
async function packReads(page: Page, holds: () => Promise<boolean>): Promise<void> {
  await page.keyboard.press('i')
  await expect(page.getByRole('dialog', { name: 'Inventory' })).toBeVisible()
  await expect.poll(holds).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Inventory' })).toBeHidden()
}

type GatherView = { area: string; spots: { target: string; tx: number; ty: number }[]; prompt: { target: string; tx: number; ty: number; label: string } | null; last: string }
const gather = (page: Page) => page.evaluate(() => (window as unknown as { __fsGather: () => GatherView | null }).__fsGather())

test('Hazel sells a lump of tallow for a glim, in her own words', async ({ page }) => {
  test.setTimeout(120_000)
  const id = await freshPlayer(page, 'Bryn')
  await earnGlims(page, id)
  const before = (await serverState(page)).body.state.glims as number
  const tallow = sellerFor('hazels-kitchen')!.goods[0]
  // Carrying Joss's whistle: her keepsake ask and the sale share one "Not yet".
  fund(id, { items: { 'tin-whistle': 1 } })
  await packReads(page, async () => (await stack(page, 'tin-whistle')) === 1)

  // Hazel in the square with her basket (her seller row follows her: the world's clock too).
  await residentsOut(page, { server: true })
  await warp(page, 'village', 13, 15)
  await openTalk(page, 'Talk to Hazel')
  const choices = await untilChoices(page)
  expect(choices.map((c) => c.text)).toContain(tallow.label)
  // 0.6.1: one choice per good, at its one price in glims (silas-yard.md 1.7).
  expect(choices.map((c) => c.text)).toEqual(['Give it back', tallow.label, 'Not yet'])
  await readDialogue(page, { pick: new RegExp(`^${tallow.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
  // Her line is the reply, and the toast says it again when the tallow lands.
  const said = (await page.evaluate(() => (window as unknown as { __fsDialogue: () => { said: string[] } }).__fsDialogue().said)) ?? []
  expect(said).toContain(tallow.line)
  await expectToast(page, tallow.line, { timeout: 15_000 })

  await expect.poll(async () => stack(page, 'tallow')).toBe(1)
  await expect.poll(async () => (await serverState(page)).body.state.glims).toBe(before - 1)
})

/**
 * The pond in the Quiet, with the client's calendar on `calendar` and the
 * world's on whatever seasonOf set: the pick (30 uses) in hand at the iced
 * bank, E pressed on the ice.
 */
async function breakTheIce(page: Page, calendar: number, pick: string): Promise<void> {
  expect(calendarAt(calendar).mark).toBe('Quiet')
  await page.evaluate((t) => (window as unknown as { __fsDevCalendar: (t: number) => void }).__fsDevCalendar(t), calendar)
  await packReads(page, async () => (await usesLeft(page, pick)) === 30)
  // Beside the ice at 38,21, on the pond's east bank (built iced: the screen's calendar says Quiet).
  await warp(page, 'village', 39, 21)
  // The pick in hand: the belt's second slot (the weapon, then the pick).
  await waitForLive(page)
  await page.keyboard.press('2')
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __fsHeld: () => { kind: string } }).__fsHeld().kind)).toBe('break')
  await expect.poll(async () => (await gather(page))?.spots.filter((s) => s.target === 'pond-ice').length).toBe(3)
  await expect.poll(async () => (await gather(page))?.prompt?.label ?? '').toBe('Break the pond ice')
  await expect(page.locator('.prompt')).toContainText('Break the pond ice')
  await waitForLive(page)
  await page.keyboard.press('e')
}

test('in the Quiet the frozen pond breaks for frost-glass, by the server’s own calendar', async ({ page }) => {
  test.setTimeout(150_000)
  const id = await freshPlayer(page, 'Wren')
  // Both clocks well inside the Quiet: the server checks the season on its own.
  const quiet = await seasonOf(page, id, 'Quiet')
  const pick = giveInstance(id, 'bench-pick', { max: 90 })
  await breakTheIce(page, quiet, pick)
  await expectToast(page, /Found: .*frost-glass/i, { timeout: 15_000 })
  await expect.poll(async () => stack(page, 'frost-glass')).toBeGreaterThanOrEqual(1)
  await expect.poll(async () => usesLeft(page, pick)).toBe(29)
  // The ice stays standing (the day's caps hold you, not the map).
  expect((await gather(page))?.spots.some((s) => s.target === 'pond-ice' && s.tx === 38 && s.ty === 21)).toBe(true)
})

test('out of the Quiet the server refuses the ice a stale screen still shows: no wear, nothing gathered', async ({ page }) => {
  test.setTimeout(150_000)
  const id = await freshPlayer(page, 'Wren')
  // The world's clock outside the Quiet, the screen's moved into it on purpose (a stale map).
  const world = await seasonOf(page, id, 'Quiet', { outside: true })
  const pick = giveInstance(id, 'bench-pick', { max: 90 })
  let screen = world
  while (!(calendarAt(screen).mark === 'Quiet' && calendarAt(screen + 86400).mark === 'Quiet')) screen += 3600
  await breakTheIce(page, screen, pick)
  await expectToast(page, 'Not now — that belongs to another season. Come back when it turns.', { timeout: 15_000 })
  await expect.poll(async () => (await gather(page))?.last).toBe('refused:not-in-season')
  expect(await usesLeft(page, pick)).toBe(30)
  expect(await stack(page, 'frost-glass')).toBe(0)
  expect((await gather(page))?.spots.some((s) => s.target === 'pond-ice' && s.tx === 38 && s.ty === 21)).toBe(true)
})
