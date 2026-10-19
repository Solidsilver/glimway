import { randomUUID } from 'node:crypto'
import type { Locator, Request } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { accountOf, moveServerClock, pinWorld, reenter, seedMarks, serverState, sql, wickSlack } from './connected'
import { AT_PELL, DEEDS, freshPlayer, fund, go, homes, pellSays, readOn, seedDeed, shot, talk } from './home-helpers'
import { SERVER_ANSWER_MS, expectToast, frames, parkCreatures, player, spotsAround, standFor, waitForLive, waitForWilds, warp, windowWhole } from './helpers'
import { LAMP_NAMING } from '../src/content/lamp-naming.ts'
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
  // About 50 s on the CI runner; a stall fails in minutes, not five (T5).
  test.setTimeout(150_000)
  const id = await freshPlayer(page, 'Wren')
  await wickSlack(page)
  await pinWorld(page, SEED)
  // A deed on record (buying one is homestead.spec.ts's): the reenter below reads it.
  await seedDeed(page, id)
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
  test.setTimeout(150_000)
  const id = await freshPlayer(page, 'Wren')
  await wickSlack(page)
  await pinWorld(page, SEED)
  await seedDeed(page, id)
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

/**
 * Take from Pell's crate with a quick second press (step-back 2026-10-18,
 * U2, A4): the first answer is in and the crate is being read again. What
 * was taken has already left the list and the buttons wait for that read,
 * so the second press can't come back "Nothing waiting for you" with rows
 * still listed. The re-read is held here to keep that window open.
 */
async function takeTwice(page: Page, crate: Locator, button: Locator, row: number | null): Promise<void> {
  let release!: () => void
  const reread = new Promise<void>((resolve) => (release = resolve))
  let collects = 0
  const count = (r: Request) => {
    if (r.method() === 'POST' && r.url().includes('/api/recovery/collect')) collects++
  }
  page.on('request', count)
  const held: Promise<void>[] = []
  await page.route('**/api/recovery', (route) => {
    const done = reread.then(() => route.continue())
    held.push(done)
    return done
  })
  try {
    const answered = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/api/recovery/collect'))
    await button.dblclick()
    await answered
    if (row !== null) await expect(crate.locator(`[data-crate-row="${row}"]`), 'what was taken leaves the list as the answer lands').toHaveCount(0)
    // The quick second press, if anything is still there to press.
    if (await button.count()) await button.click({ force: true, timeout: 2_000 }).catch(() => {})
    const takeAll = crate.locator('[data-take-all]')
    if (await takeAll.count()) await expect(takeAll, 'the buttons wait for the crate to be read again').toBeDisabled()
  } finally {
    release()
    // Every held read goes on before the route is taken away (one let go after it is "already handled").
    await Promise.allSettled(held)
    await page.unroute('**/api/recovery')
  }
  await expect(crate.getByTestId('crate-message')).toContainText(/Signed out to you: /)
  await expect(crate.getByTestId('crate-message')).not.toContainText('Nothing waiting')
  page.off('request', count)
  expect(collects, 'one take sent').toBe(1)
}

test('a quick double Take at Pell’s crate takes once: a piece, a plant as its seed, then everything', async ({ page }) => {
  test.setTimeout(120_000)
  const id = await freshPlayer(page, 'Wren')
  await seedDeed(page, id)
  const account = accountOf(id)
  const world = (await serverState(page)).body.worldId as string
  const crateId = randomUUID(), stool = randomUUID(), plant = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  sql(`INSERT INTO recovery_crates(id,world_id,source,cx,cy,lapsed_at) VALUES('${crateId}','${world}','camp:${crateId}',2,-4,${now});
INSERT INTO homestead_items(id,item_def,location,account_id) VALUES('${stool}','wooden-stool','crate','${account}');
INSERT INTO recovery_entries(crate_id,account_id,kind,item_def,qty,instance_id) VALUES('${crateId}','${account}','piece','wooden-stool',1,'${stool}');
INSERT INTO recovery_entries(crate_id,account_id,kind,item_def,qty,state) VALUES('${crateId}','${account}','plant','birch-sapling',1,'{"id":"${plant}","plantedAt":${now}}');
INSERT INTO recovery_entries(crate_id,account_id,kind,item_def,qty) VALUES('${crateId}','${account}','stack','hearth-oil',2);`)
  const entry = (kind: string) => Number(sql(`SELECT id FROM recovery_entries WHERE crate_id='${crateId}' AND kind='${kind}';`))
  const piece = entry('piece'), seed = entry('plant')

  await pellSays(page, /Choose what to take/)
  const crate = page.getByRole('dialog', { name: 'Pell’s crate' })
  await expect(crate.locator('[data-crate-row]')).toHaveCount(3)

  await takeTwice(page, crate, crate.locator(`[data-take="${piece}"]`), piece)
  await expect(crate.getByTestId('crate-message')).toContainText('a wooden stool')
  expect(sql(`SELECT location FROM homestead_items WHERE id='${stool}';`)).toBe('inventory')

  // A plant taken as its seed: into the pack as a seed, not carried whole.
  await takeTwice(page, crate, crate.locator(`[data-take-seed="${seed}"]`), seed)
  expect(sql(`SELECT coalesce(sum(qty),0) FROM item_stacks WHERE location='pack' AND owner='${account}' AND item_def='birch-sapling';`)).toBe('1')
  expect(sql(`SELECT count(*) FROM carried_plants WHERE account_id='${account}';`)).toBe('0')

  // Take everything: the oil, once.
  await takeTwice(page, crate, crate.locator('[data-take-all]'), null)
  await expect(crate.locator('[data-crate-empty]')).toBeVisible()
  expect(sql(`SELECT coalesce(sum(qty),0) FROM item_stacks WHERE location='pack' AND owner='${account}' AND item_def='hearth-oil';`)).toBe('2')
  expect(sql(`SELECT count(*) FROM recovery_entries WHERE account_id='${account}' AND collected_at IS NULL;`)).toBe('0')
})

/** A Keeper's way-lamp set out in the Wilds, a stool still in the pack: the lamp and where it stands. */
async function keepersLamp(page: Page): Promise<{ lamp: string; set: Camp }> {
  const id = await freshPlayer(page, 'Wren')
  await wickSlack(page)
  await pinWorld(page, SEED)
  await seedDeed(page, id)
  seedMarks(id, 'keeper:hand')
  // Setting a way-lamp out burns its first oil.
  fund(id, { items: { 'hearth-oil': 1 } })
  await reenter(page)
  const lamp = randomUUID(), stool = randomUUID()
  sql(`INSERT INTO homestead_items(id,item_def,location,account_id) VALUES('${lamp}','way-lamp','inventory','${accountOf(id)}'),('${stool}','wooden-stool','inventory','${accountOf(id)}');`)
  await page.evaluate(() => (window as unknown as Hooks).__fsHomes.fresh())
  await expect.poll(async () => (await homes(page)).mine?.items?.length ?? 0).toBeGreaterThanOrEqual(2)
  await standInTheWilds(page)
  await (await homeCard(page, 'way-lamp')).locator('[data-act="set-lamp"]').click()
  await expect.poll(async () => (await camps(page))?.camps.find((c) => c.id === lamp)?.oil ?? null).toBe(1)
  await expect(page.getByRole('dialog', { name: 'Inventory' })).toBeHidden()
  return { lamp, set: (await camps(page))!.camps.find((c) => c.id === lamp)! }
}

/** Beside the lamp, its naming open (a Keeper's choice in its talk). */
async function openNaming(page: Page, lamp: string, set: Camp): Promise<Locator> {
  const why: string[] = []
  if (!(await standFor(page, `wilds:camp:${lamp}`, await spotsAround(page, { tx: set.x, ty: set.y }), why)))
    throw new Error(`no spot elects the way-lamp at ${set.x},${set.y} (seed ${SEED}): ${why.join(' ')}`)
  await talk(page, /Look at the way-lamp/, /Give it a naming/)
  const naming = page.getByTestId('lamp-naming')
  await expect(naming).toBeVisible()
  return naming
}

test('the bag’s camp buttons follow you into the camp, and the lamp naming holds I, J and C', async ({ page }) => {
  test.setTimeout(150_000)
  const { lamp, set } = await keepersLamp(page)
  const bag = page.getByRole('dialog', { name: 'Inventory' })

  // The bag (step-back U6): standing in the camp, with the save's copy of
  // the hero's place still outside it (the once-a-second sample hasn't run),
  // the bag reads where you stand as it opens and offers the camp's buttons.
  const hero = await player(page)
  await page.evaluate(([x, y]) => (window as unknown as { __fsDevStalePosition: (x: number, y: number) => void }).__fsDevStalePosition(x, y), [hero.x - 20 * 16, hero.y] as const)
  const stoolCard = await homeCard(page, 'wooden-stool')
  await expect(stoolCard.locator('[data-act="set-out"]')).toBeVisible()
  await page.keyboard.press('i')
  await expect(bag).toBeHidden()

  // The naming (step-back U1): its selects keep no letters, so I, J and C
  // open nothing beneath it. (It is left open: closing it is the next test.)
  const naming = await openNaming(page, lamp, set)
  const dialogs = page.getByRole('dialog')
  for (const key of ['i', 'j', 'c']) {
    await page.keyboard.press(key)
    // Nothing observable marks a panel that didn't open: let the press be handled, then look.
    await frames(page, 10)
    await expect(naming, `after ${key}`).toBeVisible()
    await expect(dialogs, `after ${key}: only the naming is up`).toHaveCount(1)
  }
})

// A10: closing the naming used to throw (App.svelte read its cleared ask;
// CI 39173736738), so neither a cancel nor a naming was ever sent.
test('Escape cancels the lamp naming and opens nothing', async ({ page }) => {
  test.setTimeout(150_000)
  const { lamp, set } = await keepersLamp(page)
  const naming = await openNaming(page, lamp, set)
  await page.keyboard.press('Escape')
  await expect(naming).toBeHidden()
  await frames(page, 10)
  await expect(page.getByRole('dialog'), 'Escape cancelled the naming and opened nothing').toHaveCount(0)
  await waitForLive(page)
  expect(sql(`SELECT count(*) FROM lamp_namings WHERE lamp_id='${lamp}';`), 'a cancel names nothing').toBe('0')
})

test('a Keeper names their way-lamp through the panel: the server has it, the lamp answers to it', async ({ page }) => {
  test.setTimeout(150_000)
  const { lamp, set } = await keepersLamp(page)
  const naming = await openNaming(page, lamp, set)
  const short = ((await naming.getByTestId('naming-preview').locator('.short').textContent()) ?? '').replace(/^Short name:\s*/, '').trim()
  expect(short, 'the panel previews a short name').not.toBe('')
  await naming.getByTestId('naming-submit').click()
  await expect(naming).toBeHidden()
  await expectToast(page, LAMP_NAMING.named)
  await expect.poll(() => sql(`SELECT short_name FROM lamp_namings WHERE lamp_id='${lamp}';`), { timeout: SERVER_ANSWER_MS }).toBe(short)
  // Its first naming gives its Keeper one lamp ash; the lamp's look goes by its name.
  const namer = sql(`SELECT namer FROM lamp_namings WHERE lamp_id='${lamp}';`)
  expect(sql(`SELECT coalesce(sum(qty),0) FROM item_stacks WHERE location='pack' AND owner='${namer}' AND item_def='lamp-ash';`)).toBe('1')
  await expect(page.locator('.prompt')).toContainText(`Look at ${short}`)
})
