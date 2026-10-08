import { expect, test } from './fixtures'
import { TOKEN, allow, newUser, routeHabitica, setHabitica } from './connected'

for (const [name, vp] of [['desktop', { width: 1200, height: 760 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`layout and screenshots (${name}; SCREENS=1 saves images)`, async ({ page }) => {
    await page.setViewportSize(vp)
    const id = newUser()
    allow(id)
    await setHabitica(id, { name: 'Tansy' })
    await routeHabitica(page.context())
    const shot = async (n: string) => process.env.SCREENS && page.screenshot({ path: `.agent/screens/${n}-${name}.png` })
    const fits = async () => {
      const r = await page.evaluate(() => {
        const col = document.querySelector('.title-col') as HTMLElement
        const h1 = document.querySelector('h1') as HTMLElement
        const card = document.querySelector('.guide-card, .choice-col') as HTMLElement | null
        const rc = col.getBoundingClientRect(), rh = h1.getBoundingClientRect(), rk = card?.getBoundingClientRect()
        return { colScroll: col.scrollWidth - col.clientWidth, h1: [rh.left - rc.left, rc.right - rh.right], h1Own: h1.scrollWidth - h1.clientWidth, card: rk ? [rk.left - rc.left, rc.right - rk.right] : null }
      })
      expect(r.colScroll).toBeLessThanOrEqual(0)
      expect(r.h1Own).toBeLessThanOrEqual(0)
      expect(Math.min(...r.h1)).toBeGreaterThanOrEqual(0)
      if (r.card) expect(Math.min(...r.card)).toBeGreaterThanOrEqual(0)
    }
    const reachable = async (loc: ReturnType<typeof page.getByRole>) => {
      await loc.scrollIntoViewIfNeeded()
      const b = (await loc.boundingBox())!
      expect(b.y).toBeGreaterThanOrEqual(0)
      expect(b.y + b.height).toBeLessThanOrEqual(vp.height)
    }
    await page.goto('/')
    await page.getByRole('button', { name: /Play as your Habitica hero/ }).waitFor()
    await page.evaluate(() => document.fonts.ready)
    await fits(); await shot('1-title-choice')
    await page.getByRole('button', { name: /Play as your Habitica hero/ }).click()
    await fits(); await shot('2-guide-website')
    await reachable(page.getByRole('button', { name: 'I have them' }))
    await page.getByRole('tab', { name: 'iOS app' }).click(); await shot('3-guide-ios')
    await page.getByRole('tab', { name: 'Android app' }).click(); await shot('4-guide-android')
    await page.getByRole('button', { name: 'I have them' }).click()
    await page.getByLabel('Paste both values').fill(`${TOKEN}\n${id}`)
    await fits(); await shot('5-swap-preview')
    await reachable(page.getByRole('button', { name: 'Looks right — Connect' }))
    await shot('5b-swap-preview-scrolled')
    await page.getByRole('button', { name: 'Swap' }).click()
    await fits(); await shot('5c-swap-preview-swapped')
    await page.getByText('Why does it need my token?').click()
    await fits(); await shot('6-why-token')
  })
}
