import { expect, test, type Page } from './fixtures'
import { allow, newUser, openTitleGuide, pasteAndConnect, routeHabitica, waitForWorld } from './connected'
import { beginNewJourney, holdUntil, warp, waitForWilds, wilds, type WildsDump } from './helpers'
import { chunkAreaId } from '../src/game/wilds/regions.ts'

/**
 * The Tangle on screen: chunks, a camp, a node harvest, a POI, a lantern —
 * desktop and phone. SCREENS=1 saves images to .agent/screens/.
 */
test.use({ server: true })

const sizes = [
  ['desktop', { width: 1200, height: 760 }],
  ['phone', { width: 390, height: 844 }]
] as const

const TILE = 16

async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.SCREENS) return
  await page.waitForTimeout(400)
  await page.screenshot({ path: `.agent/screens/${name}.png` })
}

const materialSum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0)

for (const [device, vp] of sizes) {
  test(`wilds screens (${device})`, async ({ page, context }) => {
    test.setTimeout(150_000)
    await page.setViewportSize(vp)
    const id = newUser()
    allow(id)
    await routeHabitica(context)
    await openTitleGuide(page)
    await pasteAndConnect(page, id)
    await waitForWorld(page)

    // In: the entry chunk by the commons gap.
    await warp(page, 'wilds', 2, 22)
    await waitForWilds(page)
    await shot(page, `20-wilds-entry-${device}`)

    // A neighboring chunk through the east gap.
    await warp(page, chunkAreaId(1, 1), 21, 12)
    await holdUntil(page, 'ArrowRight', async () => (await wilds(page)).chunk.cx === 2)
    await waitForWilds(page)
    await shot(page, `21-wilds-east-chunk-${device}`)

    const dump = await wilds(page)
    const pickOne = (d: WildsDump, kind: string, where: (e: WildsDump['entities'][number]) => boolean = () => true) => {
      const target = d.entities.find((e) => e.kind === kind && where(e))
      if (!target) throw new Error(`no ${kind} generated in this epoch`)
      return target
    }
    /** Warp to the spot beside `target` where it (not a neighbour) owns the prompt. */
    const warpTo = async (target: WildsDump['entities'][number]) => {
      const d = await wilds(page)
      const others = d.entities.filter((e) => e.claimable && e.id !== target.id && e.chunk.cx === target.chunk.cx && e.chunk.cy === target.chunk.cy)
      const spot = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
        .map(([ox, oy]) => [ox, oy, Math.min(...others.map((e) => Math.hypot(e.tx - target.tx - ox, e.ty - target.ty - oy)), 99)])
        .sort((a, b) => (b[2] as number) - (a[2] as number))[0]
      await warp(page, chunkAreaId(target.chunk.cx, target.chunk.cy), target.tx + (spot[0] as number), target.ty + (spot[1] as number))
      await waitForWilds(page)
    }

    // A camp with its people (the walk-in line) and, after the fight, the claim.
    const camp = pickOne(await wilds(page), 'camp')
    await warpTo(camp)
    await shot(page, `22-wilds-camp-${device}`)
    await page.evaluate(() => (window as unknown as { __fsDevStrike: (n: number) => void }).__fsDevStrike(999))
    // Stand where the camp (not a neighbouring node) owns the prompt.
    const others = (await wilds(page)).entities.filter((e) => e.claimable && e.id !== camp.id && e.chunk.cx === camp.chunk.cx && e.chunk.cy === camp.chunk.cy)
    const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([ox, oy]) => [ox, oy, Math.min(...others.map((e) => Math.hypot(e.tx - camp.tx - ox, e.ty - camp.ty - oy)), 99)])
      .sort((a, b) => (b[2] as number) - (a[2] as number))[0]
    await page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [(camp.tx + (spot[0] as number)) * TILE + 8, (camp.ty + (spot[1] as number)) * TILE + 8])
    await expect(page.locator('.prompt')).toContainText(/Claim the camp/i)
    await shot(page, `23-wilds-camp-claim-${device}`)
    await page.keyboard.press('e')
    await expect(page.locator('.toast', { hasText: /camp is yours/i }).first()).toBeVisible()

    // A node harvest: the verb prompt, then the loot.
    const node = pickOne(await wilds(page), 'node')
    await warpTo(node)
    await expect(page.locator('.prompt')).toContainText(/chop|cut|gather|pry/i)
    await shot(page, `24-wilds-node-prompt-${device}`)
    await page.keyboard.press('e')
    await expect(page.locator('.toast', { hasText: /harvested/i }).first()).toBeVisible()
    expect(materialSum((await wilds(page)).materials)).toBeGreaterThan(0)
    await shot(page, `25-wilds-node-harvested-${device}`)

    // A POI: the study prompt and the charted reading.
    const poi = pickOne(await wilds(page), 'poi')
    await warpTo(poi)
    await expect(page.locator('.prompt')).toContainText(/Study the /i)
    await page.keyboard.press('e')
    const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
    await expect(dialogue).toBeVisible()
    await shot(page, `26-wilds-poi-${device}`)
    for (let i = 0; i < 12 && (await dialogue.isVisible()); i++) {
      await page.keyboard.press('e')
      await page.waitForTimeout(200)
    }

    // Defeat: the fallen-hero lantern waits where the hero fell.
    await page.evaluate((n) => (window as unknown as { __fsDevHurt: (n: number) => void }).__fsDevHurt(n), 999)
    // The collapse wakes the hero back in the village; wait for it to settle.
    await page.waitForFunction(() => window.__fsSafety?.()?.areaId === 'village', undefined, { timeout: 20_000 })
    await page.waitForTimeout(800)
    await warp(page, 'wilds', 2, 22)
    await waitForWilds(page)
    await expect.poll(async () => (await wilds(page)).lanterns.some((l) => l.own && !l.lit)).toBe(true)
    const lantern = (await wilds(page)).lanterns.find((l) => l.own && !l.lit)!
    await warp(page, chunkAreaId(Math.floor(lantern.x / 24), Math.floor(lantern.y / 24)), (lantern.x % 24) - 1, lantern.y % 24)
    await waitForWilds(page)
    await expect(page.locator('.prompt')).toContainText(/lantern/i)
    await shot(page, `27-wilds-lantern-${device}`)
  })
}

// One guest shot for the local-mode look (materials live in the pack).
test('wilds screens: guest entry', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 760 })
  await beginNewJourney(page)
  await warp(page, 'wilds', 2, 22)
  await waitForWilds(page)
  await shot(page, '28-wilds-guest-entry')
})
