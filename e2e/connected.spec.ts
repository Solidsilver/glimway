import { expect, test, type Page } from './fixtures'
import {
  adminInvite,
  allow,
  linkStatus,
  newUser,
  openTitleGuide,
  pasteAndConnect,
  routeHabitica,
  serverState,
  setHabitica,
  syncFromMenu,
  waitForWorld
} from './connected'
import { beginNewJourney, expectStage, savedStage, strikeAll, talkThrough, warp, waitForArea } from './helpers'

/**
 * Connected play against the real Go server (playwright.config.ts starts it
 * with a fresh database, plus the fake Habitica its login reads). Each test
 * signs in as a new Habitica id, so tests share no server state.
 */
test.use({ server: true })

const hud = (page: Page) => page.locator('.hud .embers')
const hurt = (page: Page, n: number) => page.evaluate((d) => (window as unknown as { __fsDevHurt: (n: number) => void }).__fsDevHurt(d), n)
const leaseGate = (page: Page) => page.getByRole('alertdialog', { name: 'Playing on another device' })
const shownHp = (page: Page) => page.evaluate(() => Number(document.querySelector('[aria-label="Health"]')?.getAttribute('aria-valuenow')))

/** The account's record in the connected cache (null when absent). */
async function cacheRecord(page: Page, id: string): Promise<Record<string, any> | null> {
  return page.evaluate(async (key) => {
    const dbs = await indexedDB.databases()
    if (!dbs.some((d) => d.name === 'fingersnap-connected')) return null
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('fingersnap-connected')
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
    try {
      if (!db.objectStoreNames.contains('records')) return null
      return await new Promise<Record<string, any> | null>((resolve) => {
        const r = db.transaction('records').objectStore('records').get(key)
        r.onsuccess = () => resolve((r.result as Record<string, any> | undefined) ?? null)
        r.onerror = () => resolve(null)
      })
    } finally {
      db.close()
    }
  }, `acct:${id}`)
}

/** Read a conversation to its end (replies included). */
async function finishTalking(page: Page): Promise<void> {
  const dialogue = page.getByRole('dialog', { name: /Conversation/ })
  for (let i = 0; i < 12 && (await dialogue.isVisible()); i++) {
    await page.keyboard.press('e')
    await page.waitForTimeout(200)
  }
  await expect(dialogue).toBeHidden()
}

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

/** Sync from the Menu, wait for the toast, and go back to the road. */
async function sync(page: Page, toast: RegExp): Promise<void> {
  await syncFromMenu(page)
  await expect(page.locator('.toast', { hasText: toast })).toBeVisible()
  await page.getByRole('button', { name: 'Back to the road' }).click()
}

test('login + fresh start: the guide signs in, the world starts fresh, a sync pays the welcome', async ({ page }) => {
  const id = await freshPlayer(page)
  const s = await serverState(page)
  expect(s.status).toBe(200)
  expect(s.body.saveOrigin).toBe('fresh')
  expect(s.body.habiticaId).toBe(id)
  // Fresh imports the verified Habitica vitals right away.
  expect(s.body.vitalsSource).toBe('imported')
  await sync(page, /embers into your hand/)
  await expect(hud(page)).toHaveText('3')
  await expect.poll(async () => (await serverState(page)).body.state.embers).toBe(3)
  // Nothing about the token reached the connected cache.
  await expect.poll(() => cacheRecord(page, id)).not.toBeNull()
  const cache = JSON.stringify(await cacheRecord(page, id))
  expect(cache).toContain(id)
  expect(cache).not.toContain('99999999-ffff')
})

test('login + bring save: a guest journey moves into the world and the guest save stays', async ({ page, context }) => {
  const id = newUser()
  allow(id)
  await routeHabitica(context)
  await beginNewJourney(page)
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await expectStage(page, 'accepted')

  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'I have them' }).click()
  await pasteAndConnect(page, id)
  const origin = page.getByRole('dialog', { name: 'Welcome, Tansy' })
  await expect(origin).toBeVisible()
  await expect(origin).toContainText('Your story, discoveries, and where you are.')
  await expect(origin).toContainText('Start fresh')
  await origin.getByRole('button', { name: /Bring this device’s save/ }).click()
  await waitForWorld(page)
  await expect(page.locator('.toast', { hasText: 'came with you' })).toBeVisible()

  const s = await serverState(page)
  expect(s.body.saveOrigin).toBe('migrated')
  expect(s.body.state.quest).toBe('accepted')
  expect(await savedStage(page)).toBe('accepted') // the guest save is untouched
})

test('invite-only: denied without a code, then joins with one', async ({ page, context }) => {
  const id = newUser() // not on the allowlist
  await routeHabitica(context)
  await openTitleGuide(page)
  await pasteAndConnect(page, id)
  const box = page.getByTestId('invite-only')
  await expect(box).toContainText('This world is invite-only')
  await expect(box.getByRole('button', { name: 'Play on this device instead' })).toBeVisible()
  await box.getByLabel('Invite code').fill('not-a-real-code')
  await box.getByRole('button', { name: 'Join with this code' }).click()
  await expect(box).toContainText('That invite code didn’t work')
  // Readable codes work in any case, with spaces instead of hyphens.
  const code = adminInvite()
  expect(code).toMatch(/^[a-z]+(-[a-z]+){5}-\d{4}$/)
  await box.getByLabel('Invite code').fill(`  ${code.toUpperCase().replace(/-/g, ' ')} `)
  await box.getByRole('button', { name: 'Join with this code' }).click()
  await waitForWorld(page)
  expect((await serverState(page)).body.habiticaId).toBe(id)
})

test('invite-only: the player can still play on this device', async ({ page, context }) => {
  await routeHabitica(context)
  await openTitleGuide(page)
  await pasteAndConnect(page, newUser())
  await page.getByTestId('invite-only').getByRole('button', { name: 'Play on this device instead' }).click()
  await expect(page.getByTestId('hero-card')).toContainText('Tansy')
  await page.getByRole('button', { name: 'Begin your journey' }).click()
  await waitForArea(page, 'village')
  expect(await linkStatus(page)).toBeNull() // a guest journey with the Habitica hero
  expect((await serverState(page)).status).toBe(401)
})

test('sync credits embers from the server, counted against its XP mark', async ({ page }) => {
  const id = await freshPlayer(page)
  await sync(page, /embers into your hand/)
  await expect(hud(page)).toHaveText('3')
  // 25 more XP on Habitica: lifetime 45 → 70, three ember steps.
  await setHabitica(id, { exp: 45 })
  await sync(page, /\+3 embers — from the XP you earned on Habitica/)
  await expect(hud(page)).toHaveText('6')
  const s = (await serverState(page)).body
  expect(s.state.embers).toBe(6)
  expect(s.state.xpEmbers).toBe(3)
  // The same profile again pays nothing.
  await sync(page, /All caught up/)
  await expect(hud(page)).toHaveText('6')
})

test('a rest is paid on the server, and the world waits for its answer', async ({ page }) => {
  await freshPlayer(page)
  await sync(page, /embers into your hand/)
  await hurt(page, 6)
  await expect.poll(async () => (await serverState(page)).body.state.hp).toBeLessThan(41)
  await warp(page, 'village', 11, 13)
  await expect(page.locator('.prompt')).toContainText('Rest by the lantern')
  await page.keyboard.press('e')
  const choice = page.locator('.choice', { hasText: 'Rest by the flame' })
  for (let i = 0; i < 10 && !(await choice.isVisible()); i++) {
    await page.keyboard.press('e')
    await page.waitForTimeout(200)
  }
  await expect(choice).toBeEnabled()
  await page.keyboard.press('1')
  await expect(page.locator('.toast', { hasText: 'Warm and rested' })).toBeVisible()
  await expect(hud(page)).toHaveText('1')
  const s = (await serverState(page)).body
  expect(s.state.embers).toBe(1)
  expect(s.state.hp).toBe(s.state.maxHp)
})

test('quest embers come from the server once the story upload lands', async ({ page }) => {
  await freshPlayer(page)
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await warp(page, 'ruin', 15, 3)
  await talkThrough(page, /rubbing of the marker/)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fsEnemies: () => unknown[] }).__fsEnemies().length)).toBeGreaterThan(0)
  await strikeAll(page, 999)
  await expect(page.locator('.toast', { hasText: '+2 embers — a little warmth from the road.' })).toBeVisible()
  await expect(hud(page)).toHaveText('2')
  const s = (await serverState(page)).body
  expect(s.state.quest).toBe('guardian-defeated')
  expect(s.state.embers).toBe(2)
})

test('the shared library shelf: a connected donation lands on the world shelf and stays', async ({ page }) => {
  await freshPlayer(page)
  // Find a paper, let the save reach the server, then donate it at the library.
  await warp(page, 'village', 25, 15)
  await expect(page.locator('.prompt')).toContainText('Pick up the folded paper')
  await page.keyboard.press('e')
  await expect(page.locator('.toast', { hasText: 'Found: A Page from Pip’s Copybook' })).toBeVisible()
  await expect.poll(async () => (await serverState(page)).body.state.flags).toContain('paper:pip-copybook-warden-corrections')

  await warp(page, 'village', 3, 18)
  await expect(page.locator('.prompt')).toContainText('Enter the Hearthwick Library')
  await page.keyboard.press('e')
  const library = page.getByRole('dialog', { name: 'Hearthwick Library' })
  await expect(library).toBeVisible()
  await library.locator('[data-donate="pip-copybook-warden-corrections"]').click()
  await expect(library.getByText('12 of 39')).toBeVisible()
  await expect(library.getByRole('button', { name: /First donated by Tansy/ })).toBeVisible()

  // The world's shelf on the server: one donation, credited by the server.
  const shelf = await page.request.get('/api/library')
  expect(shelf.status()).toBe(200)
  const body = await shelf.json()
  expect(body.shelves).toHaveLength(1)
  expect(body.shelves[0].paperId).toBe('pip-copybook-warden-corrections')
  expect(body.shelves[0].donatedBy).toBe('Tansy')
  expect(Number.isNaN(Date.parse(body.shelves[0].donatedAt))).toBe(false)

  // The shared shelf survives a reload without a local donation flag.
  await page.keyboard.press('Escape')
  await page.reload()
  await page.getByRole('button', { name: /Continue/ }).click()
  await waitForArea(page, 'village')
  await warp(page, 'village', 3, 18)
  await page.keyboard.press('e')
  await expect(page.getByRole('dialog', { name: 'Hearthwick Library' }).getByText('12 of 39')).toBeVisible()
})

test('a second tab finds the journey playing elsewhere, and either tab can take over', async ({ page, context }) => {
  await freshPlayer(page)
  const other = await context.newPage()
  await other.goto('/')
  await other.getByTestId('continue-world').click()
  await expect(leaseGate(other)).toBeVisible()
  await expect(leaseGate(other)).toContainText('Only one place can play at a time.')
  await other.getByRole('button', { name: 'Take over here' }).click()
  await waitForWorld(other)

  // The first tab learns at its next write, and offers to take it back.
  await hurt(page, 3)
  await expect(leaseGate(page)).toBeVisible()
  expect(await linkStatus(page)).toBe('superseded')
  await page.getByRole('button', { name: 'Take over here' }).click()
  await expect(leaseGate(page)).toBeHidden()
  await expect.poll(() => linkStatus(page)).toBe('online')

  await hurt(other, 3)
  await expect(leaseGate(other)).toBeVisible()
  await other.close()
})

test('offline play keeps going, spends wait for a connection, and reconnecting uploads it', async ({ page, context }) => {
  await freshPlayer(page)
  await sync(page, /embers into your hand/)
  await context.setOffline(true)
  await hurt(page, 5)
  await expect(page.getByTestId('net-offline')).toBeVisible()
  // Story still moves offline.
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  // Spends say they need a connection.
  await warp(page, 'village', 11, 13)
  await page.keyboard.press('e')
  const choice = page.locator('.choice', { hasText: 'Rest by the flame' })
  for (let i = 0; i < 10 && !(await choice.isVisible()); i++) {
    await page.keyboard.press('e')
    await page.waitForTimeout(200)
  }
  await expect(choice).toBeDisabled()
  await expect(choice).toContainText('Needs a connection')
  await page.keyboard.press('2')
  await finishTalking(page)
  const localHp = await shownHp(page)

  await context.setOffline(false)
  await expect.poll(() => linkStatus(page), { timeout: 20_000 }).toBe('online')
  await expect(page.getByTestId('net-offline')).toBeHidden()
  const s = (await serverState(page)).body
  expect(s.state.quest).toBe('accepted')
  expect(Math.ceil(s.state.hp)).toBe(localHp) // nothing changed elsewhere: vitals uploaded as-is
  await expect(page.getByTestId('link-notice')).toBeHidden()
})

test('offline play meets newer progress from another device: story merges, vitals come from the server', async ({ page, context, browser, baseURL }) => {
  const id = await freshPlayer(page)
  await context.setOffline(true)
  await hurt(page, 5)
  await expect(page.getByTestId('net-offline')).toBeVisible()
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)

  // Meanwhile, another device signed in to the same account plays on.
  const otherContext = await browser.newContext({ storageState: await context.storageState(), baseURL })
  const other = await otherContext.newPage()
  await other.goto('/')
  await other.getByTestId('continue-world').click()
  await expect(leaseGate(other)).toBeVisible()
  await other.getByRole('button', { name: 'Take over here' }).click()
  await waitForWorld(other)
  await hurt(other, 12)
  await expect.poll(() => shownHp(other)).toBeLessThan(35)
  const otherHp = await shownHp(other)
  await expect.poll(async () => Math.ceil((await serverState(other)).body.state.hp)).toBe(otherHp)

  // Back online: the other device is active, so this one must choose to take over.
  await context.setOffline(false)
  await expect(leaseGate(page)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Take over here' }).click()
  await expect(page.getByTestId('link-notice')).toContainText('You played somewhere else while this device was offline.')
  const s = (await serverState(page)).body
  expect(s.state.quest).toBe('accepted') // story from this device kept
  expect(Math.ceil(s.state.hp)).toBe(otherHp) // health from the latest session
  await expect.poll(() => shownHp(page)).toBe(otherHp)
  // The offline copy is kept until the notice is dismissed.
  const recovery = async () => !!(await cacheRecord(page, id))?.recovery
  await expect.poll(recovery).toBe(true)
  await page.getByRole('button', { name: 'Got it' }).click()
  await expect.poll(recovery).toBe(false)
  await otherContext.close()
})

test('invites: create a code (shown once), list it, revoke it, and respect the limit', async ({ page }) => {
  await freshPlayer(page)
  await page.keyboard.press('Escape')
  const card = page.getByTestId('invites-card')
  // The quota shows up front.
  await expect(card.getByTestId('invite-budget')).toContainText('5 of 5 invite codes left')
  await expect(card.getByTestId('invite-budget')).toContainText('Up to 3 can wait at once.')
  await card.getByRole('button', { name: 'Create an invite code' }).click()
  await expect(card.getByTestId('invite-code')).toContainText('only shown once')
  // A readable code, shown as words; selecting the text gives the real code.
  const code = (await card.locator('code').textContent())?.replace(/\s+/g, '') ?? ''
  expect(code).toMatch(/^[a-z]+(-[a-z]+){5}-\d{4}$/)
  await expect(card.locator('code .w')).toHaveCount(6)
  await expect(card.getByTestId('invite-budget')).toContainText('4 of 5 invite codes left')
  await expect(card.locator('.list:not(.used) li')).toHaveCount(1)
  await card.getByRole('button', { name: 'Create an invite code' }).click()
  await card.getByRole('button', { name: 'Create an invite code' }).click()
  await expect(card.locator('.list:not(.used) li')).toHaveCount(3)
  // At the waiting limit the button says why instead of failing.
  await expect(card.getByRole('button', { name: 'Create an invite code' })).toBeDisabled()
  await expect(card.getByTestId('invite-why')).toContainText('You have 3 codes waiting already')
  await card.getByRole('button', { name: 'Revoke' }).first().click()
  await expect(card.locator('.list:not(.used) li')).toHaveCount(2)
  // Revoked codes still count against the lifetime budget.
  await expect(card.getByTestId('invite-budget')).toContainText('2 of 5 invite codes left')
  await card.getByRole('button', { name: 'Create an invite code' }).click()
  await card.getByRole('button', { name: 'Revoke' }).first().click()
  await card.getByRole('button', { name: 'Create an invite code' }).click()
  await expect(card.getByTestId('invite-budget')).toContainText('0 of 5 invite codes left')
  await expect(card.getByRole('button', { name: 'Create an invite code' })).toBeDisabled()
  await expect(card.getByTestId('invite-why')).toContainText('made all 5')
})

test('logout ends the session and returns to guest play', async ({ page }) => {
  await freshPlayer(page)
  await page.keyboard.press('Escape')
  await page.getByTestId('world-card').getByRole('button', { name: 'Log out' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Log out' }).click()
  // Back to this device's guest journey (the title guide started one).
  await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible()
  await expect(page.getByTestId('continue-world')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign in to your world' })).toBeVisible()
  expect((await serverState(page)).status).toBe(401)
})

test('a returning player is signed in by the cookie alone', async ({ page, context }) => {
  await freshPlayer(page)
  await hurt(page, 4)
  await expect.poll(() => shownHp(page)).toBeLessThan(41)
  const hp = await shownHp(page)
  await expect.poll(async () => Math.ceil((await serverState(page)).body.state.hp)).toBe(hp)
  const fresh = await context.newPage()
  await page.close()
  await fresh.goto('/')
  await expect(fresh.getByTestId('continue-world')).toContainText('Tansy')
  await fresh.getByTestId('continue-world').click()
  // The last tab was active moments ago: taking over is still the player's call.
  await expect(leaseGate(fresh)).toBeVisible()
  await fresh.getByRole('button', { name: 'Take over here' }).click()
  await waitForWorld(fresh)
  await expect.poll(() => shownHp(fresh)).toBe(hp)
})

test('logout with unsent progress keeps it on the device, and the next sign-in uploads it (review 1)', async ({ page }) => {
  const id = await freshPlayer(page)
  // The server refuses uploads for a while: the story step stays unsent.
  await page.route('**/api/progress', (route) =>
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invalid-progress' } }) })
  )
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await expect(page.locator('.toast', { hasText: 'didn’t accept that save' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByTestId('world-card').getByRole('button', { name: 'Log out' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('hasn’t reached your world yet')
  await dialog.getByRole('button', { name: 'Log out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in to your world' })).toBeVisible()
  expect((await serverState(page)).status).toBe(401)
  const kept = await cacheRecord(page, id)
  expect(kept?.dirty).toBe(true)
  expect(kept?.loggedOut).toBe(true)
  expect(kept?.state.quest).toBe('accepted')

  // The server is fine again; signing in brings the step up.
  await page.unroute('**/api/progress')
  await page.getByRole('button', { name: 'Sign in to your world' }).click()
  await page.getByRole('button', { name: 'I have them' }).click()
  await pasteAndConnect(page, id)
  // Logout released that session's lease, so signing straight back in plays at once.
  await waitForWorld(page)
  await expect(leaseGate(page)).toHaveCount(0)
  await expect.poll(async () => (await serverState(page)).body.state.quest).toBe('accepted')
})

test('a logout with nothing unsent clears the device copy', async ({ page }) => {
  const id = await freshPlayer(page)
  await expect.poll(() => cacheRecord(page, id)).not.toBeNull()
  await page.keyboard.press('Escape')
  await page.getByTestId('world-card').getByRole('button', { name: 'Log out' }).click()
  await expect(page.getByRole('alertdialog')).toContainText('Your journey stays in your world')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Log out' }).click()
  await expect(page.getByRole('button', { name: 'Sign in to your world' })).toBeVisible()
  expect(await cacheRecord(page, id)).toBeNull()
})

test('a duplicated tab gets its own play id, so it must take over like any other (review 2)', async ({ page, context }) => {
  await freshPlayer(page)
  const original = await page.evaluate(() => sessionStorage.getItem('fingersnap:client-id'))
  expect(original).toBeTruthy()
  // "Duplicate tab" copies sessionStorage into the new page.
  const dup = await context.newPage()
  await dup.addInitScript((cid) => {
    if (!sessionStorage.getItem('fingersnap:dup-seeded')) {
      sessionStorage.setItem('fingersnap:client-id', cid)
      sessionStorage.setItem('fingersnap:dup-seeded', '1')
    }
  }, original!)
  await dup.goto('/')
  await expect.poll(() => dup.evaluate(() => sessionStorage.getItem('fingersnap:client-id'))).not.toBe(original)
  await dup.getByTestId('continue-world').click()
  await expect(leaseGate(dup)).toBeVisible()
  expect(await linkStatus(page)).toBe('online')
  // The original keeps its id across a reload (no other live page holds it).
  await dup.close()
  await page.reload()
  await expect(page.getByTestId('continue-world')).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('fingersnap:client-id'))).toBe(original)
})

test('closing the tab still sends the last steps (review 6)', async ({ page, context }) => {
  await freshPlayer(page)
  const before = Math.ceil((await serverState(page)).body.state.hp)
  await hurt(page, 6)
  // Close inside the 350 ms save debounce: only the page-hide upload can carry it.
  await page.close({ runBeforeUnload: true })
  await expect
    .poll(async () => Math.ceil((await (await context.request.get('/api/state')).json()).state.hp), { timeout: 10_000 })
    .toBeLessThan(before)
})

test.describe('no server', () => {
  test.use({ server: false })

  test('guest path with the server down: guest play and the local Habitica connect work as before', async ({ page, context }) => {
    await routeHabitica(context)
    await openTitleGuide(page)
    await pasteAndConnect(page, newUser())
    await expect(page.getByTestId('hero-card')).toContainText('Tansy')
    await expect(page.getByTestId('invite-only')).toHaveCount(0)
    await page.getByRole('button', { name: 'Begin your journey' }).click()
    await waitForArea(page, 'village')
    expect(await linkStatus(page)).toBeNull()
    await expect(page.locator('.hud .embers')).toHaveText('3')
  })

  test('a static host that answers /api with a page is treated as no server', async ({ page, baseURL }) => {
    // Page routes win over the fixture's context-level abort.
    await page.route(
      (url) => url.host === new URL(baseURL!).host && url.pathname.startsWith('/api/'),
      (route) => route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><p>Not found' })
    )
    await beginNewJourney(page)
    expect(await linkStatus(page)).toBeNull()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('world-card')).toHaveCount(0)
  })
})
