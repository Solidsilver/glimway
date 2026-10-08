import { test } from './fixtures'
import { settled, waitForLive, warp } from './helpers'
import { freshPlayer } from './home-helpers'
import { goIn, setHour } from './room-helpers'

/**
 * Screens of every room for review (SCREENS=1; `SCREENS_TAG` prefixes the
 * names, e.g. before/after a pass), desktop and phone, into .agent/screens/.
 * Played offline: what's checked is the drawing, and before lane A2 the
 * world refuses a room's place (and rightly puts the hero back outside).
 */

const OUT = '.agent/screens'
const TAG = process.env.SCREENS_TAG ? `${process.env.SCREENS_TAG}-` : ''

const VIEWS = [
  ['in:village:bakery', 'room-kitchen', [6, 6]],
  ['in:village:mill', 'room-mill', [7, 7]],
  ['in:village:mill:2', 'room-loft', [6, 6]],
  ['in:village:library', 'room-library', [7, 6]]
] as const

for (const [device, viewport, mobile] of [['desktop', { width: 1280, height: 800 }, false], ['phone', { width: 390, height: 844 }, true]] as const) {
  test(`room screens: ${device}`, async ({ browser, baseURL }) => {
    test.skip(!process.env.SCREENS, 'screens only (SCREENS=1)')
    test.setTimeout(150_000)
    const ctx = await browser.newContext({ baseURL, viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 })
    const page = await ctx.newPage()
    await freshPlayer(page)
    // Hazel at her worktable, Finn at his stones: both rooms lived in.
    await setHour(page, { minute: 25 })
    await page.route('**/api/**', (route) => route.abort())
    await goIn(page, 'in:village:bakery', { touch: mobile })
    for (const [area, name, [tx, ty]] of VIEWS) {
      await warp(page, area, tx, ty)
      await settled(page, { area })
      await waitForLive(page)
      await page.waitForTimeout(1200)
      await page.screenshot({ path: `${OUT}/${TAG}${name}-${device}.png` })
    }
    await ctx.close()
  })
}
