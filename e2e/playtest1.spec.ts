import { mkdirSync, readFileSync } from 'node:fs'
import type { BrowserContext, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { beginNewJourney, dialogueState, frames, holdUntil, openTalk, readDialogue, untilChoices, waitForLive, warp } from './helpers'
import { allow, habiticaURL, newUser, openTitleGuide, pasteAndConnect, routeHabitica, serverState, setHabitica, sql, syncFromMenu, waitForWorld } from './connected'
import { claimDeed, earnEmbers, freshPlayer, homes, intoCottage, toMyLand, go } from './home-helpers'
import { HEIRLOOM_REFUSALS } from '../src/content/heirlooms.ts'

/**
 * Fixes from the owner's first real playtest (.agent/BRIEF.md):
 *  1. A real outfit's pieces the bundled cache lacks come through our sprite
 *     proxy and are kept on the device: drawn, no "left off" notice, and not
 *     fetched again on a reload.
 *  2. Heirloom offers are offered only when the server will grant them, and a
 *     refusal is the giver's own reply in the conversation, not a toast.
 *  3. The tags on choices are big and dark enough to read.
 *  4/5. Placed seats are sittable; sitting puts the hero on the seat, at the
 *     seat's depth, cut at the lap rather than squashed.
 *  6. The avatar breathes (one pixel, slowly) instead of floating, steps
 *     when walking, mirrors for left and right; no breath with reduced motion.
 *
 * The sprite proxy itself (allow-list, size cap, disk cache) is the Go
 * server's tests' (server/internal/api/sprites_test.go). Here the browser's
 * /api/sprites requests are answered with bundled stand-ins of the same slot,
 * so no playtest reaches Habitica; E2E_REAL_SPRITES=1 lets them through to
 * the server, which fetches the real art (for the screenshots).
 *
 * Screenshots (SCREENS=1): desktop, and a phone with touch, in .agent/screens/.
 */

const OUT = '.agent/screens'
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

/** Gear the bundled cache doesn't have (a warrior a few tiers on). */
const OUTFIT = { armor: 'armor_warrior_3', head: 'head_warrior_3', shield: 'shield_warrior_3', weapon: 'weapon_warrior_3' }
const OUTFIT_SPRITES = ['slim_armor_warrior_3', 'head_warrior_3', 'shield_warrior_3', 'weapon_warrior_3']

const BUNDLED = new URL('../public/assets/habitica/', import.meta.url)
const STAND_INS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^(slim|broad)_armor_/, (m) => `${m[1]}_armor_warrior_1`],
  [/^head_(?!0$)/, () => 'head_warrior_1'],
  [/^shield_/, () => 'shield_warrior_1'],
  [/^weapon_/, () => 'weapon_warrior_1']
]

/** Answer /api/sprites from bundled stand-ins (unless E2E_REAL_SPRITES); returns the names asked for. */
async function standInSprites(context: BrowserContext): Promise<string[]> {
  const asked: string[] = []
  await context.route(
    (url) => url.pathname.startsWith('/api/sprites/'),
    async (route) => {
      const m = /^\/api\/sprites\/([A-Za-z0-9_-]+)\.(png|gif)$/.exec(new URL(route.request().url()).pathname)
      if (m) asked.push(m[1])
      if (process.env.E2E_REAL_SPRITES) return route.fallback()
      const to = m && STAND_INS.find(([re]) => re.test(m[1]))
      if (!m || !to) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":"not-found"}}' })
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: { 'cache-control': 'public, max-age=31536000, immutable' },
        body: readFileSync(new URL(`${to[1](to[0].exec(m[1])!)}.png`, BUNDLED))
      })
    }
  )
  return asked
}

/** A connected hero wearing OUTFIT on Habitica (the browser's read is what's imported). */
async function outfittedPlayer(page: Page): Promise<string> {
  const id = newUser()
  allow(id)
  await setHabitica(id, { name: 'Tansy' })
  await routeHabitica(page.context())
  // Registered after routeHabitica, so it answers first: the same fake hero, dressed.
  await page.context().route('https://habitica.com/api/v3/user*', async (route) => {
    const h = route.request().headers()
    const res = await fetch(`${habiticaURL()}/api/v3/user`, { headers: { 'x-api-user': h['x-api-user'] ?? '', 'x-api-key': h['x-api-key'] ?? '' } })
    const body = (await res.json()) as { data?: { items?: { gear?: { equipped?: Record<string, string> } }; preferences?: { skin?: string; hair?: { bangs?: number } } } }
    if (body.data?.items?.gear) body.data.items.gear.equipped = { ...body.data.items.gear.equipped, ...OUTFIT }
    // A real skin and a fringe (the shared fixture's "normal" skin isn't one Habitica has).
    if (body.data?.preferences) {
      body.data.preferences.skin = '915533'
      if (body.data.preferences.hair) body.data.preferences.hair.bangs = 1
    }
    await route.fulfill({ status: res.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
  })
  await openTitleGuide(page)
  await pasteAndConnect(page, id)
  await waitForWorld(page)
  // Sign-in imports the server's own read; a sync brings the browser's (dressed) one.
  await syncFromMenu(page)
  await expect.poll(async () => (await serverState(page)).body.importedProfile?.equipped?.armor).toBe(OUTFIT.armor)
  const back = page.getByRole('button', { name: 'Back to the road' })
  if (await back.isVisible()) await back.click()
  await waitForLive(page)
  return id
}

type SeatView = {
  seated: boolean
  x: number
  y: number
  seat: { x: number; y: number; depth: number; facing: string } | null
  heroDepth: number
  heroScale: { x: number; y: number }
  heroCrop: boolean
  avatar: { x: number; y: number; depth: number; scaleX: number; scaleY: number; breath: number; step: number; seated: boolean; mirrored: boolean } | null
}
const seat = (page: Page) => page.evaluate(() => (window as unknown as { __fsSeat: () => SeatView }).__fsSeat())
const texture = (page: Page, key: string) => page.evaluate((k) => (window as unknown as { __fsDevTextureHash: (k: string) => number | null }).__fsDevTextureHash(k), key)
const toasts = (page: Page) => page.evaluate(() => (window as unknown as { __fsToasts: () => { seen: { text: string }[] } }).__fsToasts().seen.map((t) => t.text))

/** The screen, and a close-up around the hero (SCREENS=1 only). */
async function snap(page: Page, name: string, device: string, closeUp = true): Promise<void> {
  if (!process.env.SCREENS) return
  mkdirSync(OUT, { recursive: true })
  await frames(page, 20)
  await page.screenshot({ path: `${OUT}/playtest1-${name}-${device}.png` })
  if (!closeUp) return
  const hero = await page.evaluate(() => (window as unknown as { __fsDevHeroScreen: () => { x: number; y: number; w: number; h: number } }).__fsDevHeroScreen())
  const canvas = (await page.locator('canvas').first().boundingBox())!
  const view = page.viewportSize()!
  const w = Math.min(240, view.width)
  const h = 200
  const x = Math.max(0, Math.min(view.width - w, canvas.x + hero.x + hero.w / 2 - w / 2))
  const y = Math.max(0, Math.min(view.height - h, canvas.y + hero.y + hero.h / 2 - h / 2))
  await page.screenshot({ path: `${OUT}/playtest1-${name}-${device}-close.png`, clip: { x, y, width: w, height: h } })
}

/** Press the world's action: E on a keyboard, the action button on a touch screen. */
async function act(page: Page, device: string): Promise<void> {
  await waitForLive(page)
  if (device === 'phone') await page.locator('.controls .act').tap()
  else await page.keyboard.press('e')
}

for (const device of ['desktop', 'phone'] as const) {
  test.describe(`playtest 1 (${device})`, () => {
    if (device === 'phone') test.use(PHONE)

    test.describe('connected', () => {
      test.use({ server: true })

      test('the whole Habitica outfit is drawn: missing pieces fetched once, kept on the device', async ({ page }) => {
        const asked = await standInSprites(page.context())
        await outfittedPlayer(page)
        // Every piece the bundle lacks was asked for through our own server, and drawn.
        await expect.poll(() => OUTFIT_SPRITES.filter((n) => asked.includes(n)).sort()).toEqual([...OUTFIT_SPRITES].sort())
        for (const n of OUTFIT_SPRITES) await expect.poll(() => texture(page, `fs-asset-${n}`)).not.toBeNull()
        await expect.poll(async () => (await seat(page)).avatar).not.toBeNull()
        expect((await toasts(page)).filter((t) => /left off|couldn’t be fetched|art cache/.test(t))).toEqual([])
        await warp(page, 'village', 18, 14)
        await snap(page, 'avatar', device)

        // A reload draws it all again from the device's own cache: nothing asked for.
        const before = asked.length
        await page.reload()
        await page.getByRole('button', { name: /Continue/ }).click()
        await waitForWorld(page)
        for (const n of OUTFIT_SPRITES) await expect.poll(() => texture(page, `fs-asset-${n}`)).not.toBeNull()
        expect(asked.length).toBe(before)
        expect((await toasts(page)).filter((t) => /left off|couldn’t be fetched|art cache/.test(t))).toEqual([])
      })

      test('standing still the hero breathes, walking it steps and faces the way it goes', async ({ page }) => {
        await standInSprites(page.context())
        await outfittedPlayer(page)
        await warp(page, 'village', 18, 14)
        await expect.poll(async () => (await seat(page)).avatar).not.toBeNull()
        // Still: the body never moves (no float); the shoulders rise one pixel now and then.
        const still: NonNullable<SeatView['avatar']>[] = []
        for (let i = 0; i < 24; i++) {
          still.push((await seat(page)).avatar!)
          await page.waitForTimeout(200)
        }
        expect(new Set(still.map((a) => a.y)).size).toBe(1)
        expect(new Set(still.map((a) => a.breath))).toEqual(new Set([0, -3]))
        expect(still.every((a) => a.step === 0)).toBe(true)
        // Walking right: mirrored, stepping. Walking left: not mirrored.
        const stepsRight: number[] = []
        await holdUntil(page, 'ArrowRight', async () => {
          const a = (await seat(page)).avatar!
          stepsRight.push(a.step)
          return a.mirrored && new Set(stepsRight).size === 2
        })
        await holdUntil(page, 'ArrowLeft', async () => (await seat(page)).avatar!.mirrored === false)
      })

      test('Silas hands over the axe on the first try, even from a stale saved spot', async ({ page }) => {
        const id = await freshPlayer(page, 'AxeTester')
        sql(`UPDATE progress SET doc_json = json_insert(doc_json, '$.flags[#]', 'echo:hollis') WHERE habitica_id='${id}';`)
        await page.evaluate(() => (window as unknown as { __fsDevAddFlag: (f: string) => void }).__fsDevAddFlag('echo:hollis'))
        await warp(page, 'commons', 51, 22)
        await openTalk(page, 'Talk to Silas')
        const choices = await untilChoices(page)
        expect(choices.some((c) => /Take the Brack felling axe/.test(c.text))).toBe(true)
        // The save still holds a spot from before the walk up (the frame loop
        // doesn't note it while a conversation is open): eight tiles off.
        await page.evaluate(() => (window as unknown as { __fsDevStalePosition: (x: number, y: number) => void }).__fsDevStalePosition(51 * 16 + 8, 30 * 16))
        const refused: number[] = []
        page.on('response', (r) => {
          if (r.url().endsWith('/api/items/heirloom') && r.status() === 409) refused.push(r.status())
        })
        await readDialogue(page, { pick: /Take the Brack felling axe/ })
        await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('heirloom:brack-felling-axe')
        expect(refused).toEqual([])
      })

      test('a refused offer is the giver’s own reply, in the conversation', async ({ page }) => {
        const id = await freshPlayer(page, 'RefusedTester')
        sql(`UPDATE progress SET doc_json = json_insert(doc_json, '$.flags[#]', 'echo:hollis') WHERE habitica_id='${id}';`)
        await page.evaluate(() => (window as unknown as { __fsDevAddFlag: (f: string) => void }).__fsDevAddFlag('echo:hollis'))
        // The server says no (as it would to someone it measured too far off).
        await page.route('**/api/items/heirloom', (route) =>
          route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'too-far-away' } }) })
        )
        await warp(page, 'commons', 51, 22)
        await openTalk(page, 'Talk to Silas')
        await untilChoices(page)
        await page.locator('.choice', { hasText: /Take the Brack felling axe/ }).click()
        await expect.poll(async () => {
          const d = await dialogueState(page)
          return d.open ? `${d.speaker}: ${d.said.join(' ')}` : null
        }).toBe(`Silas: ${HEIRLOOM_REFUSALS['brack-felling-axe']['too-far']}`)
        await page.locator('.dialogue .line').dispatchEvent('click')
        await snap(page, 'refused-offer', device, false)
        expect((await toasts(page)).some((t) => /too far|right there|didn’t go through/i.test(t))).toBe(false)
        await readDialogue(page)
      })

      test('a stool set out at home is sat on, like a bench', async ({ page }) => {
        await standInSprites(page.context())
        const id = await outfittedPlayer(page)
        await earnEmbers(page, id)
        await claimDeed(page)
        const land = await toMyLand(page)
        const tx = land.doorstep.tx + 3
        const ty = land.doorstep.ty + 1
        const home = `(SELECT homestead_id FROM homestead_members WHERE habitica_id='${id}')`
        sql(`INSERT INTO homestead_items(id,item_def,location,homestead_id,scene,x,y,rotation) VALUES('pt1-stool','wooden-stool','placed',${home},'outdoor',${tx},${ty},0);`)
        // Back out and through the gate again: the land is read afresh, stool and all.
        await go(page, 'commons', 23, 19)
        await toMyLand(page)
        await expect.poll(async () => (await homes(page)).here?.items.some((i) => i.id === 'pt1-stool') ?? false).toBe(true)
        await page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [tx * 16 + 8, (ty + 1) * 16 + 6] as const)
        await expect(page.locator('.prompt')).toContainText('Sit on the stool')
        await act(page, device)
        await expect.poll(async () => (await seat(page)).seated).toBe(true)
        const s = await seat(page)
        // On the stool's round top (its art fills the tile), just in front of it.
        expect(s.seat!.facing).toBe('down')
        expect(s.seat!.depth).toBe((ty + 1) * 16 + 0.5)
        expect(Math.abs(s.seat!.x - (tx * 16 + 8))).toBeLessThanOrEqual(1)
        expect(s.seat!.y).toBeGreaterThan(ty * 16)
        expect(s.seat!.y).toBeLessThan((ty + 1) * 16 - 4)
        expect(s.heroCrop).toBe(true)
        await snap(page, 'sit-stool', device)
        await expect(page.locator('.prompt')).toContainText('Stand up')
        await act(page, device)
        await expect.poll(async () => (await seat(page)).seated).toBe(false)
      })

      test('in the cottage a reading chair is sat in, turned or not; the Empty Chair stays empty', async ({ page }) => {
        await standInSprites(page.context())
        const id = await outfittedPlayer(page)
        await earnEmbers(page, id)
        await claimDeed(page)
        const home = `(SELECT homestead_id FROM homestead_members WHERE habitica_id='${id}')`
        // A cottage (tier 1), a reading chair facing you at grid (3,4), one side on at (7,5), and the Empty Chair.
        sql(
          `UPDATE homesteads SET tier=1 WHERE id=${home};` +
            `INSERT INTO homestead_items(id,item_def,location,homestead_id,scene,x,y,rotation) VALUES` +
            `('pt1-chair','reading-chair','placed',${home},'indoor',3,4,0),` +
            `('pt1-side','reading-chair','placed',${home},'indoor',7,5,90),` +
            `('pt1-empty','empty-chair','placed',${home},'indoor',10,6,0);`
        )
        await intoCottage(page)
        await expect.poll(async () => (await homes(page)).here?.items.filter((i) => i.id.startsWith('pt1-')).length ?? 0).toBe(3)
        const place = async (x: number, y: number) => {
          await page.evaluate(([px, py]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(px, py), [x, y] as const)
          // The prompt follows the hero on the next frames.
          await frames(page, 10)
        }

        // The room grid starts at tile (1, 3): the chair's footprint is x 64..80, bottom 144.
        // Delivered art: a small armchair in the footprint's lower tile; you sit on its cushion.
        await place(72, 150)
        await expect(page.locator('.prompt')).toContainText('Sit in the reading chair')
        await act(page, device)
        await expect.poll(async () => (await seat(page)).avatar?.seated).toBe(true)
        let s = await seat(page)
        expect(s.seat!.facing).toBe('down')
        expect(s.seat!.depth).toBe(144.5)
        expect(s.seat!.x).toBe(72)
        expect(s.seat!.y).toBeGreaterThan(144 - 16)
        expect(s.seat!.y).toBeLessThan(144)
        expect(s.avatar!.depth).toBe(144.5)
        await snap(page, 'sit-chair', device)
        await act(page, device)
        await expect.poll(async () => (await seat(page)).seated).toBe(false)

        // Turned 90° (two tiles wide, x 128..160): the same front view, centred; you still face the room.
        await place(144, 150)
        await expect(page.locator('.prompt')).toContainText('Sit in the reading chair')
        await act(page, device)
        await expect.poll(async () => (await seat(page)).avatar?.seated).toBe(true)
        s = await seat(page)
        expect(s.seat!.facing).toBe('down')
        expect(Math.abs(s.seat!.x - 144)).toBeLessThanOrEqual(1)
        expect(s.seat!.y).toBeGreaterThan(144 - 16)
        expect(s.seat!.y).toBeLessThan(144)
        await snap(page, 'sit-chair-turned', device)
        await act(page, device)
        await expect.poll(async () => (await seat(page)).seated).toBe(false)

        // The Empty Chair is looked at, never sat in.
        await place(11 * 16 + 8, 160)
        await expect(page.locator('.prompt')).toContainText('Look at the Empty Chair')
        await act(page, device)
        await expect.poll(async () => (await dialogueState(page)).seen.at(-1)?.speaker).toBe('The Empty Chair')
        expect((await seat(page)).seated).toBe(false)
        await readDialogue(page)
      })

      test('on a bench the Habitica avatar sits on the seat, unsquashed, in front of the backrest', async ({ page }) => {
        await standInSprites(page.context())
        await outfittedPlayer(page)
        await expect.poll(async () => (await seat(page)).avatar).not.toBeNull()
        const standing = (await seat(page)).avatar!
        await warp(page, 'village', 9, 14)
        await expect(page.locator('.prompt')).toContainText('Sit on the bench')
        await act(page, device)
        await expect.poll(async () => (await seat(page)).avatar?.seated).toBe(true)
        const s = await seat(page)
        // The bench's base is the tile bottom (y 224), its depth 224.
        expect(s.seat).toEqual({ x: 152, y: 218, depth: 224.5, facing: 'down' })
        expect(s.avatar!.depth).toBe(224.5)
        expect(Math.abs(s.avatar!.scaleY)).toBe(Math.abs(standing.scaleY))
        expect(s.avatar!.x).toBe(152)
        expect(s.avatar!.y).toBeLessThan(224)
        await snap(page, 'sit-bench-avatar', device)
      })
    })

    test('the demo hero sits on the village bench: on the seat, cut at the lap, not squashed', async ({ page }) => {
      await beginNewJourney(page)
      await warp(page, 'village', 9, 14)
      const standing = await seat(page)
      await expect(page.locator('.prompt')).toContainText('Sit on the bench')
      await act(page, device)
      await expect.poll(async () => (await seat(page)).seated).toBe(true)
      const s = await seat(page)
      expect(s.seat).toEqual({ x: 152, y: 218, depth: 224.5, facing: 'down' })
      expect(s.heroDepth).toBe(224.5)
      expect(s.heroCrop).toBe(true)
      expect(s.heroScale).toEqual(standing.heroScale)
      await snap(page, 'sit-bench', device)
      await expect(page.locator('.prompt')).toContainText('Stand up')
      await act(page, device)
      await expect.poll(async () => (await seat(page)).seated).toBe(false)
      expect((await seat(page)).heroCrop).toBe(false)
    })

    test('choice tags are large and dark enough to read', async ({ page }) => {
      await beginNewJourney(page)
      await page.evaluate(() =>
        (window as unknown as { __fsEmit: (e: string, p: unknown) => void }).__fsEmit('ui:dialogue', {
          id: 'tags',
          speaker: 'Silas',
          lines: ['I measure land in lantern-light, not yards.'],
          choices: [
            { text: 'The deed to Lot 3', note: 'Needs 15 embers', disabled: true },
            { text: 'Raise a cottage', note: '4 embers', action: 'noop' },
            { text: 'Not yet' }
          ]
        })
      )
      await untilChoices(page)
      // Measured once the panel has finished sliding in (it fades up from 0).
      await expect.poll(() => page.locator('.dialogue').evaluate((el) => el.getAnimations().filter((a) => a.playState === 'running').length)).toBe(0)
      const tags = await page.locator('.choice .note').evaluateAll((els) =>
        els.map((el) => {
          const parse = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number)
          const lum = (rgb: number[]) => {
            const [r, g, b] = rgb.map((v) => {
              const c = v / 255
              return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
            })
            return 0.2126 * r + 0.7152 * g + 0.0722 * b
          }
          const st = getComputedStyle(el)
          const fg = lum(parse(st.color))
          const bg = lum(parse(st.backgroundColor))
          let opacity = 1
          for (let n: Element | null = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity)
          return { text: el.textContent, size: parseFloat(st.fontSize), contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05), opacity }
        })
      )
      expect(tags.length).toBe(2)
      for (const t of tags) {
        expect(t.size, t.text!).toBeGreaterThanOrEqual(14)
        expect(t.contrast, t.text!).toBeGreaterThanOrEqual(7)
        expect(t.opacity, t.text!).toBe(1)
      }
      await snap(page, 'choice-tags', device, false)
    })
  })
}

test.describe('reduced motion', () => {
  test.use({ server: true })

  test('with reduced motion the avatar holds still: no breath', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await standInSprites(page.context())
    await outfittedPlayer(page)
    await warp(page, 'village', 18, 14)
    await expect.poll(async () => (await seat(page)).avatar).not.toBeNull()
    for (let i = 0; i < 20; i++) {
      const a = (await seat(page)).avatar!
      expect(a.breath).toBe(0)
      expect(a.step).toBe(0)
      await page.waitForTimeout(200)
    }
  })
})
