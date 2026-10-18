import { expect, test, type Page } from './fixtures'
import type { BrowserContext } from '@playwright/test'
import { CONTRACT, calendarOnServer, wickSlack } from './connected'
import { freshPlayer } from './home-helpers'
import { dialogueState, expectToast, openTalk, settled, untilChoices, untilLine, waitForLive, waitForWilds, warp, wilds } from './helpers'
import { goIn, setHour } from './room-helpers'
import { rumourSentence } from '../src/lib/wilds/rumour.ts'

/**
 * The reasons to go out (docs/design/open-map.md 2.10, decisions 19 to 21):
 * Elara tells this wick's rumour in the library; walking to it, the place is
 * found (first this wick: a small find, and your name on it); the bundle
 * under its landmark opens once; and someone else in the world sees who
 * found it, on the world map and when they get there.
 * SCREENS=1 saves images to .agent/screens/.
 */

const S = 24

type Rumour = { epoch: string; place: string; site: string; landmark: string; compass: string; ring: number; pastRiver: boolean; opened: boolean; current: boolean }
type Hooks = {
  __fsRumour: () => Rumour | null
  __fsMarks: () => { signs: string[]; asked: string[]; discoveries: { id: string; by: string; name: string }[]; places: { id: string; kind: string; tx: number; ty: number }[] } | null
  __fsNpcs: () => { id: string; x: number; y: number }[]
  __fsDevParkCreatures: () => number
}

async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.SCREENS) return
  await page.waitForTimeout(500)
  await page.screenshot({ path: `.agent/screens/${name}.png` })
}

const rumour = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__fsRumour())
const marks = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__fsMarks())

test('Elara tells the rumour; the place is found first and the bundle opens once; another player sees who found it', async ({ page, browser, baseURL }) => {
  test.setTimeout(300_000)
  await freshPlayer(page)
  // One wick for the whole test: a day of it ahead (moved past a turning if one is near), so setting
  // the hour (up to an hour on) never crosses one, and the find and the second player share it.
  await wickSlack(page)
  await setHour(page, { minute: 20, server: true })

  // This wick's rumour, as the server names it now. Moving the clocks re-reads the state (src/game/rumour-watch.ts):
  // wait until the game holds the same one, read since the last turning, before checking what Elara says.
  const told = (await (await page.request.get('/api/state', CONTRACT)).json()).state?.rumour as { epoch: string } | undefined
  expect(told, 'a rumour this wick').toBeTruthy()
  await expect
    .poll(async () => {
      const now = await rumour(page)
      return now?.current === true && now.epoch === told!.epoch
    }, { timeout: 15_000, message: 'the game holds this wick’s rumour' })
    .toBe(true)
  const r = (await rumour(page))!
  expect(r.opened).toBe(false)
  expect(r.site).toMatch(/^rumour:-?\d+:-?\d+$/)
  // On a wick's last day wickSlack moves past its turning, and the Turning holds play while the
  // new land loads: a warp in that hold is dropped. Wait until the Wilds hold this wick and play is back.
  await expect.poll(async () => (await wilds(page)).wickEpoch, { timeout: 15_000, message: 'the Wilds hold this wick' }).toBe(told!.epoch)
  await settled(page, { area: 'outdoors' })

  // Elara, in the library: "Heard anything from the drift?"
  await goIn(page, 'in:village:library')
  const elara = await page.evaluate(() => (window as unknown as Hooks).__fsNpcs().find((n) => n.id === 'elara'))
  expect(elara, 'Elara is in the library at :20').toBeTruthy()
  await warp(page, 'in:village:library', Math.floor(elara!.x / 16), Math.floor(elara!.y / 16) + 1)
  await openTalk(page, /Talk to Elara/)
  const choices = await untilChoices(page)
  const ask = choices.findIndex((c) => c.text === 'Heard anything from the drift?')
  expect(ask, choices.map((c) => c.text).join(' | ')).toBeGreaterThanOrEqual(0)
  await page.keyboard.press(String(ask + 1))
  const sentence = rumourSentence(r)
  await untilLine(page, /Something's tucked under/)
  expect((await dialogueState(page)).said.join(' ')).toContain(sentence)
  expect(sentence).not.toMatch(/[0-9]/)
  await page.locator('.dialogue .line').dispatchEvent('click')
  await shot(page, '96-rumour-elara-desktop')
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await dialogueState(page)).open).toBe(false)

  // Out to the find: its chunk is named by the site.
  const [, sx, sy] = /^rumour:(-?\d+):(-?\d+)$/.exec(r.site)!.map(Number)
  await warp(page, 'outdoors', sx! * S + 12, sy! * S + 12)
  await waitForWilds(page)
  const site = (await wilds(page)).sites.find((s) => (s as { id?: string }).id === r.site) as { tx: number; ty: number; cx: number; cy: number } | undefined
  expect(site, 'the bundle in its chunk').toBeTruthy()
  const bx = site!.cx * S + site!.tx
  const by = site!.cy * S + site!.ty
  await warp(page, 'outdoors', bx, by + 1)
  await waitForWilds(page)
  await page.evaluate(() => (window as unknown as Hooks).__fsDevParkCreatures())

  // Walking in finds the place (no button): first this wick, so it's yours on the map.
  await expectToast(page, /Nobody('s| has) been here/, { timeout: 20_000 })
  await expect.poll(async () => (await marks(page))?.discoveries.find((d) => d.id === r.place)?.name ?? null).toBe('Tansy')
  await shot(page, '97-rumour-found-first-desktop')

  // The bundle under the landmark opens once.
  await expect(page.locator('.prompt')).toContainText('Open the bundle', { timeout: 15_000 })
  await waitForLive(page)
  await page.keyboard.press('e')
  await expectToast(page, /Someone tucked this here for whoever came looking/)
  await expect.poll(async () => (await rumour(page))?.opened, { timeout: 15_000, message: 'the state knows you found it' }).toBe(true)
  await expect(page.locator('.prompt')).toContainText('Look at the bundle')
  await shot(page, '98-rumour-bundle-open-desktop')

  // Someone else in the world: the Map names who found it, and so does the place.
  const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json()
  const ctx: BrowserContext = await browser.newContext({ baseURL, viewport: { width: 1200, height: 760 } })
  const other = await ctx.newPage()
  try {
    await freshPlayer(other, 'Wren', invite.code)
    // Wren's screen on the world's clock (wickSlack's other pages).
    await calendarOnServer(other)
    await warp(other, 'outdoors', 12, -12)
    await waitForWilds(other)
    // The world map (M), its Details open for the list of places.
    await other.keyboard.press('m')
    await expect(other.getByTestId('world-map')).toBeVisible()
    await other.getByTestId('map-details-toggle').click()
    await expect(other.getByTestId('map-places')).toContainText('Found by Tansy', { timeout: 20_000 })
    await shot(other, '99-world-map-found-by-desktop')
    await other.keyboard.press('Escape')
    await warp(other, 'outdoors', bx, by + 1)
    await waitForWilds(other)
    await other.evaluate(() => (window as unknown as Hooks).__fsDevParkCreatures())
    await expectToast(other, 'Tansy got here first this wick.', { timeout: 20_000 })
    // The bundle is still there for Wren: everyone can open it once.
    await expect(other.locator('.prompt')).toContainText('Open the bundle', { timeout: 15_000 })
  } finally {
    await ctx.close()
  }
})
