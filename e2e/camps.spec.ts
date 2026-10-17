import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from './fixtures'
import { accountOf, moveServerClock, pinWorld, reenter, seedMarks, sql, wickSlack } from './connected'
import { AT_PELL, claimDeed, DEEDS, freshPlayer, fund, go, homes, pellSays, readOn, shot, talk } from './home-helpers'
import { parkCreatures, spotsAround, standFor, waitForWilds, warp, windowWhole } from './helpers'
import { calendarAt } from '../src/lib/calendar.ts'

/**
 * Camps (roadmap 0.13; docs/design/lamps.md §2.5, §2.7), against the real Go
 * server: set a way-lamp out in the Wilds from the pack, top it up, set a
 * stool out in its light; then the oil runs out (forced, then one turning)
 * and the camp lapses, and Pell has the lamp and the stool in a crate to
 * collect. The burn, dim and lapse across turnings are the server's tests.
 */

const S = 24
const SEED = 'e2e-camps'

type Camp = { id: string; cx: number; cy: number; x: number; y: number; oil: number; dimming: boolean; pieces: { id: string; itemDef: string; x: number; y: number }[] }
type Hooks = {
  __fsCamps: () => { camps: Camp[]; spot: { tx: number; ty: number } | null } | null
  __fsPathTile: (tx: number, ty: number) => { surface: string | null; baseSolid: boolean; decor: string[]; occupied: boolean; change: unknown } | null
  __fsHomes: { fresh: () => Promise<void> }
  __fsImagesNamed: (p: string) => { key: string; x: number; y: number }[]
}

const camps = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__fsCamps())

/** Open land with open land above it, near the middle of a wick chunk past the Whitequiet. */
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

/** Open the pack on the Home page and pick a piece's card. */
async function homeCard(page: Page, def: string) {
  await page.keyboard.press('i')
  const bag = page.getByRole('dialog', { name: 'Inventory' })
  await expect(bag).toBeVisible()
  await bag.getByRole('tab', { name: /Home/ }).click()
  const goods = bag.getByTestId('inv-page-home')
  await goods.locator(`[data-cell="decoration:${def}"]`).click()
  return goods.locator(`[data-item="decoration:${def}"]`)
}

test('set a way-lamp, fill it, set a stool out; it lapses and Pell has everything', async ({ page }) => {
  test.setTimeout(300_000)
  const id = await freshPlayer(page, 'Wren')
  await wickSlack(page)
  await pinWorld(page, SEED)
  await claimDeed(page)
  // A camp's way-lamp takes the Keeper's hand (Mara's ledger; lamps.md 2.8).
  seedMarks(id, 'keeper:hand')
  await reenter(page)
  const account = accountOf(id)
  const lamp = randomUUID(), stool = randomUUID()
  sql(`INSERT INTO homestead_items(id,item_def,location,account_id) VALUES('${lamp}','way-lamp','inventory','${account}'),('${stool}','wooden-stool','inventory','${account}');`)
  fund(id, { items: { 'hearth-oil': 2 } })
  await page.evaluate(() => (window as unknown as Hooks).__fsHomes.fresh())
  await expect.poll(async () => (await homes(page)).mine?.items?.length ?? 0).toBeGreaterThanOrEqual(2)

  // Out in the Wilds: the lamp from the pack, set down beside you.
  await standInTheWilds(page)
  const lampCard = await homeCard(page, 'way-lamp')
  await lampCard.locator('[data-act="set-lamp"]').click()
  await expect.poll(async () => (await camps(page))?.camps.find((c) => c.id === lamp)?.oil ?? null).toBe(1)
  const set = (await camps(page))!.camps.find((c) => c.id === lamp)!
  await expect.poll(() => page.evaluate(([x, y]) => (window as unknown as Hooks).__fsImagesNamed('om-art:way-lamp-')
    .filter((i) => Math.abs(i.x - x) < 9 && Math.abs(i.y - y) < 9).map((i) => i.key), [set.x * 16 + 8, set.y * 16 + 16] as const)).toEqual(['om-art:way-lamp-1'])

  // Topped up from beside it. A Wilds claim in reach (a stone node) outranks
  // the lamp, as it does a way sign: stand where the game elects the lamp.
  const why: string[] = []
  if (!(await standFor(page, `wilds:camp:${lamp}`, await spotsAround(page, { tx: set.x, ty: set.y }), why)))
    throw new Error(`no spot elects the way-lamp at ${set.x},${set.y} (seed ${SEED}): ${why.join(' ')}`)
  await talk(page, /Look at the way-lamp/, /Top it up with hearth oil/)
  await readOn(page, /Your way-lamp\. It burns, 2 of 3 wicks/)
  await shot(page, 'camp-lamp-lit')

  // A stool out in its light.
  const stoolCard = await homeCard(page, 'wooden-stool')
  await stoolCard.locator('[data-act="set-out"]').click()
  await expect.poll(async () => (await camps(page))?.camps.find((c) => c.id === lamp)?.pieces.map((p) => p.itemDef).sort()).toEqual(['way-lamp', 'wooden-stool'])
  await shot(page, 'camp-stool')

  // The oil runs out (forced), and the turning after it the camp lapses.
  sql(`UPDATE camps SET oil=0,dimming=1 WHERE id='${lamp}';`)
  // Out of the Wilds, into Pell’s office (a talk now would pick his first reply, the deed).
  await go(page, DEEDS, AT_PELL.tx, AT_PELL.ty)
  const now = await moveServerClock(page, 0)
  await moveServerClock(page, calendarAt(now).nextTurning + 3600)
  // Pell has the crate. In his picker, the stool alone; the lamp waits on.
  await pellSays(page, /Choose what to take/)
  const crate = page.getByRole('dialog', { name: 'Pell’s crate' })
  await expect(crate).toBeVisible()
  const stoolEntry = sql(`SELECT id FROM recovery_entries WHERE account_id='${account}' AND instance_id='${stool}';`)
  await expect(crate.locator(`[data-crate-row="${stoolEntry}"]`)).toContainText('A wooden stool')
  await shot(page, 'crate-picker')
  await crate.locator(`[data-take="${stoolEntry}"]`).click()
  await expect(crate.getByTestId('crate-message')).toContainText(/Signed out to you: a wooden stool\./)
  await expect(crate.locator(`[data-crate-row="${stoolEntry}"]`)).toHaveCount(0)
  expect(sql(`SELECT location FROM homestead_items WHERE id IN ('${lamp}','${stool}') ORDER BY location;`).split('\n')).toEqual(['crate', 'inventory'])
  await crate.getByRole('button', { name: 'Close the crate' }).click()
  await expect(crate).toBeHidden()
  // The rest, everything at once, from his desk.
  await pellSays(page, /Take your things from the crate/)
  await readOn(page, /Signed out to you: a way-lamp\./)
  expect(sql(`SELECT location FROM homestead_items WHERE id IN ('${lamp}','${stool}') ORDER BY location;`).split('\n')).toEqual(['inventory', 'inventory'])
  expect(sql(`SELECT count(*) FROM camps WHERE id='${lamp}';`)).toBe('0')
  expect(sql(`SELECT count(*) FROM recovery_entries WHERE account_id='${account}' AND collected_at IS NULL;`)).toBe('0')
})

test('a communal post in view comes through leaving the Wilds and coming back', async ({ page }) => {
  test.setTimeout(240_000)
  const id = await freshPlayer(page, 'Wren')
  await wickSlack(page)
  await pinWorld(page, SEED)
  await claimDeed(page)
  await reenter(page)
  const lamp = randomUUID()
  sql(`INSERT INTO homestead_items(id,item_def,location,account_id) VALUES('${lamp}','way-lamp','inventory','${accountOf(id)}');`)
  await page.evaluate(() => (window as unknown as Hooks).__fsHomes.fresh())
  await expect.poll(async () => (await homes(page)).mine?.items?.length ?? 0).toBeGreaterThanOrEqual(1)

  // Set out in the Wilds as a communal lamp: drawn, with its solid body.
  const at = await standInTheWilds(page)
  await (await homeCard(page, 'way-lamp')).locator('[data-act="set-communal-lamp"]').click()
  const posts = () => page.evaluate(() => (window as unknown as { __fsCommunalLamps: () => { lamps: { id: string; kind: string }[] } | null }).__fsCommunalLamps()?.lamps.filter((l) => l.kind === 'post').map((l) => l.id) ?? [])
  await expect.poll(posts).toEqual([lamp])
  const drawn = () => page.evaluate(() => (window as unknown as Hooks).__fsImagesNamed('om-art:way-lamp-').length)
  await expect.poll(drawn).toBe(1)

  // The scene goes (Phaser destroys the collision group before the lamps'
  // shutdown) and comes back: no throw (the fixture fails on any page
  // error), and the post is drawn once again.
  await go(page, DEEDS, AT_PELL.tx, AT_PELL.ty)
  await warp(page, 'outdoors', at.tx, at.ty)
  await waitForWilds(page)
  await expect.poll(posts).toEqual([lamp])
  await expect.poll(drawn).toBe(1)
})
