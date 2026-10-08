import { expect, test, type Page } from './fixtures'
import {
  dialogueState,
  expectToast,
  openTalk,
  readDialogue,
  untilChoices,
  waitForLive,
  warp
} from './helpers'
import { freshPlayer, fund } from './home-helpers'
import { serverState, sql, accountOf } from './connected'


/**
 * Heirloom tools story beats (BRIEF.md & BRIEF-FIXES.md):
 *  - Orrin gives Orrin's mason pick once the north bridge is mended.
 *  - Silas brings out the Brack felling axe once Hollis's name is known.
 *  - Ada gives her garden spade after three gifts of hearth oil.
 */

async function packHolds(page: Page, def: string): Promise<void> {
  await page.keyboard.press('i')
  await expect(page.getByRole('dialog', { name: 'Inventory' })).toBeVisible()
  await expect
    .poll(async () =>
      page.evaluate((d) => (window as unknown as { __fsItems?: () => { stacks?: { itemDef: string }[] } | null }).__fsItems?.()?.stacks.some((s) => s.itemDef === d), def)
    )
    .toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Inventory' })).toBeHidden()
}

test.describe('heirloom story beats', () => {
  test('Orrin gives his mason pick once the north bridge is mended', async ({ page }) => {
    const id = await freshPlayer(page, 'OrrinTester')

    // Complete the north bridge in the authoritative projects table
    sql(`INSERT INTO projects(world_id, project_def, completed_at, world_flag)
         SELECT world_id, 'north-bridge', 123456, 'project:north-bridge:complete'
         FROM players WHERE account_id='${accountOf(id)}'
         ON CONFLICT(world_id, project_def) DO UPDATE SET completed_at=123456, world_flag='project:north-bridge:complete';`)

    // Load projects into the client village model so hasWorldFlag matches
    await page.evaluate(async () => {
      await (window as unknown as { __fsVillage?: () => { loadProjects?: () => Promise<void> } }).__fsVillage?.().loadProjects?.()
    })

    // Stand by Orrin in Village (tx: 21, ty: 10)
    await warp(page, 'village', 21, 10)
    await expect(page.locator('.prompt')).toContainText('Talk to Orrin')
    await waitForLive(page)

    // Open conversation
    await openTalk(page, 'Talk to Orrin')
    const state = await dialogueState(page)
    expect(state.speaker).toBe('Orrin')

    // Read lines and check choices include the pick and "Not yet"
    const choices = await untilChoices(page)
    expect(choices.some((c) => /Take Orrin’s mason pick/i.test(c.text))).toBe(true)
    expect(choices.some((c) => /Not yet/i.test(c.text))).toBe(true)

    await readDialogue(page, { pick: /Take Orrin’s mason pick/i })
    await expectToast(page, 'Orrin gave you his mason pick.')

    await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('heirloom:orrins-mason-pick')
    await expect.poll(async () =>
      page.evaluate(() => (window as unknown as { __fsItems?: () => { instances?: { itemDef: string }[] } | null }).__fsItems?.()?.instances?.some((i) => i.itemDef === 'orrins-mason-pick'))
    ).toBe(true)
  })

  test('Silas gives the Brack felling axe once Hollis’s name is known', async ({ page }) => {
    const id = await freshPlayer(page, 'SilasTester')

    // Authoritative ledger / progress paper flag
    sql(`UPDATE progress SET doc_json = json_insert(doc_json, '$.flags[#]', 'paper:ashwatch-ledger-excerpts') WHERE account_id='${accountOf(id)}';`)

    // Mirror flag to client session
    await page.evaluate(() => {
      ;(window as unknown as { __fsDevAddFlag?: (f: string) => void }).__fsDevAddFlag?.('paper:ashwatch-ledger-excerpts')
    })

    // Stand by Silas in Commons (tx: 51, ty: 22)
    await warp(page, 'commons', 51, 22)
    await expect(page.locator('.prompt')).toContainText('Talk to Silas')
    await waitForLive(page)

    // Open conversation
    await openTalk(page, 'Talk to Silas')
    const state = await dialogueState(page)
    expect(state.speaker).toBe('Silas')

    // Read lines and check choices include the axe and "Not yet"
    const choices = await untilChoices(page)
    expect(choices.some((c) => /Take the Brack felling axe/i.test(c.text))).toBe(true)
    expect(choices.some((c) => /Not yet/i.test(c.text))).toBe(true)

    await readDialogue(page, { pick: /Take the Brack felling axe/i })
    await expectToast(page, 'Silas gave you the Brack felling axe.')

    await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('heirloom:brack-felling-axe')
    await expect.poll(async () =>
      page.evaluate(() => (window as unknown as { __fsItems?: () => { instances?: { itemDef: string }[] } | null }).__fsItems?.()?.instances?.some((i) => i.itemDef === 'brack-felling-axe'))
    ).toBe(true)
  })

  test('Ada gives her garden spade after three gifts of hearth oil', async ({ page }) => {
    const id = await freshPlayer(page, 'AdaTester')

    // Give 3 flasks of hearth oil
    fund(id, { items: { 'hearth-oil': 3 } })
    await packHolds(page, 'hearth-oil')

    // Stand by Ada in Village (tx: 36, ty: 8)
    await warp(page, 'village', 36, 8)
    await expect(page.locator('.prompt')).toContainText('Talk to Ada')
    await waitForLive(page)

    // Gift 1
    await openTalk(page, 'Talk to Ada')
    let choices = await untilChoices(page)
    expect(choices.some((c) => /Give hearth oil for the window/i.test(c.text))).toBe(true)
    expect(choices.some((c) => /Not yet/i.test(c.text))).toBe(true)
    await readDialogue(page, { pick: /Give hearth oil for the window/i })
    await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('ada-oil-gifts:1')
    await expect.poll(async () => (await dialogueState(page)).seen.some((x) => /Good oil|gutter/i.test(x.text))).toBe(true)
    if ((await dialogueState(page)).open) await readDialogue(page)
    await waitForLive(page)

    // Gift 2
    await openTalk(page, 'Talk to Ada')
    choices = await untilChoices(page)
    expect(choices.some((c) => /Give hearth oil for the window/i.test(c.text))).toBe(true)
    expect(choices.some((c) => /Not yet/i.test(c.text))).toBe(true)
    await readDialogue(page, { pick: /Give hearth oil for the window/i })
    await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('ada-oil-gifts:2')
    await expect.poll(async () => (await dialogueState(page)).seen.some((x) => /For the window/i.test(x.text))).toBe(true)
    if ((await dialogueState(page)).open) await readDialogue(page)
    await waitForLive(page)

    // Gift 3 -> Ada offers the spade
    await openTalk(page, 'Talk to Ada')
    choices = await untilChoices(page)
    expect(choices.some((c) => /Give hearth oil for the window/i.test(c.text))).toBe(true)
    expect(choices.some((c) => /Not yet/i.test(c.text))).toBe(true)
    const oilChoice = choices.findIndex((c) => /Give hearth oil for the window/i.test(c.text))
    await page.keyboard.press(String(oilChoice + 1))
    await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('ada-oil-gifts:3')

    // Spade offer dialog opens directly
    await expect.poll(async () => (await dialogueState(page)).open, { timeout: 15000 }).toBe(true)
    const spadeChoices = await untilChoices(page)
    expect(spadeChoices.some((c) => /Take Ada’s garden spade/i.test(c.text))).toBe(true)
    expect(spadeChoices.some((c) => /Not yet/i.test(c.text))).toBe(true)
    await readDialogue(page, { pick: /Take Ada’s garden spade/i })
    await expectToast(page, 'Ada gave you her garden spade.')

    await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('heirloom:ada-garden-spade')
    await expect.poll(async () =>
      page.evaluate(() => (window as unknown as { __fsItems?: () => { instances?: { itemDef: string }[] } | null }).__fsItems?.()?.instances?.some((i) => i.itemDef === 'ada-garden-spade'))
    ).toBe(true)
  })
})
