import { mkdirSync } from 'node:fs'
import { test } from './fixtures'
import { freshPlayer } from './home-helpers'
import { warp } from './helpers'

/**
 * The Commons photographed at fixed spots for a look check (location-seam.md
 * 6, lane S2: the served Commons against the one the client used to build).
 * One moment on the game clock (a plain day of the Bud wick, ten past the
 * hour: Silas out by his sawhorse), reduced motion, creatures parked, only
 * the canvas shown. LOOK=<label> writes .agent/screens/commons-look/<label>/;
 * compare two labels with scripts/png-diff.ts. LOOK only.
 */
test.skip(!process.env.LOOK, 'look check only (LOOK=<label>)')

const AT = 1791000600
const SPOTS: { name: string; tx: number; ty: number }[] = [
  { name: 'arch', tx: 23, ty: 4 },
  { name: 'square', tx: 23, ty: 19 },
  { name: 'gate', tx: 4, ty: 20 },
  { name: 'gates-north', tx: 23, ty: 11 },
  { name: 'gates-south', tx: 23, ty: 31 },
  { name: 'yard', tx: 50, ty: 21 },
  { name: 'woods-west', tx: 8, ty: 33 },
  { name: 'woods-east', tx: 38, ty: 8 }
]

for (const [vp, size] of [['desktop', { width: 1200, height: 760 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`the Commons at fixed spots (${vp})`, async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize(size)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await freshPlayer(page)
    await page.evaluate((t) => (window as unknown as { __fsDevCalendar: (t: number) => void }).__fsDevCalendar(t), AT)
    await page.addStyleTag({ content: '* { visibility: hidden !important } canvas { visibility: visible !important }' })
    const dir = `.agent/screens/commons-look/${process.env.LOOK}`
    mkdirSync(dir, { recursive: true })
    for (const s of SPOTS) {
      await warp(page, 'commons', s.tx, s.ty)
      await page.evaluate(() => (window as unknown as { __fsDevParkCreatures: () => void }).__fsDevParkCreatures())
      await page.waitForTimeout(2000)
      await page.locator('canvas').first().screenshot({ path: `${dir}/${s.name}-${vp}.png` })
    }
  })
}
