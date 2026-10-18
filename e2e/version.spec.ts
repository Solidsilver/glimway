import { readFileSync } from 'node:fs'
import { devices } from '@playwright/test'
import { expect, test, type Page } from './fixtures'
import { serverState } from './connected'
import { frames, player } from './helpers'
import { freshPlayer } from './home-helpers'

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

const place = (page: Page, at: { x: number; y: number }) =>
  page.evaluate(([x, y]) => (window as unknown as { __fsDevPlace: (x: number, y: number) => void }).__fsDevPlace(x, y), [at.x, at.y] as const)

/** Where the hero stands, rounded as the save writes it, once two samples a few frames apart agree. */
async function settled(page: Page): Promise<{ x: number; y: number }> {
  const at = async () => {
    const p = await player(page)
    return { x: Math.round(p.x), y: Math.round(p.y) }
  }
  let last = await at()
  await expect
    .poll(async () => {
      await frames(page, 3)
      const now = await at()
      const same = now.x === last.x && now.y === last.y
      last = now
      return same
    }, { message: 'the hero comes to rest' })
    .toBe(true)
  return last
}

/**
 * Move the hero a little and ask for a save, which waits 350 ms before it
 * writes. Returns where the hero landed: a collision can nudge the placement,
 * so a nudged hero is placed again where it rests, and the save names that.
 */
async function stepAside(page: Page): Promise<{ x: number; y: number }> {
  const at = await player(page)
  const to = { x: Math.round(at.x) + 40, y: Math.round(at.y) }
  await place(page, to)
  const landed = await settled(page)
  if (landed.x === to.x && landed.y === to.y) return to
  await place(page, landed)
  return settled(page)
}

test('a new build shows a calm notice, waits for an open panel, and stays away once dismissed', async ({ page }) => {
  await freshPlayer(page)
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

test('odd answers to the check never bother the player', async ({ page }) => {
  await freshPlayer(page)
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

test.describe('phone, short landscape', () => {
  const { defaultBrowserType: _browser, ...phone } = devices['iPhone SE']
  test.use({ ...phone, viewport: { width: 568, height: 320 } })

  test('568×320: the whole notice, both buttons and the failure copy stay on screen', async ({ page }) => {
    await freshPlayer(page)
    await serveBuild(page, 'next-build')
    await checkNow(page)
    await expect(notice(page)).toBeVisible()
    await page.route('**/api/report', (route) => route.abort('internetdisconnected'))
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

test.describe('in a world', () => {
  test('Reload uploads the pending save first, then reloads', async ({ page }) => {
    await freshPlayer(page)
    await serveBuild(page, 'next-build')
    await checkNow(page)
    await expect(notice(page)).toBeVisible()

    // What happens, in order: the upload must be answered before the page goes.
    const events: string[] = []
    page.on('requestfinished', (r) => {
      if (r.url().endsWith('/api/report')) events.push('report')
    })
    page.on('request', (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) events.push('reload')
    })
    const to = await stepAside(page)
    await notice(page).getByRole('button', { name: 'Reload' }).click()
    await expect.poll(() => events.includes('reload')).toBe(true)
    expect(events.slice(0, events.indexOf('reload'))).toContain('report')
    const s = await serverState(page)
    expect(s.body.state.position, `the server's saved place (the hero landed at ${to.x},${to.y})`).toEqual(to)
  })

  test('Reload waits, and says so, while the save cannot reach the server', async ({ page }) => {
    await freshPlayer(page)
    await serveBuild(page, 'next-build')
    await checkNow(page)
    await expect(notice(page)).toBeVisible()

    await page.evaluate(() => ((window as unknown as { __stayed: boolean }).__stayed = true))
    await page.route('**/api/report', (route) => route.abort('internetdisconnected'))
    await stepAside(page)
    await notice(page).getByRole('button', { name: 'Reload' }).click()
    await expect(page.getByTestId('update-held')).toContainText('only on this device')
    await expect(notice(page).getByRole('button', { name: 'Reload' })).toBeEnabled()
    expect(await page.evaluate(() => (window as unknown as { __stayed?: boolean }).__stayed)).toBe(true)
    // Play goes on: the freeze is lifted.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __fsFrame: () => { live: boolean } }).__fsFrame().live)).toBe(true)
  })

  test('a reload-needed answer shows the reload notice, and Reload goes', async ({ page }) => {
    await freshPlayer(page)
    // The world server refuses this page's contract: strip the header with
    // page.route, so A's real gate answers 409 reload-needed.
    await page.route('**/api/profile', (route) => {
      const headers = { ...route.request().headers() }
      delete headers['x-glimway-contract']
      return route.continue({ headers })
    })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Sync character' }).click()
    // The notice waits for an open panel to close.
    await page.getByRole('button', { name: 'Back to the road' }).click()
    await expect(notice(page)).toBeVisible()
    await expect(notice(page)).toContainText('This page is older than the world server.')
    // Nothing can be written: Reload goes (no save-first settle to hold it).
    const reloaded = page.waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame() })
    await notice(page).getByRole('button', { name: 'Reload' }).click()
    await reloaded
    // The page is back at the title (nothing was held for a settle).
    await expect(page.getByTestId('continue-world')).toBeVisible({ timeout: 15_000 })
  })
})
