import { expect, test, type Page } from './fixtures'
import { allow, newUser, openTitleGuide, pasteAndConnect, routeHabitica, waitForWorld } from './connected'
import { fallCamp, warp, waitForWilds, wilds, worldTileOf, type WildsDump, readDialogue, settled, expectToast, chunkWhole, spotsAround, standFor, expectTarget, parkCreatures } from './helpers'

/**
 * The open map on screen: the Tangle by the gate, the Whitequiet, a camp, a
 * node harvest, a POI, a lantern — desktop and phone. SCREENS=1 saves images
 * to .agent/screens/.
 */

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
    // In: just inside the Commons gate.
    await warp(page, 'outdoors', 2, 22)
    await waitForWilds(page)
    await shot(page, `20-wilds-entry-${device}`)

    // The Tangle's middle (its 3×3 is the window), then the Whitequiet's.
    await warp(page, 'outdoors', 12, -12)
    await waitForWilds(page)
    await shot(page, `21-wilds-tangle-middle-${device}`)

    const pickOne = (d: WildsDump, kind: string, where: (e: WildsDump['entities'][number]) => boolean = () => true) => {
      const target = d.entities.find((e) => e.kind === kind && where(e))
      if (!target) throw new Error(`no ${kind} generated in this epoch`)
      return target
    }
    /** Keep the target nearest (no other claim owns the prompt). */
    const approach = async (target: WildsDump['entities'][number]) => {
      const d = await wilds(page)
      const at = worldTileOf(target)
      const others = d.entities.filter((e) => e.claimable && e.id !== target.id).map(worldTileOf)
      const spot = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
        .map(([ox, oy]) => [ox, oy, Math.min(...others.map((e) => Math.hypot(e.tx - at.tx - ox, e.ty - at.ty - oy)), 99)])
        .sort((a, b) => (b[2] as number) - (a[2] as number))[0]
      expect(spot, `an approach to ${target.id}`).toBeDefined()
      return spot
    }
    const warpTo = async (target: WildsDump['entities'][number]) => {
      const spot = await approach(target)
      const at = worldTileOf(target)
      await warp(page, 'outdoors', at.tx + (spot[0] as number), at.ty + (spot[1] as number))
      await waitForWilds(page)
      expect((await wilds(page)).chunk).toEqual(target.chunk)
    }

    // A camp with its people (the walk-in line) and, after the fight, the claim.
    const camp = pickOne(await wilds(page), 'camp')
    await warpTo(camp)
    await shot(page, `22-wilds-camp-${device}`)
    // Its room's fight, finished on the dev server; the near read then names it claimable.
    await fallCamp(page, camp.id)
    // Stand where the camp (not a neighbouring node) owns the prompt.
    expect((await wilds(page)).chunk).toEqual(camp.chunk)
    const spot = await approach(camp)
    const campAt = worldTileOf(camp)
    await page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [(campAt.tx + (spot[0] as number)) * TILE + 8, (campAt.ty + (spot[1] as number)) * TILE + 8])
    await expect(page.locator('.prompt')).toContainText(/Claim the camp/i)
    await shot(page, `23-wilds-camp-claim-${device}`)
    await page.keyboard.press('e')
    await expectToast(page, /camp is yours/i)

    // A node harvest: the verb prompt, then the loot.
    const node = pickOne(await wilds(page), 'node')
    await warpTo(node)
    await expect(page.locator('.prompt')).toContainText(/chop|cut|gather|pry/i)
    await shot(page, `24-wilds-node-prompt-${device}`)
    await page.keyboard.press('e')
    await expectToast(page, /harvested/i)
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
    await readDialogue(page)

    // The Whitequiet: the deep drift's look.
    await warp(page, 'outdoors', 12, -4 * 24 + 12)
    await waitForWilds(page)
    await shot(page, `28-wilds-whitequiet-${device}`)

    // The fallen-hero lantern: the quarantined test below.
  })
}

/** Fall in the Tangle; the fallen-hero lantern waits where the hero fell. */
async function fallAndFindLantern(page: Page, device: string): Promise<void> {
  const fellAt = (await wilds(page)).position
  await page.evaluate((n) => (window as unknown as { __fsDevHurt: (n: number) => void }).__fsDevHurt(n), 999)
  // The collapse wakes the hero back in the village; wait for it to settle.
  await page.waitForFunction(() => (window as unknown as { __fsSafety?: () => { areaId: string } | null }).__fsSafety?.()?.areaId === 'village', undefined, { timeout: 20_000 })
  await settled(page, { area: 'village' })
  await warp(page, 'outdoors', Math.floor(fellAt.x / TILE), Math.floor(fellAt.y / TILE))
  await waitForWilds(page)
  await expect.poll(async () => (await wilds(page)).lanterns.some((l) => l.own && !l.lit)).toBe(true)
  const lantern = (await wilds(page)).lanterns.find((l) => l.own && !l.lit)!
  // The chunk must have finished registering its points. Ask the game's
  // election for a usable spot, including diagonals, rather than racing the
  // sliced build or assuming one of four cardinal tiles wins over a node.
  const tile = { tx: lantern.x, ty: lantern.y }
  await chunkWhole(page, tile)
  await parkCreatures(page)
  const why: string[] = []
  const stood = await standFor(page, `wilds:${lantern.id}`, await spotsAround(page, tile), why)
  expect(stood, `a spot elects the own fallen lantern: ${why.join(' ')}`).not.toBeNull()
  await expectTarget(page, `wilds:${lantern.id}`)
  await expect(page.locator('.prompt')).toContainText(/lantern/i)
  await shot(page, `27-wilds-lantern-${device}`)
}

// A fall in the Tangle sends the defeat report; the recovery's upload used to
// be built on the revision before the report's answer, land as a stale write,
// and its answer put the hero back in the Tangle at 0 HP (bugs #3,
// tests/link.test.ts).
for (const [device, vp] of sizes) {
  test(`wilds screens: the fallen-hero lantern (${device})`, async ({ page, context }) => {
    await page.setViewportSize(vp)
    const id = newUser()
    allow(id)
    await routeHabitica(context)
    await openTitleGuide(page)
    await pasteAndConnect(page, id)
    await waitForWorld(page)
    // The Tangle's middle, away from the gate (a camp's knockback can't send us home).
    await warp(page, 'outdoors', 12, -12)
    await waitForWilds(page)
    await fallAndFindLantern(page, device)
  })
}

