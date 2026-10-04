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
  __fsDevStrike?: (n: number, type?: string) => void
}

/** Fresh start: title screen → "Wander as a guest" → world is live. */
export async function beginNewJourney(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: /Wander as a guest/ }).click()
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

/** Dev strike on every enemy, or only those of one type ('wisp' | 'beetle' | 'guardian'). */
export async function strikeAll(page: Page, n: number, type?: string): Promise<void> {
  await page.evaluate(([d, t]) => (window as unknown as Hooks).__fsDevStrike!(d as number, t as string | undefined), [n, type] as const)
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

/** Fake credentials for the mocked Habitica API (see mockHabitica). */
export const MOCK_USER = '11111111-aaaa-4bbb-8ccc-222222222222'
export const MOCK_TOKEN = '99999999-ffff-4eee-9ddd-888888888888'

/**
 * Stand-in for habitica.com: answers GET /api/v3/user with the "Tansy" fixture
 * when the headers match the mock credentials, 401 otherwise. Returns the list
 * of request header pairs seen, so tests can assert what was (not) sent.
 */
export async function mockHabitica(page: Page): Promise<{ calls: Array<{ user: string; key: string }> }> {
  const { FIXTURES_BY_KEY } = await import('../src/lib/habitica/fixtures.ts')
  const calls: Array<{ user: string; key: string }> = []
  await page.route('https://habitica.com/api/v3/user*', async (route) => {
    const h = route.request().headers()
    calls.push({ user: h['x-api-user'], key: h['x-api-key'] })
    if (h['x-api-user'] !== MOCK_USER || h['x-api-key'] !== MOCK_TOKEN) {
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ success: false }) })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ success: true, data: FIXTURES_BY_KEY.lowLevel.user })
    })
  })
  return { calls }
}

/** Raw read of the credentials database (null when absent or empty). */
export async function rememberedRecord(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases()
    if (!dbs.some((d) => d.name === 'fingersnap-credentials')) return null
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('fingersnap-credentials')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise((resolve) => {
        const req = db.transaction('credentials').objectStore('credentials').get('habitica')
        req.onsuccess = () => resolve(req.result ?? null)
        req.onerror = () => resolve(null)
      })
    } finally {
      db.close()
    }
  })
}

/** The whole `fingersnap` save record as JSON text. */
export async function savedRecordText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('fingersnap')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<string>((resolve) => {
        const req = db.transaction('saves').objectStore('saves').get('current')
        req.onsuccess = () => resolve(JSON.stringify(req.result ?? null))
        req.onerror = () => resolve('')
      })
    } finally {
      db.close()
    }
  })
}
