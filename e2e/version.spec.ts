import { readFileSync } from 'node:fs'
import { devices } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { allow, newUser, openTitleGuide, pasteAndConnect, routeHabitica, serverState, waitForWorld } from './connected'
import { beginNewJourney, player } from './helpers'

/**
 * The "new version" notice (src/ui/update.svelte.ts). The dev server never
 * checks by itself, so these route /version.json and ask for a check through
 * the dev hook; a different build id than the running one ("dev") is a new
 * version.
 */

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const notice = (page: Page) => page.getByTestId('update-notice')

async function serveBuild(page: Page, build: string): Promise<void> {
  await page.route('**/version.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: '9.9.9', build }) }))
}

const checkNow = (page: Page) => page.evaluate(() => (window as unknown as { __fsDevVersionCheck: () => Promise<void> }).__fsDevVersionCheck())

/** Move the hero a little and ask for a save, which waits 350 ms before it writes. */
async function stepAside(page: Page): Promise<{ x: number; y: number }> {
  const at = await player(page)
  const to = { x: Math.round(at.x) + 40, y: Math.round(at.y) }
  await page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [to.x, to.y] as const)
  return to
}

test('a new build shows a calm notice, waits for an open panel, and stays away once dismissed', async ({ page }) => {
  await beginNewJourney(page)
  await serveBuild(page, 'next-build')

  // The Menu's quiet version line, linking to the changelog.
  await page.keyboard.press('Escape')
  const line = page.getByTestId('version-line')
  await expect(line).toContainText(`Glimway ${VERSION}`)
  await expect(line).toContainText('build dev')
  await expect(line.getByRole('link')).toHaveAttribute('href', 'https://github.com/Solidsilver/glimway/blob/main/CHANGELOG.md')

  // Found while the Menu is open: it waits for the Menu to close.
  await checkNow(page)
  await expect(notice(page)).toBeHidden()
  await page.getByRole('button', { name: 'Back to the road' }).click()
  await expect(notice(page)).toBeVisible()
  await expect(notice(page)).toContainText('A new version of Glimway is ready.')
  // It never takes focus from the game.
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="update-notice"]'))).toBe(false)

  await notice(page).getByRole('button', { name: 'Later' }).click()
  await expect(notice(page)).toBeHidden()
  await checkNow(page)
  await expect(notice(page)).toBeHidden()

  // A later build is news again.
  await serveBuild(page, 'later-build')
  await checkNow(page)
  await expect(notice(page)).toBeVisible()
})

/**
 * Slows the guest save's writes by `window.__slowSaves` ms: opening its
 * database answers late, so the write itself happens late (holding back
 * only the put's answer would leave the data already on disk).
 */
const SLOW_SAVES = () => {
  const open = IDBFactory.prototype.open
  IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory['open']>) {
    const req = open.apply(this, args)
    const ms = (window as unknown as { __slowSaves?: number }).__slowSaves
    if (!ms || args[0] !== 'fingersnap') return req
    let handler: ((e: Event) => void) | null = null
    Object.defineProperty(req, 'onsuccess', { configurable: true, get: () => handler, set: (fn) => (handler = fn) })
    req.addEventListener('success', (e) => setTimeout(() => handler?.call(req, e), ms))
    return req
  }
}

/** HP in the guest save on disk. */
const savedHp = (page: Page) =>
  page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('fingersnap')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<number | undefined>((resolve) => {
        const req = db.transaction('saves').objectStore('saves').get('current')
        req.onsuccess = () => resolve((req.result as { state?: { hp?: number } } | undefined)?.state?.hp)
        req.onerror = () => resolve(undefined)
      })
    } finally {
      db.close()
    }
  })

test('guest Reload: the world holds still, and a hit during the slow final write is saved too', async ({ page }) => {
  await page.addInitScript(SLOW_SAVES)
  await beginNewJourney(page)
  await serveBuild(page, 'next-build')
  await checkNow(page)
  await expect(notice(page)).toBeVisible()
  const hp = Number(await page.locator('[aria-label="Health"]').first().getAttribute('aria-valuenow'))
  await page.evaluate(() => ((window as unknown as { __slowSaves: number }).__slowSaves = 700))
  const reloaded = page.waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame() })
  await notice(page).getByRole('button', { name: 'Reload' }).click()
  // Frozen while it saves: no input, no enemies, no physics.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fsFrame: () => { live: boolean } }).__fsFrame().live)).toBe(false)
  await expect(notice(page).getByRole('button', { name: 'Saving…' })).toBeDisabled()
  // A hit that was already on its way lands while the write is out.
  await page.evaluate(() => (window as unknown as { __fsDevHurt: (n: number) => void }).__fsDevHurt(3))
  await reloaded
  await expect.poll(() => savedHp(page)).toBe(hp - 3)
})

test('odd answers to the check never bother the player', async ({ page }) => {
  await beginNewJourney(page)
  for (const answer of [
    { status: 404, body: 'not found' },
    { status: 200, body: '<!doctype html><title>Glimway</title>' },
    { status: 200, body: '{"status":"ok"}' }
  ]) {
    await page.unrouteAll()
    await page.route('**/version.json', (route) => route.fulfill({ status: answer.status, body: answer.body }))
    await checkNow(page)
  }
  await page.unrouteAll()
  await page.route('**/version.json', (route) => route.abort('internetdisconnected'))
  await checkNow(page)
  await expect(notice(page)).toBeHidden()
  await expect(page.locator('.toast.error')).toHaveCount(0)
})

/** Sign in from the title as a new allowlisted player and start fresh. */
async function freshPlayer(page: Page): Promise<string> {
  const id = newUser()
  allow(id)
  await routeHabitica(page.context())
  await openTitleGuide(page)
  await pasteAndConnect(page, id)
  await waitForWorld(page)
  return id
}

test.describe('phone, short landscape', () => {
  const { defaultBrowserType: _browser, ...phone } = devices['iPhone SE']
  test.use({ ...phone, viewport: { width: 568, height: 320 }, server: true })

  test('568×320: the whole notice, both buttons and the failure copy stay on screen', async ({ page }) => {
    await freshPlayer(page)
    await serveBuild(page, 'next-build')
    await checkNow(page)
    await expect(notice(page)).toBeVisible()
    await page.route('**/api/progress', (route) => route.abort('internetdisconnected'))
    await stepAside(page)
    await notice(page).getByRole('button', { name: 'Reload' }).click()
    await expect(page.getByTestId('update-held')).toContainText('only on this device')
    await page.waitForTimeout(400) // the slide-in
    const inside = async (sel: ReturnType<Page['locator']>) => {
      const b = (await sel.boundingBox())!
      return b.x >= 0 && b.y >= 0 && b.x + b.width <= 568 && b.y + b.height <= 320
    }
    expect(await inside(notice(page))).toBe(true)
    expect(await inside(notice(page).getByRole('button', { name: 'Reload' }))).toBe(true)
    expect(await inside(notice(page).getByRole('button', { name: 'Later' }))).toBe(true)
    expect(await inside(page.getByTestId('update-held'))).toBe(true)
    // Nothing inside it is cut off either.
    expect(await notice(page).evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
  })
})

test.describe('connected', () => {
  test.use({ server: true })

  test('Reload uploads the pending save first, then reloads', async ({ page }) => {
    await freshPlayer(page)
    await serveBuild(page, 'next-build')
    await checkNow(page)
    await expect(notice(page)).toBeVisible()

    // What happens, in order: the upload must be answered before the page goes.
    const events: string[] = []
    page.on('requestfinished', (r) => {
      if (r.url().endsWith('/api/progress')) events.push('progress')
    })
    page.on('request', (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) events.push('reload')
    })
    const to = await stepAside(page)
    await notice(page).getByRole('button', { name: 'Reload' }).click()
    await expect.poll(() => events.includes('reload')).toBe(true)
    expect(events.slice(0, events.indexOf('reload'))).toContain('progress')
    const s = await serverState(page)
    expect(s.body.state.position).toEqual(to)
  })

  test('Reload waits, and says so, while the save cannot reach the server', async ({ page }) => {
    await freshPlayer(page)
    await serveBuild(page, 'next-build')
    await checkNow(page)
    await expect(notice(page)).toBeVisible()

    await page.evaluate(() => ((window as unknown as { __stayed: boolean }).__stayed = true))
    await page.route('**/api/progress', (route) => route.abort('internetdisconnected'))
    await stepAside(page)
    await notice(page).getByRole('button', { name: 'Reload' }).click()
    await expect(page.getByTestId('update-held')).toContainText('only on this device')
    await expect(notice(page).getByRole('button', { name: 'Reload' })).toBeEnabled()
    expect(await page.evaluate(() => (window as unknown as { __stayed?: boolean }).__stayed)).toBe(true)
    // Play goes on: the freeze is lifted.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __fsFrame: () => { live: boolean } }).__fsFrame().live)).toBe(true)
  })
})
