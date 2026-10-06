import { expect, test, type Page } from './fixtures'
import { allow, linkCaughtUp, newUser, openTitleGuide, pasteAndConnect, routeHabitica, serverState, sql, waitForWorld } from './connected'
import { beginNewJourney, holdUntil, warp, waitForWilds, wilds, type WildsDump, readDialogue, settled, expectToast } from './helpers'
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
    // A fixed world for the screens: a random epoch can lack a point of
    // interest (about 1 in 500), and the same land makes screens comparable.
    // Its first camp, node and POI all have open ground beside them.
    const worldId = (await serverState(page)).body.worldId as string
    sql(`UPDATE worlds SET seed='wilds-screens-0' WHERE id='${worldId}' AND id NOT IN (SELECT world_id FROM region_epochs);`)
    const region = await page.request.get('/api/wilds/region/inner-1')
    expect((await region.json()).epoch.worldSeed).toBe('wilds-screens-0')

    // In: the entry chunk by the commons gap.
    await warp(page, 'wilds', 2, 22)
    await waitForWilds(page)
    await shot(page, `20-wilds-entry-${device}`)

    // A neighboring chunk through the east gap.
    await warp(page, chunkAreaId(1, 1), 21, 12)
    await holdUntil(page, 'ArrowRight', async () => (await wilds(page)).chunk.cx === 2)
    await waitForWilds(page)
    await shot(page, `21-wilds-east-chunk-${device}`)

    const pickOne = (d: WildsDump, kind: string, where: (e: WildsDump['entities'][number]) => boolean = () => true) => {
      const target = d.entities.find((e) => e.kind === kind && where(e))
      if (!target) throw new Error(`no ${kind} generated in this epoch`)
      return target
    }
    /** Keep the target nearest, with room for combat knockback before an exit. */
    const approach = async (target: WildsDump['entities'][number]) => {
      const d = await wilds(page)
      const others = d.entities.filter((e) => e.claimable && e.id !== target.id && e.chunk.cx === target.chunk.cx && e.chunk.cy === target.chunk.cy)
      const spot = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
        // Camps can spawn at tile 21. Its south neighbour is next to an
        // exit; a hit there can change chunks during the settling wait.
        .filter(([ox, oy]) => target.tx + ox >= 3 && target.tx + ox <= 20 && target.ty + oy >= 3 && target.ty + oy <= 20)
        .map(([ox, oy]) => [ox, oy, Math.min(...others.map((e) => Math.hypot(e.tx - target.tx - ox, e.ty - target.ty - oy)), 99)])
        .sort((a, b) => (b[2] as number) - (a[2] as number))[0]
      expect(spot, `safe approach to ${target.id}`).toBeDefined()
      return spot
    }
    const warpTo = async (target: WildsDump['entities'][number]) => {
      const spot = await approach(target)
      await warp(page, chunkAreaId(target.chunk.cx, target.chunk.cy), target.tx + (spot[0] as number), target.ty + (spot[1] as number))
      await waitForWilds(page)
      expect((await wilds(page)).chunk).toEqual(target.chunk)
    }

    // A camp with its people (the walk-in line) and, after the fight, the claim.
    const camp = pickOne(await wilds(page), 'camp')
    await warpTo(camp)
    await shot(page, `22-wilds-camp-${device}`)
    await page.evaluate(() => (window as unknown as { __fsDevStrike: (n: number) => void }).__fsDevStrike(999))
    // Stand where the camp (not a neighbouring node) owns the prompt.
    expect((await wilds(page)).chunk).toEqual(camp.chunk)
    const spot = await approach(camp)
    await page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [(camp.tx + (spot[0] as number)) * TILE + 8, (camp.ty + (spot[1] as number)) * TILE + 8])
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

    // The fallen-hero lantern: the quarantined test below.
  })
}

/** Fall in the Tangle; the fallen-hero lantern waits where the hero fell. */
async function fallAndFindLantern(page: Page, device: string): Promise<void> {
  await linkCaughtUp(page)
  await page.evaluate((n) => (window as unknown as { __fsDevHurt: (n: number) => void }).__fsDevHurt(n), 999)
  // The collapse wakes the hero back in the village; wait for it to settle.
  await page.waitForFunction(() => window.__fsSafety?.()?.areaId === 'village', undefined, { timeout: 20_000 })
  await settled(page, { area: 'village' })
  await warp(page, 'wilds', 2, 22)
  await waitForWilds(page)
  await expect.poll(async () => (await wilds(page)).lanterns.some((l) => l.own && !l.lit)).toBe(true)
  const lantern = (await wilds(page)).lanterns.find((l) => l.own && !l.lit)!
  // An adjacent tile inside the lantern's chunk (the defeat spot can sit
  // on a chunk edge, where tile 0's neighbour would be out of bounds).
  const lx = lantern.x % 24
  const ly = lantern.y % 24
  const beside = [[-1, 0], [1, 0], [0, -1], [0, 1]]
    .map(([ox, oy]) => [lx + ox, ly + oy])
    .find(([tx, ty]) => tx >= 1 && ty >= 1 && tx <= 22 && ty <= 22)!
  await warp(page, chunkAreaId(Math.floor(lantern.x / 24), Math.floor(lantern.y / 24)), beside[0], beside[1])
  await waitForWilds(page)
  await expect(page.locator('.prompt')).toContainText(/lantern/i)
  await shot(page, `27-wilds-lantern-${device}`)
}

// Known product bug, quarantined (see .agent/REPORT.md): falling in the
// Tangle while connected sends the defeat report and a progress upload
// together; about one fall in ten, the hero comes to in the Tangle at 0 HP
// instead of in the village (the upload's stale answer appears to put the
// area back during the collapse). wilds.spec.ts still checks the lantern
// after a fall. Remove fixme with the fix.
for (const [device, vp] of sizes) {
  test.fixme(`wilds screens: the fallen-hero lantern (${device})`, async ({ page, context }) => {
    await page.setViewportSize(vp)
    const id = newUser()
    allow(id)
    await routeHabitica(context)
    await openTitleGuide(page)
    await pasteAndConnect(page, id)
    await waitForWorld(page)
    await warp(page, 'wilds', 2, 22)
    await waitForWilds(page)
    await fallAndFindLantern(page, device)
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
