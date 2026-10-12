/** Real two-account shared-fight gate. CI-only; no intercepted fight packets. */
import { expect, test, type Page } from './fixtures'
import { CONTRACT, pinWorld, reenter } from './connected'
import { freshPlayer } from './home-helpers'
import { expectToast, frames, parkCreatures, pressOn, spotsAround, standFor, waitForLive, waitForWilds, warp, wilds, worldTileOf } from './helpers'

type Enemy = { id: string; x: number; y: number; hp: number; state: string; fight: { room: number; enemy: number } | null }
const enemies = (page: Page, camp: string) => page.evaluate(id =>
  (window as unknown as { __fsEnemies(): Enemy[] }).__fsEnemies().filter(e => e.id.startsWith(`wilds:${id}:`)), camp)

async function enterCamp(page: Page, tile: { tx: number; ty: number }): Promise<void> {
  await warp(page, 'wilds', tile.tx, tile.ty)
  await waitForWilds(page)
  await waitForLive(page)
}

test('two players share wind-ups, menus, reconnect, confirmed deaths and personal claims', async ({ page, browser, baseURL }) => {
  test.skip(!process.env.CI, 'real two-client fight gate runs in CI; use the owner playtest locally')
  test.setTimeout(240_000)
  await freshPlayer(page, 'Tansy')
  await pinWorld(page, 'e2e-shared-fights')
  await page.goto('/?perf=1')
  await page.getByTestId('continue-world').click()
  await waitForLive(page)
  await enterCamp(page, { tx: 12, ty: -12 })
  // Seed e2e-shared-fights, generator v3, still epoch (the Tangle never turns):
  // camp:0:-1:0 is one wisp at world tile (13,-15), in this chunk, and the
  // nearest other camp is 22 tiles off, so no second camp joins the fight.
  // Pinned by id, not by dump order.
  const pinned = (await wilds(page)).entities.find(e => e.id === 'camp:0:-1:0')
  expect(pinned, 'the pinned camp on the pinned land').toBeDefined()
  const camp = pinned!
  expect(camp.kind).toBe('camp')
  expect(camp.state, 'the pinned camp is uncleared').toBe('available')
  expect(camp.enemies, 'the pinned camp is wisp-only').toEqual(['wisp'])
  const tile = worldTileOf(camp)
  await page.getByRole('button', { name: 'Menu (Esc)' }).click()
  const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json() as { code: string }
  const context = await browser.newContext({ baseURL })
  const other = await context.newPage()
  const errors: string[] = []
  other.on('pageerror', error => errors.push(error.message))
  try {
    await freshPlayer(other, 'Wren', invite.code)
    await other.goto('/?perf=1')
    await other.getByTestId('continue-world').click()
    await waitForLive(other)
    await enterCamp(other, tile)
    await page.keyboard.press('Escape')
    await enterCamp(page, tile)
    await expect.poll(async () => (await enemies(page, camp.id)).filter(e => e.fight !== null).length).toBeGreaterThan(0)
    await expect.poll(async () => (await enemies(other, camp.id)).map(e => e.id).sort()).toEqual((await enemies(page, camp.id)).map(e => e.id).sort())
    const shared = (await enemies(page, camp.id))[0]!
    await expect.poll(async () => (await enemies(other, camp.id)).find(e => e.id === shared.id)?.fight).toEqual(shared.fight)
    // Watch the same tell on both screens, using a state transition rather
    // than a fixed sleep or exact receipt-time position comparison.
    await expect.poll(async () => {
      const a = await enemies(page, camp.id)
      const b = await enemies(other, camp.id)
      return a.some(e => e.state === 'telegraph' && b.some(o => o.id === e.id && o.state === 'telegraph'))
    }, { timeout: 15_000, message: 'both screens draw the same wisp wind-up' }).toBe(true)
    await page.getByRole('button', { name: 'Menu (Esc)' }).click()
    const before = await enemies(page, camp.id)
    await expect.poll(async () => (await enemies(page, camp.id)).some(e => {
      const old = before.find(o => o.id === e.id)
      return !!old && (Math.abs(e.x - old.x) + Math.abs(e.y - old.y) > 4 || e.state !== old.state)
    }), { message: 'server enemies update while the menu holds local play' }).toBe(true)
    await page.keyboard.press('Escape')
    await reenter(other, 'wilds')
    await expect.poll(async () => (await enemies(other, camp.id)).map(e => e.id).sort()).toEqual((await enemies(page, camp.id)).map(e => e.id).sort())
    expect(new Set((await enemies(other, camp.id)).map(e => e.id)).size).toBe((await enemies(other, camp.id)).length)
    // Real Hero swings, alternating accounts. __fsDevStrike would bypass
    // intent/result processing, so it is deliberately not used in this gate.
    for (let n = 0; n < 30; n++) {
      const live = (await enemies(page, camp.id)).filter(e => e.hp > 0)
      if (!live.length) break
      const attacker = n % 2 ? other : page
      const enemy = live[0]!
      await attacker.evaluate(([x,y]) => (window as unknown as { __fsDevPlace(x:number,y:number):void }).__fsDevPlace(x,y), [enemy.x - 14, enemy.y] as const)
      await frames(attacker, 12)
      await attacker.keyboard.down('ArrowRight')
      await attacker.waitForTimeout(35)
      await attacker.keyboard.up('ArrowRight')
      await attacker.evaluate(() => (window as unknown as { __fsDevAttack():void }).__fsDevAttack())
      await attacker.waitForTimeout(650)
    }
    for (const p of [page, other]) {
      await expect.poll(async () => (await enemies(p, camp.id)).filter(e => e.hp > 0).length, { message: 'both see every confirmed camp death' }).toBe(0)
      await expect.poll(async () => (await wilds(p)).entities.find(e => e.id === camp.id)?.claimable, { timeout: 10_000 }).toBe(true)
    }
    // Both witnessed the fight, and settlement stays personal and once-only.
    // The swings left each hero wherever the last wisp fell, which can be
    // past the claim's reach: the creatures set aside, stand where the game
    // elects the camp's claim (wilds.spec.ts does the same), then press it.
    for (const p of [page, other]) {
      await parkCreatures(p)
      const why: string[] = []
      const stood = await standFor(p, `wilds:${camp.id}`, await spotsAround(p, tile), why)
      if (!stood) throw new Error(`no spot elects the camp's claim at ${tile.tx},${tile.ty}: ${why.join(' ')}`)
      await pressOn(p, `wilds:${camp.id}`, tile)
      await expectToast(p, /The camp is yours to rest at/)
      await expect.poll(async () => (await wilds(p)).claims.includes(camp.id)).toBe(true)
      await expect.poll(async () => (await wilds(p)).entities.find(e => e.id === camp.id)?.claimable, { message: 'a settled claim is not offered again' }).toBe(false)
    }
    const measured = await page.evaluate(() => (window as unknown as { __fsPerf(): { fights: { confirmations:number; timeouts:number } } }).__fsPerf().fights)
    expect(measured.confirmations).toBeGreaterThan(0)
    expect(measured.timeouts).toBe(0)
    expect(errors, 'second player has no uncaught errors').toEqual([])
  } finally {
    await context.close()
  }
})
