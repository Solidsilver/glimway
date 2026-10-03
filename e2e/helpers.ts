import { expect, type Page } from '@playwright/test'

/**
 * Playtest helpers. Movement and interaction go through real keyboard input;
 * the dev hooks are only used to skip long walks (__fsDevWarp) and long fights
 * (__fsDevStrike), and the read-only hooks for assertions.
 */

type AreaId = 'village' | 'woodland' | 'ruin'
type Hooks = {
  __fsPlayer?: () => { x: number; y: number }
  __fsWorld?: () => { areaId: AreaId; widthPx: number; heightPx: number; bounds: { x: number; y: number; w: number; h: number } }
  __fsSafety?: () => { areaId: AreaId; transitioning: boolean }
  __fsDevWarp?: (area: AreaId, tx: number, ty: number) => void
  __fsDevStrike?: (n: number) => void
}

/** Fresh start: title screen → "Begin your journey" → world is live. */
export async function beginNewJourney(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: /Begin your journey/ }).click()
  await waitForArea(page, 'village')
}

export async function waitForArea(page: Page, area: AreaId): Promise<void> {
  await page.waitForFunction((a) => {
    const s = (window as unknown as Hooks).__fsSafety?.()
    return !!s && s.areaId === a && !s.transitioning
  }, area)
  // Let the fade-in and the input cool-down settle before driving keys.
  await page.waitForTimeout(700)
}

export async function warp(page: Page, area: AreaId, tx: number, ty: number): Promise<void> {
  await page.evaluate(([a, x, y]) => (window as unknown as Hooks).__fsDevWarp!(a, x, y), [area, tx, ty] as const)
  await page.waitForFunction(() => (window as unknown as Hooks).__fsSafety?.().transitioning === true).catch(() => {})
  await waitForArea(page, area)
}

export async function player(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => (window as unknown as Hooks).__fsPlayer!())
}

export async function world(page: Page) {
  return page.evaluate(() => (window as unknown as Hooks).__fsWorld!())
}

export async function strikeAll(page: Page, n: number): Promise<void> {
  await page.evaluate((d) => (window as unknown as Hooks).__fsDevStrike!(d), n)
}

/** Hold a key for a while (real keydown/keyup, so Phaser sees it held). */
export async function hold(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key)
  await page.waitForTimeout(ms)
  await page.keyboard.up(key)
}

/** The saved quest stage, read straight from IndexedDB. */
export async function savedStage(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('fingersnap')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      const rec = await new Promise<{ state?: { quest?: string } } | undefined>((resolve) => {
        const req = db.transaction('saves').objectStore('saves').get('current')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(undefined)
      })
      return rec?.state?.quest
    } finally {
      db.close()
    }
  })
}

export async function expectStage(page: Page, stage: string): Promise<void> {
  await expect.poll(() => savedStage(page), { timeout: 10_000 }).toBe(stage)
}

/**
 * Press E at an interactable (its prompt must be showing), then read the
 * conversation through: E finishes/advances lines, and the first reply is
 * picked by number key whenever choices appear.
 */
export async function talkThrough(page: Page, prompt: RegExp): Promise<void> {
  await expect(page.locator('.prompt')).toContainText(prompt)
  await page.keyboard.press('e')
  const dialogue = page.getByRole('dialog', { name: /Conversation with/ })
  await expect(dialogue).toBeVisible()
  for (let i = 0; i < 40 && (await dialogue.isVisible()); i++) {
    if (await page.locator('.choice').first().isVisible().catch(() => false)) await page.keyboard.press('1')
    else await page.keyboard.press('e')
    await page.waitForTimeout(250)
  }
  await expect(dialogue).toBeHidden()
}
