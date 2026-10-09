import { expect, test, type Page } from './fixtures'
import type { BrowserContext } from '@playwright/test'
import { allow, newUser, openTitleGuide, pasteAndConnect, routeHabitica, serverState, setHabitica, waitForWorld, CONTRACT } from './connected'
import { frames, hold, stepToWarden, talkThrough, waitForLive, warden, warp } from './helpers'
import { freshPlayer } from './home-helpers'

/**
 * The moves in the game (docs/design/crafts.md 4, lane F): a hero without a
 * craft fights with what's in hand, a level-20 hero's second move on R is
 * paid for in the next report, and a healer's Ward-light mends a friend.
 */

type Moves = { signature: string | null; move: string | null; castCooldown: number; moveCooldown: number; planted: boolean; patches: { x: number; y: number; r: number; slow: number }[]; decoy: { x: number; y: number } | null }
type EnemyView = { x: number; y: number; state: string; hp: number; type: string }

const moves = (page: Page) => page.evaluate(() => (window as unknown as { __fsMoves: () => Moves }).__fsMoves())
const enemies = (page: Page) => page.evaluate(() => (window as unknown as { __fsEnemies: () => EnemyView[] }).__fsEnemies())
const meter = (page: Page, name: 'Mana' | 'Health') => async () => Number((await page.getByRole('meter', { name }).first().getAttribute('aria-valuenow')) ?? NaN)

test('a hero without a class fights with what’s in hand: no ✦, the finger-wisp falls to the slash, the Warden settles to the naming', async ({ page }) => {
  test.setTimeout(150_000)
  await freshPlayer(page, 'Wren', undefined, { class: null })
  await waitForLive(page)
  expect(await moves(page)).toMatchObject({ signature: null, move: null })
  await expect(page.locator('.actionbar [data-ability]')).toHaveCount(0)

  // F does nothing: no mana spent, no cooldown.
  const mana = meter(page, 'Mana')
  const before = await mana()
  await page.keyboard.press('f')
  await frames(page, 10)
  expect(await mana()).toBe(before)
  expect((await moves(page)).castCooldown).toBe(0)

  // The opening's finger-wisp (4 HP, tile 6,17): face it and swing.
  await warp(page, 'woodland', 9, 17)
  const fingerWisp = async () => (await enemies(page)).some((e) => e.type === 'wisp' && e.hp > 0 && e.hp <= 4)
  expect(await fingerWisp()).toBe(true)
  for (let i = 0; i < 60 && (await fingerWisp()); i++) {
    await hold(page, 'a', 60)
    await page.keyboard.press('e')
    await frames(page, 8)
  }
  expect(await fingerWisp()).toBe(false)
  await page.screenshot({ path: 'test-results/abilities-classless-wisp.png' })

  // The Warden: blows only clink; the naming settles it, through the action button.
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await warp(page, 'ruin', 15, 3)
  await talkThrough(page, /Copy the naming from the stone/)
  await expect.poll(async () => (await warden(page)).state).toBe('active')
  const needed = (await warden(page)).needed
  for (let i = 1; i <= needed; i++) {
    await stepToWarden(page, 84, false)
    await stepToWarden(page, 20, true)
    await expect(page.locator('.prompt')).toContainText('Speak the naming')
    await page.keyboard.press('e')
    await expect.poll(async () => (await warden(page)).speakings).toBe(i)
  }
  await expect.poll(async () => (await warden(page)).state).toBe('settled')
})

test('a level-20 mage casts Kindle on R: a patch ahead, its own cooldown, and the mana gone in the next report', async ({ page }) => {
  test.setTimeout(90_000)
  await freshPlayer(page, 'Tansy', undefined, { lvl: 20, class: 'wizard' })
  await waitForLive(page)
  expect(await moves(page)).toMatchObject({ signature: 'fingersnap', move: 'kindle' })
  const sig = page.locator('.actionbar .slot.sig')
  const second = page.locator('.actionbar .slot.move')
  await expect(sig).toContainText('Fingersnap')
  await expect(second).toContainText('Kindle')
  await expect(second.locator('.kbd')).toHaveText('R')
  await expect(second.locator('.cost')).toHaveText('16')

  await warp(page, 'woodland', 15, 20)
  await waitForLive(page)
  const mana = meter(page, 'Mana')
  const before = await mana()
  expect(before).toBeGreaterThanOrEqual(16)

  // The next report carries the cast by its id, and the mana it cost.
  const report = page.waitForRequest((r) => r.url().endsWith('/api/report') && !!r.postDataJSON()?.abilityCasts?.kindle, { timeout: 30_000 })
  const castAt = Date.now()
  await page.keyboard.press('r')
  await expect.poll(async () => (await moves(page)).patches.length).toBe(1)
  const m = await moves(page)
  expect(m.moveCooldown).toBeGreaterThan(0)
  expect(m.patches[0].slow).toBe(0.6)
  expect(m.patches[0].r).toBe(24)
  await expect(second.locator('.sweep')).toBeVisible()
  await page.screenshot({ path: 'test-results/abilities-kindle.png' })

  // R again at once: still cooling, no second patch.
  await page.keyboard.press('r')
  await frames(page, 5)
  expect((await moves(page)).patches.length).toBe(1)

  // Arriving somewhere else reports at once (mana returns 5 a second, so sooner is clearer).
  await warp(page, 'village', 16, 18)
  const sent = await report
  const body = sent.postDataJSON()
  const seconds = (Date.now() - castAt) / 1000
  expect(body.abilityCasts).toEqual({ kindle: 1 })
  expect(body.mana).toBeLessThanOrEqual(before - 16 + 5 * seconds + 1)
  // The world takes the report's mana (never more than it says).
  const answer = await (await sent.response())!.json()
  expect(answer.state.vitals.mana).toBeLessThanOrEqual(body.mana + 0.01)
})

test('a friend’s Ward-light, as the hub relays it, mends the hero inside its circle, and nobody outside', async ({ page }) => {
  test.setTimeout(60_000)
  // The default hero comes in at 41 of 50 health.
  await freshPlayer(page, 'Rowan')
  await warp(page, 'village', 16, 18)
  await waitForLive(page)
  const health = meter(page, 'Health')
  const hero = () => page.evaluate(() => (window as unknown as { __fsPlayer: () => { x: number; y: number } }).__fsPlayer())
  const relay = (x: number, y: number) =>
    page.evaluate(([x, y]) => (window as unknown as { __fsEmit: (e: string, p: unknown) => void }).__fsEmit('game:ability-cast', { accountId: 'friend', ability: 'ward-light', x, y }), [x, y])
  const before = await health()
  expect(before).toBeLessThanOrEqual(43)

  // Far away: drawn, but it mends nobody here.
  const at = await hero()
  await relay(at.x + 200, at.y)
  await page.waitForTimeout(4500)
  expect(await health()).toBe(before)

  // At the hero's feet: pulses of a Mend's share (2.4 each) at 1, 2.5 and 4 s. (Without the
  // hub's ward credit the next report's answer takes it back; the two-player test checks it stays.)
  await relay(at.x, at.y)
  await expect.poll(health, { timeout: 8_000, intervals: [100] }).toBeGreaterThan(before)
  await page.screenshot({ path: 'test-results/abilities-ward-relayed.png' })
})

test('two players: one Ward-light, and the other’s health rises with its pulses', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000)
  const ash = newUser()
  const rowan = newUser()
  allow(ash)
  await setHabitica(ash, { name: 'Ash', lvl: 20, class: 'healer' })
  await setHabitica(rowan, { name: 'Rowan', hp: 30 })
  await routeHabitica(page.context())
  await openTitleGuide(page)
  await pasteAndConnect(page, ash)
  await waitForWorld(page)
  const invite = await (await page.request.post('/api/invites', { data: {}, ...CONTRACT })).json()
  const ctx: BrowserContext = await browser.newContext({ baseURL, viewport: { width: 1200, height: 760 } })
  await routeHabitica(ctx)
  const other = await ctx.newPage()
  await openTitleGuide(other)
  await pasteAndConnect(other, rowan, { invite: invite.code })
  await waitForWorld(other)

  await warp(page, 'village', 16, 18)
  await warp(other, 'village', 16, 18)
  const remotes = (p: Page) => p.evaluate(() => ((window as unknown as { __fsRemote?: () => { name: string }[] }).__fsRemote?.() ?? []).map((r) => r.name))
  await expect.poll(() => remotes(page), { timeout: 15_000 }).toEqual(['Rowan'])
  await expect.poll(() => remotes(other), { timeout: 15_000 }).toEqual(['Ash'])
  expect(await moves(page)).toMatchObject({ signature: 'mend', move: 'ward-light' })

  const health = meter(other, 'Health')
  const before = await health()
  expect(before).toBeLessThan(50)
  await waitForLive(page)
  await page.keyboard.press('r')
  // The hub relays the cast (lane C, crafts.md 4.5); a hub without the relay closes the caster's socket.
  await frames(page, 30)
  const status = await page.evaluate(() => (window as unknown as { __fsPresence?: () => { status: string } }).__fsPresence?.()?.status ?? null)
  expect(status, 'the presence hub must relay `ability` (lane C)').toBe('live')
  // Three pulses over five seconds, each a share of a Mend.
  await expect.poll(health, { timeout: 10_000 }).toBeGreaterThan(before)
  await other.screenshot({ path: 'test-results/abilities-ward-friend.png' })
  const healed = await health()

  // The world keeps it: the friend's next report is allowed the ward credit (lane C's hub).
  await expect.poll(async () => (await serverState(other)).body?.state?.hp ?? 0, { timeout: 30_000 }).toBeGreaterThanOrEqual(Math.floor(healed))
  await ctx.close()
})
