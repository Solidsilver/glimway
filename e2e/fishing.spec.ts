import { expect, test, type Page } from './fixtures'
import { CONTRACT, moveServerClock, reenter, signInAgain } from './connected'
import { residentsOut } from './room-helpers'
import { freshPlayer, fund, giveInstance } from './home-helpers'
import { expectToast, openTalk, readDialogue, untilChoices, waitForLive, waitGame, warp } from './helpers'
import { CALENDAR, calendarAt } from '../src/lib/calendar.ts'
import { itemDef } from '../src/lib/items.ts'

/**
 * Fishing at the mill pond (docs/design/crafts.md 5, lane G): the banks on
 * the interactions path, Cast → Pull in → Reel → Keep or Let it go, a line
 * put back after a reload, the race open in the Quiet, and A Line in the
 * Race (5.8) end to end.
 *
 * The fishing operations are lane D's: until its routes are on the server
 * (GET /api/fishing/waters answers), the specs that cast skip, and the quest
 * spec puts the roach in the pack instead of catching it.
 */
type FishingView = { line: { id: string; bank: string; phase: string; predicted: boolean } | null; landed: string | null; bands: Record<string, string>; last: string; pose: string | null }
/** The fishing hook, or null while the World scene (which installs it) isn't up yet, e.g. just after a reload. */
const fishing = (page: Page) => page.evaluate(() => (window as unknown as { __fsFishing?: () => FishingView | null }).__fsFishing?.() ?? null)
const quests = (page: Page) => page.evaluate(() => (window as unknown as { __fsQuests: () => { quests: Record<string, string> } }).__fsQuests().quests)
type Pack = { stacks: { itemDef: string; qty: number }[]; instances: { id: string; itemDef: string; usesLeft: number }[] }
const pack = (page: Page) => page.evaluate(() => (window as unknown as { __fsItems: () => Pack | null }).__fsItems())
const reloadPack = (page: Page) => page.evaluate(() => (window as unknown as { __fsItems: { load: () => Promise<unknown> } }).__fsItems.load())
const stack = async (page: Page, def: string) => (await pack(page))?.stacks.find((s) => s.itemDef === def)?.qty ?? 0

/** What a bank's prompt reads: a band's line, or the pond's name before the first read. */
const BANK_LINE = /Little rings among the reeds|A ring now and then|Very still here|Nothing moving at all|The mill pond/

const ROD_MAX = (itemDef('willow-rod')!.uses ?? 30) * 3

/** Lane D's routes are on the server. */
async function fishingServed(page: Page): Promise<boolean> {
  return (await page.request.get('/api/fishing/waters?area=village', CONTRACT)).ok()
}

/** The rod in hand: its number key on the belt, the pack read again first. */
async function holdRod(page: Page): Promise<void> {
  const held = () => page.evaluate(() => (window as unknown as { __fsHeld: () => { kind: string; belt: string[] } }).__fsHeld())
  if (!(await held()).belt.includes('fish')) {
    await reloadPack(page)
    await expect.poll(async () => (await held()).belt, { message: 'the rod on the belt' }).toContain('fish')
  }
  if ((await held()).kind === 'fish') return
  await waitForLive(page)
  await page.keyboard.press(String((await held()).belt.indexOf('fish') + 1))
  await expect.poll(async () => (await held()).kind).toBe('fish')
}

/**
 * Both clocks to the first day from now whose mark is `mark`. The world's
 * clock moves in steps under 30 days, signing in again between them: a
 * session ends 30 days after it began however much it's used (the server's
 * seasons tests' `jumpToAs` does the same), and a mark can be two months off.
 */
async function seasonOf(page: Page, id: string, mark: string): Promise<void> {
  const DAY = 86400
  let now = await moveServerClock(page, 0)
  let t = now
  while (calendarAt(t, CALENDAR).mark !== mark) t += DAY
  while (now < t) {
    now = await moveServerClock(page, Math.min(t, now + 25 * DAY))
    if (now < t) await signInAgain(page, id)
  }
  await page.evaluate((x) => (window as unknown as { __fsDevCalendar: (t: number) => void }).__fsDevCalendar(x), t)
}

/** Cast from where the hero stands, and wait for the bite. */
async function castAndWait(page: Page): Promise<void> {
  await expect(page.locator('.prompt')).toBeVisible()
  await waitForLive(page)
  await page.keyboard.press('e')
  await expect.poll(async () => (await fishing(page))?.line?.predicted, { message: 'the server’s cast' }).toBe(false)
  await expect(page.locator('.prompt')).toContainText('Pull the line in')
  // Healthy water bites in ten seconds.
  await waitGame(page, () => fishing(page), (v) => v?.line?.phase === 'ready', { seconds: 20, message: 'the float dips' })
  await expect(page.locator('.prompt')).toContainText('Something’s on your line')
}

test.describe('fishing at the mill pond', () => {
  test('cast to Keep at the north bank, then cast and let it go', async ({ page }) => {
    test.setTimeout(150_000)
    const id = await freshPlayer(page, 'Wren')
    test.skip(!(await fishingServed(page)), 'needs lane D’s fishing routes')
    await seasonOf(page, id, 'Carting')
    const rod = giveInstance(id, 'willow-rod', { max: ROD_MAX })
    await warp(page, 'village', 36, 18)
    await holdRod(page)
    await expect(page.locator('.prompt')).toContainText(BANK_LINE)

    await castAndWait(page)
    expect((await fishing(page))!.pose).toBe('fishing')
    await waitForLive(page)
    await page.keyboard.press('e') // Reel
    await expect.poll(async () => (await fishing(page))?.landed).toBe('mill-roach')
    await page.getByRole('button', { name: /^keep/i }).click()
    await expectToast(page, /Kept: mill roach/)
    await reloadPack(page)
    await expect.poll(() => stack(page, 'mill-roach')).toBe(1)
    expect((await pack(page))!.instances.find((i) => i.id === rod)!.usesLeft).toBe(itemDef('willow-rod')!.uses! - 1)

    // Again (eight seconds after the last start), and back it goes: nothing kept, no wear.
    await page.waitForTimeout(8_500)
    await castAndWait(page)
    await waitForLive(page)
    await page.keyboard.press('e')
    await expect.poll(async () => (await fishing(page))?.landed).toBe('mill-roach')
    await page.getByRole('button', { name: /let mill roach go|let it go/i }).click()
    await expect.poll(async () => (await fishing(page))?.last).toBe('released')
    await reloadPack(page)
    expect(await stack(page, 'mill-roach')).toBe(1)
    expect((await pack(page))!.instances.find((i) => i.id === rod)!.usesLeft).toBe(itemDef('willow-rod')!.uses! - 1)
  })

  test('a reload with a line out puts the float back, and walking off the bank pulls it in', async ({ page }) => {
    test.setTimeout(120_000)
    const id = await freshPlayer(page, 'Rook')
    test.skip(!(await fishingServed(page)), 'needs lane D’s fishing routes')
    await seasonOf(page, id, 'Carting')
    giveInstance(id, 'willow-rod', { max: ROD_MAX })
    await warp(page, 'village', 39, 20)
    await holdRod(page)
    await expect(page.locator('.prompt')).toContainText(BANK_LINE)
    await waitForLive(page)
    await page.keyboard.press('e')
    await expect.poll(async () => (await fishing(page))?.line?.predicted).toBe(false)
    const cast = (await fishing(page))!.line!.id

    // A reload lands on the title: Continue back into the world.
    await reenter(page)
    await expect.poll(async () => (await fishing(page))?.line?.id, { timeout: 30_000 }).toBe(cast)
    await waitGame(page, () => fishing(page), (v) => v?.line?.phase === 'ready', { seconds: 20 })
    await expect(page.locator('.prompt')).toContainText('Something’s on your line')

    // Off the bank: the line comes in and the fish stays in the water.
    await warp(page, 'village', 30, 12)
    await expect.poll(async () => (await fishing(page))?.line ?? null).toBeNull()
  })

  test('a fish reeled in and left past the hold slips back: no buttons, nothing kept', async ({ page }) => {
    test.setTimeout(150_000)
    const id = await freshPlayer(page, 'Dace')
    test.skip(!(await fishingServed(page)), 'needs lane D’s fishing routes')
    await seasonOf(page, id, 'Carting')
    giveInstance(id, 'willow-rod', { max: ROD_MAX })
    await warp(page, 'village', 36, 18)
    await holdRod(page)
    await castAndWait(page)
    await waitForLive(page)
    await page.keyboard.press('e') // Reel
    await expect.poll(async () => (await fishing(page))?.landed).toBe('mill-roach')
    await expect(page.getByRole('button', { name: /^keep/i })).toBeVisible()
    // Eleven minutes on (the hold is ten), on both clocks.
    const later = (await moveServerClock(page, 0)) + 11 * 60
    await moveServerClock(page, later)
    await page.evaluate((x) => (window as unknown as { __fsDevCalendar: (t: number) => void }).__fsDevCalendar(x), later)
    await expect.poll(async () => (await fishing(page))?.last).toBe('lapsed')
    expect((await fishing(page))!.landed).toBeNull()
    await expect(page.getByRole('button', { name: /^keep/i })).toBeHidden()
    await expectToast(page, /slipped off the hook/)
    await reloadPack(page)
    expect(await stack(page, 'mill-roach')).toBe(0)
  })

  test('casting again within eight seconds of the last start is refused in words, and the line comes back in', async ({ page }) => {
    test.setTimeout(120_000)
    const id = await freshPlayer(page, 'Chub')
    test.skip(!(await fishingServed(page)), 'needs lane D’s fishing routes')
    await seasonOf(page, id, 'Carting')
    giveInstance(id, 'willow-rod', { max: ROD_MAX })
    await warp(page, 'village', 37, 18)
    await holdRod(page)
    await expect(page.locator('.prompt')).toContainText(BANK_LINE)
    await waitForLive(page)
    await page.keyboard.press('e') // Cast
    await expect.poll(async () => (await fishing(page))?.line?.predicted).toBe(false)
    await waitForLive(page)
    await page.keyboard.press('e') // Pull in (cancelling doesn't reset the spacing)
    await expect.poll(async () => (await fishing(page))?.line ?? null).toBeNull()
    // The Cast offer is back once the pull-in's answer is in (well inside the eight seconds).
    await expect(page.locator('.prompt')).toContainText(BANK_LINE)
    await waitForLive(page)
    await page.keyboard.press('e') // Cast again at once
    await expectToast(page, /Give the water a moment/)
    await expect.poll(async () => (await fishing(page))?.last).toBe('refused:cast-too-soon')
    expect((await fishing(page))!.line).toBeNull()
  })

  test('in the Quiet the pond is iced; the race above the wheel stays open', async ({ page }) => {
    test.setTimeout(240_000)
    const id = await freshPlayer(page, 'Tarn')
    test.skip(!(await fishingServed(page)), 'needs lane D’s fishing routes')
    await seasonOf(page, id, 'Quiet')
    giveInstance(id, 'willow-rod', { max: ROD_MAX })
    await warp(page, 'village', 36, 18)
    await holdRod(page)
    await waitForLive(page)
    // Nothing to cast from: no fishing prompt at all (the prompt may be absent altogether).
    await expect(page.locator('.prompt', { hasText: BANK_LINE })).toHaveCount(0)
    await warp(page, 'village', 32, 19)
    await castAndWait(page)
    expect((await fishing(page))!.line!.bank).toBe('race')
  })
})

/**
 * Talk at the prompt until a reply matching `offer` is there, and take it (a
 * resident's first talk is their introduction; a quest's offer follows).
 */
async function talkUntil(page: Page, prompt: RegExp, offer: RegExp): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await waitForLive(page)
    await openTalk(page, prompt)
    const choices = await untilChoices(page).catch(() => [])
    if (choices.some((c) => offer.test(c.text))) return readDialogue(page, { pick: offer })
    await readDialogue(page, { pick: /Not yet|Be on my way|Goodbye/ })
  }
  throw new Error(`no ${offer} at ${prompt}`)
}

test('A Line in the Race: Finn’s rod, a roach from the race, and Hazel’s card', async ({ page }) => {
  test.setTimeout(180_000)
  const id = await freshPlayer(page, 'Ellis')
  const served = await fishingServed(page)
  await residentsOut(page, { server: true })

  // Finn's hoist comes first while it's waiting; once it's under way he mentions the rod.
  await warp(page, 'village', 31, 23)
  await talkUntil(page, /Talk to Finn/, /look at it/)
  await expect.poll(async () => (await quests(page))['stuck-hoist']).toBe('hear-finn')
  await talkUntil(page, /Talk to Finn/, /Take the rod/)
  await expect.poll(async () => (await quests(page))['a-line-in-the-race'], { timeout: 15_000 }).toBe('hear-finn-line')
  await reloadPack(page)
  await expect.poll(async () => (await pack(page))?.instances.some((i) => i.itemDef === 'willow-rod')).toBe(true)

  // The roach: caught at the race when the server fishes, else put in the pack.
  if (served) {
    await warp(page, 'village', 32, 19)
    await holdRod(page)
    await castAndWait(page)
    await waitForLive(page)
    await page.keyboard.press('e')
    await expect.poll(async () => (await fishing(page))?.landed).toBe('mill-roach')
    await page.getByRole('button', { name: /^keep/i }).click()
  } else {
    fund(id, { items: { 'mill-roach': 1 } })
    await reloadPack(page)
  }
  await expect.poll(async () => (await quests(page))['a-line-in-the-race'], { timeout: 15_000 }).toBe('first-catch')

  // Hazel in the square takes the roach and gives the card.
  await residentsOut(page, { server: true })
  await warp(page, 'village', 13, 15)
  await talkUntil(page, /Talk to Hazel/, /Show her the roach/)
  await expect.poll(async () => (await quests(page))['a-line-in-the-race'], { timeout: 15_000 }).toBe('show-hazel')
  await reloadPack(page)
  await expect.poll(() => stack(page, 'recipe-card-millers-fry')).toBe(1)
  expect(await stack(page, 'mill-roach')).toBe(0)
})
