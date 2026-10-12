import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from '../e2e/fixtures'
import { pinWorld, waitForWorld } from '../e2e/connected'
import { freshPlayer } from '../e2e/home-helpers'
import { waitForWilds, warp, wilds, worldTileOf } from '../e2e/helpers'
import type { PerfReport } from '../src/game/perf'

const duration = Number(process.env.PERF_FIGHT_MS) || 20_000
const out = process.env.PERF_OUT || 'test-results/perf'
const label = process.env.PERF_LABEL || 'fights'
const query = `?perf=1&lag=${Number(process.env.PERF_FIGHT_LAG) || 0}&jitter=${Number(process.env.PERF_FIGHT_JITTER) || 0}`

for (const [name, throttle] of [['normal', 1], ['throttled', 4]] as const) {
  test(`shared fight observation on a phone (${name})`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    try {
      await freshPlayer(page)
      await pinWorld(page, 'perf-shared-fights')
      await page.goto(`/${query}`)
      await page.getByTestId('continue-world').click()
      await waitForWorld(page)
      const cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
      await warp(page, 'wilds', 12, -12)
      await waitForWilds(page)
      const camp = (await wilds(page)).entities.find(e => e.kind === 'camp' && e.state === 'available' && e.enemies.length > 0)
      expect(camp, 'camp on fixed perf land').toBeDefined()
      const tile = worldTileOf(camp!)
      await warp(page, 'wilds', tile.tx, tile.ty)
      await waitForWilds(page)
      await expect.poll(() => page.evaluate(id =>
        (window as unknown as { __fsEnemies(): { id:string; fight:unknown }[] }).__fsEnemies().filter(e => e.id.startsWith(`wilds:${id}:`) && e.fight).length, camp!.id)).toBeGreaterThan(0)
      // Menu freezes this hero's hurt/input while server AI and rendering
      // continue. This measures observation cost without killing enemies or
      // confounding samples with a fall/scene transition.
      await page.getByRole('button', { name: 'Menu (Esc)' }).click()
      // Frames, long frames and the histogram cover only the observation
      // window, not login, warps and chunk loading.
      await page.evaluate(() => {
        const hooks = window as unknown as { __fsPerfReset():void; __fsPerfPhase(name:string):void }
        hooks.__fsPerfReset()
        hooks.__fsPerfPhase('fight-observation')
      })
      await page.waitForTimeout(duration)
      const report = await page.evaluate(() => (window as unknown as { __fsPerf():PerfReport }).__fsPerf())
      expect(report.fights?.snapshotSamples).toBeGreaterThan(0)
      expect(report.phases['fight-observation']?.frames).toBeGreaterThan(0)
      mkdirSync(out, { recursive:true })
      writeFileSync(`${out}/${label}-${name}.json`, JSON.stringify({ scenario:'fight-observation', throttle, durationMs:duration, camp:camp!.id, query, report }, null, 2))
      console.log(JSON.stringify({ scenario:'fight-observation', throttle, fights:report.fights, frames:report.phases['fight-observation'], histogram:report.histogram }))
      expect(errors).toEqual([])
      await cdp.detach()
    } finally {
      await context.close()
    }
  })
}
