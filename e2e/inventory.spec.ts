import { devices, type Request } from '@playwright/test'
import { JOURNAL_PAPERS } from './paper-totals'
import { expect, test, type Page } from './fixtures'
import { reenter, seedStory, sql, accountOf } from './connected'
import { claimDeed, earnGlims, freshPlayer, fund, myHome, shot } from './home-helpers'
import { SERVER_ANSWER_MS } from './helpers'

/**
 * The inventory panel (I, or the HUD's bag): tools, supplies, keepsakes,
 * home goods and papers, with quest things "for the road" and a per-device
 * "new" dot. Reads today's data only (the pack, server counts, your home).
 */

/** Give the account goods on the server, then reload and Continue. */
async function seedPack(page: Page, id: string, extra: { materials?: Record<string, number>; items?: Record<string, number>; questItems?: string[] }): Promise<void> {
  if (extra.materials || extra.items) fund(id, { materials: extra.materials, items: extra.items })
  if (extra.questItems) await seedStory(id, { questItems: extra.questItems })
  await reenter(page)
}

/** Home and lane reads in flight on a page, from when this is called (`idle` waits for them all to answer). */
function homeReads(page: Page): { idle: () => Promise<void> } {
  const reads = new Set<Request>()
  const isRead = (r: Request) => r.method() === 'GET' && /^\/api\/(homestead\/gate\/\d+|commons)$/.test(new URL(r.url()).pathname)
  page.on('request', (r) => {
    if (isRead(r)) reads.add(r)
  })
  page.on('requestfinished', (r) => reads.delete(r))
  page.on('requestfailed', (r) => reads.delete(r))
  return { idle: () => expect.poll(() => reads.size, { timeout: SERVER_ANSWER_MS, message: 'the home reads in flight have answered' }).toBe(0) }
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Inventory' })
const tab = (page: Page, name: RegExp) => dialog(page).getByRole('tab', { name })

test.describe('the pack', () => {
  test('I opens the inventory; every tab shows what you carry, and the new dot clears', async ({ page }) => {
    const id = await freshPlayer(page)
    await seedPack(page, id, { materials: { timber: 4, amber: 1 }, items: { 'lamp-wick': 1, 'ember-charm': 1, 'whittled-fox': 1 }, questItems: ['lantern-route-rubbing'] })

    // Unseen things put a dot on the bag.
    const bag = page.getByTestId('inventory-button')
    await expect(bag).toHaveAccessibleName(/Inventory \(I\), \d+ new/)

    await page.keyboard.press('i')
    await expect(dialog(page)).toBeVisible()

    // Opens on everything carried; Tools shows the road's things.
    await expect(tab(page, /All/)).toHaveAttribute('aria-selected', 'true')
    await tab(page, /Tools/).click()
    const tools = dialog(page).getByTestId('inv-page-tools')
    await expect(tools.getByText('No tools yet.')).toBeVisible()
    await expect(tools.getByRole('heading', { name: 'For the road' })).toBeVisible()
    await expect(tools.getByText('Wenna’s Naming, Copied Out')).toBeVisible()
    await shot(page, 'inventory-tools-desktop')

    // Arrow keys walk the tabs.
    await tab(page, /Tools/).focus()
    await page.keyboard.press('ArrowRight')
    await expect(tab(page, /Supplies/)).toHaveAttribute('aria-selected', 'true')
    const supplies = dialog(page).getByTestId('inv-page-supplies')
    await expect(supplies.getByTestId('material-timber')).toHaveText('4')
    await expect(supplies.getByTestId('material-amber')).toHaveText('1')
    await expect(supplies.getByTestId('material-stone')).toHaveCount(0)
    await expect(supplies.getByText('Lamp wick')).toBeVisible()
    await expect(supplies.locator('.badge').first()).toBeVisible()
    await shot(page, 'inventory-supplies-desktop')

    await page.keyboard.press('ArrowRight')
    const keep = dialog(page).getByTestId('inv-page-keepsakes')
    await expect(keep.locator('[data-cell]').first()).toContainText('Ember Charm')
    await expect(keep.getByText('Whittled fox')).toBeVisible()
    await shot(page, 'inventory-keepsakes-desktop')

    await page.keyboard.press('ArrowRight')
    await expect(dialog(page).getByTestId('inv-page-home')).toContainText('Silas sells furniture')

    await page.keyboard.press('End')
    const papers = dialog(page).getByTestId('inv-page-papers')
    await expect(papers).toContainText('Also in your Journal')
    await expect(papers).toContainText(`of ${JOURNAL_PAPERS} found`)

    // I closes it; everything has been seen, so the dot is gone.
    await page.keyboard.press('i')
    await expect(dialog(page)).toBeHidden()
    await expect(bag).toHaveAccessibleName('Inventory (I)')

    // The HUD button opens it too; the seen list survives a reload.
    await reenter(page)
    await expect(bag).toHaveAccessibleName('Inventory (I)')
    await bag.click()
    await expect(dialog(page)).toBeVisible()
    await expect(tab(page, /All/)).toHaveAttribute('aria-selected', 'true')
    await expect(dialog(page).locator('.badge')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toBeHidden()
  })

  test('the grid walks with the arrow keys; Enter opens a card, Escape closes it, then the bag', async ({ page }) => {
    const id = await freshPlayer(page)
    await seedPack(page, id, { materials: { timber: 4, amber: 1 }, items: { 'lamp-wick': 1, 'whittled-fox': 1 } })
    await page.keyboard.press('i')
    await expect(dialog(page)).toBeVisible()
    const cells = dialog(page).locator('.grid:not(.road) [data-cell]')
    await cells.first().focus()
    await page.keyboard.press('ArrowRight')
    await expect(cells.nth(1)).toBeFocused()
    const key = await cells.nth(1).getAttribute('data-cell')
    await page.keyboard.press('Enter')
    await expect(dialog(page).locator(`[data-item="${key}"]`)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog(page).locator('[data-item]')).toHaveCount(0)
    // Focus goes back to the icon that opened the card.
    await expect(cells.nth(1)).toBeFocused()
    await expect(dialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toBeHidden()
  })

  test('Tab stays in the bag, and closing a card with its ✕ puts focus back on the icon', async ({ page }) => {
    const id = await freshPlayer(page)
    await seedPack(page, id, { materials: { timber: 4, amber: 1 }, items: { 'lamp-wick': 1, 'whittled-fox': 1 } })
    await page.keyboard.press('i')
    await expect(dialog(page)).toBeVisible()
    const inFlightApi = new Set<string>()
    const apiRequests = new Map<object, string>()
    page.on('request', (request) => {
      if (!request.url().includes('/api/')) return
      apiRequests.set(request, request.url())
      inFlightApi.add(request.url())
    })
    const settleRequest = (request: object) => {
      const url = apiRequests.get(request)
      if (!url) return
      apiRequests.delete(request)
      if (![...apiRequests.values()].includes(url)) inFlightApi.delete(url)
    }
    page.on('requestfinished', settleRequest)
    page.on('requestfailed', settleRequest)
    await page.evaluate(() => {
      const trace: string[] = []
      let lastFocused: Element | null = document.activeElement
      const describe = (el: Element | null) => el ? `${el.tagName.toLowerCase()}#${el.id}.${String(el.className).replace(/\s+/g, '.')}` : '(none)'
      document.addEventListener('focusin', (event) => { lastFocused = event.target instanceof Element ? event.target : null }, true)
      const observer = new MutationObserver((records) => {
        for (const record of records) for (const node of record.removedNodes) {
          if (!(node instanceof Element)) continue
          if (lastFocused && (node === lastFocused || node.contains(lastFocused))) trace.push(`removed focused ${describe(lastFocused)} with ${describe(node)}`)
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      ;(window as unknown as { __inventoryFocusTrace: { rows: string[]; stop: () => void } }).__inventoryFocusTrace = { rows: trace, stop: () => observer.disconnect() }
    })
    const focusSnapshot = () => page.evaluate(() => {
      const active = document.activeElement
      const dialog = active?.closest('[role="dialog"]')
      return {
        active: active ? `${active.tagName.toLowerCase()}#${active.id}.${String(active.className).replace(/\s+/g, '.')}` : '(none)',
        insideDialog: !!dialog,
        dialog: dialog?.getAttribute('aria-label') ?? dialog?.getAttribute('aria-labelledby') ?? null,
        owner: dialog?.closest('[data-panel]')?.getAttribute('data-panel') ?? null,
        removed: (window as unknown as { __inventoryFocusTrace: { rows: string[] } }).__inventoryFocusTrace.rows.slice(-8)
      }
    })
    // Round the whole bag twice, both ways: never out to the HUD or the page.
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab')
      const sample = await focusSnapshot()
      expect(sample.insideDialog, `Tab ${i + 1} stays in the bag; focus=${JSON.stringify(sample)}; in-flight API reads=${JSON.stringify([...inFlightApi])}`).toBe(true)
    }
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Shift+Tab')
      const sample = await focusSnapshot()
      expect(sample.insideDialog, `Shift+Tab ${i + 1} stays in the bag; focus=${JSON.stringify(sample)}; in-flight API reads=${JSON.stringify([...inFlightApi])}`).toBe(true)
    }
    await page.evaluate(() => (window as unknown as { __inventoryFocusTrace: { stop: () => void } }).__inventoryFocusTrace.stop())
    const fox = dialog(page).locator('[data-cell="item:whittled-fox"]')
    await fox.click()
    await expect(dialog(page).locator('[data-item="item:whittled-fox"]')).toBeVisible()
    await dialog(page).getByRole('button', { name: 'Close the card' }).click()
    await expect(dialog(page).locator('[data-item]')).toHaveCount(0)
    await expect(fox).toBeFocused()
    // A cell's name says what it is and how it stands.
    await expect(dialog(page).locator('[data-cell="material:timber"]')).toHaveAccessibleName(/^Timber, 4/)
  })

  test('the Character panel points to the inventory', async ({ page }) => {
    await freshPlayer(page)
    await page.keyboard.press('c')
    const sheet = page.locator('[aria-labelledby="char-title"]')
    await expect(sheet).toContainText('Your pack, materials and keepsakes are in the Inventory.')
    await expect(sheet.getByRole('heading', { name: 'Pack' })).toHaveCount(0)
    await sheet.getByTestId('open-inventory').click()
    await expect(dialog(page)).toBeVisible()
    await expect(sheet).toBeHidden()
  })
})

test.describe('touch', () => {
  // The phone's screen and touch, without its browser type (set per file only).
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['iPhone 13']
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent })

  test('on a phone the bag button opens the inventory and the tabs fit', async ({ page }) => {
    const id = await freshPlayer(page)
    await seedPack(page, id, { materials: { fiber: 3 }, items: { 'tin-whistle': 1 } })
    await page.getByTestId('inventory-button').tap()
    await expect(dialog(page)).toBeVisible()
    await tab(page, /Supplies/).tap()
    await expect(dialog(page).getByTestId('material-fiber')).toHaveText('3')
    await tab(page, /Keepsakes/).tap()
    await expect(dialog(page).getByText('Tin whistle')).toBeVisible()
    // Nothing spills off the side of the screen.
    const vw = page.viewportSize()!.width
    const box = (await dialog(page).locator('.panel').boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(vw)
    await dialog(page).getByRole('button', { name: 'Close the inventory' }).tap()
    await expect(dialog(page)).toBeHidden()
    await page.getByRole('button', { name: /^Menu/ }).tap()
    await expect(page.getByTestId('controls-touch')).toContainText('The bag button')
  })
})

test.describe('in a world', () => {
  test('in a world the inventory shows server counts and your home goods, placed and stored', { tag: '@smoke' }, async ({ page }) => {
    // The smoke tier's longest test, on GitHub's software-rendered runner:
    // 52 s, 66 s and 90 s on dev's last three runs, then past the 120 s
    // limit on exp/fights-full with every smoke test slower by the same
    // measure (CI run 38309211790). The ceiling is the runner's, not the
    // test's; the GPU runner does it in 16 s.
    if (process.env.CI) test.setTimeout(240_000)
    const reads = homeReads(page)
    const id = await freshPlayer(page)
    // Homesteads v2: a home is a deed you claim from Silas.
    await earnGlims(page, id)
    await claimDeed(page)
    const plot = await myHome(page, id)
    expect(plot).toBeTruthy()
    fund(id, { materials: { timber: 12, stone: 3 }, items: { 'river-glass-bead': 2, 'wooden-peg': 5 } })
    // Two stools (one set out, one put away in your pack) and a fern put away.
    const home = `(SELECT homestead_id FROM homestead_members WHERE account_id='${accountOf(id)}')`
    sql(
      `INSERT INTO homestead_items(id,item_def,location,homestead_id,scene,x,y,rotation) VALUES('inv-a','wooden-stool','placed',${home},'outdoor',1,1,0);` +
        `INSERT INTO homestead_items(id,item_def,location,account_id) VALUES('inv-b','wooden-stool','inventory','${accountOf(id)}'),('inv-c','potted-fern','inventory','${accountOf(id)}');`
    )
    // The home reads made before the seed (claiming, the lane) answer with
    // the home as it was: let them all land, then read it afresh. The SQL
    // seed publishes nothing, and a load joins one already in flight
    // (review 2026-10-11, game F4 / server 5): the Home view's own fresh
    // read (`__fsHomes.fresh()`), asked now and never joined to one before.
    await reads.idle()
    const held = () => page.evaluate(() => ((window as unknown as { __fsHomes: () => { mine: { items: { id: string }[] } | null } }).__fsHomes().mine?.items ?? []).map((i) => i.id).sort())
    await page.evaluate(() => (window as unknown as { __fsHomes: { fresh: () => Promise<unknown> } }).__fsHomes.fresh())
    await expect.poll(held, { message: 'the game holds the fresh home' }).toEqual(expect.arrayContaining(['inv-a', 'inv-b', 'inv-c']))
    await page.keyboard.press('i')
    await expect(dialog(page)).toBeVisible()
    await expect.poll(held, { message: 'the game holds the fresh home' }).toEqual(expect.arrayContaining(['inv-a', 'inv-b', 'inv-c']))
    await tab(page, /Supplies/).click()
    const supplies = dialog(page).getByTestId('inv-page-supplies')
    await expect(supplies.getByTestId('material-timber')).toHaveText('12')
    await expect(supplies.getByTestId('material-stone')).toHaveText('3')
    await expect(supplies.getByTestId('qty-item:wooden-peg')).toHaveText('5')

    await tab(page, /Keepsakes/).click()
    await expect(dialog(page).getByTestId('qty-item:river-glass-bead')).toHaveText('2')
    // Hovering shows what a thing is; what you can do with it comes with a click.
    const bead = dialog(page).locator('[data-cell="item:river-glass-bead"]')
    await bead.hover()
    const beadCard = dialog(page).locator('[data-item="item:river-glass-bead"]')
    await expect(beadCard).toBeVisible()
    await expect(beadCard.locator('[data-act]')).toHaveCount(0)
    await bead.click()
    await expect(beadCard.locator('[data-act="pocket"]')).toBeVisible()
    await page.keyboard.press('Escape')

    await tab(page, /Home/).click()
    const goods = dialog(page).getByTestId('inv-page-home')
    // Pick an icon: its card says where the pieces are.
    await goods.locator('[data-cell="decoration:wooden-stool"]').click()
    const stool = goods.locator('[data-item="decoration:wooden-stool"]')
    await expect(stool).toContainText('Wooden stool')
    await expect(stool).toContainText('1 set out · 1 put away')
    await goods.locator('[data-cell="decoration:potted-fern"]').click()
    await expect(goods.locator('[data-item="decoration:potted-fern"]')).toContainText('1 put away')
    await shot(page, 'inventory-home-desktop')

    await tab(page, /Tools/).click()
    await expect(dialog(page).getByTestId('inv-page-tools')).toContainText('No tools yet.')
    await expect(dialog(page).getByTestId('inv-page-tools')).toContainText('Field Journal')
    await tab(page, /Papers/).click()
    await expect(dialog(page).getByTestId('inv-page-papers')).toContainText(`of ${JOURNAL_PAPERS} found`)
  })
})
