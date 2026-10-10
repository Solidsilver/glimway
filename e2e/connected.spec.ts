import { expect, test, type Page } from './fixtures'
import { goIn, openLibraryShelves, setHour } from './room-helpers'
import { adminInvite,
  allow,
  linkStatus,
  newUser,
  openTitleGuide,
  pasteAndConnect,
  pastOpening,
  routeHabitica,
  serverState, accountOf,
  setHabitica,
  syncFromMenu,
  waitForWorld, CONTRACT, served } from './connected'
import { readDialogue, settleWarden, talkThrough, untilChoices, warp, waitForArea, waitForLive, expectToast } from './helpers'

/**
 * Connected play against the real Go server (playwright.config.ts starts it
 * with a fresh database, plus the fake Habitica its login reads). Each test
 * signs in as a new Habitica id, so tests share no server state.
 */
const hud = (page: Page) => page.locator('.hud .glims')
const hurt = (page: Page, n: number) => page.evaluate((d) => (window as unknown as { __fsDevHurt: (n: number) => void }).__fsDevHurt(d), n)
const leaseGate = (page: Page) => page.getByRole('alertdialog', { name: 'Playing on another device' })
const shownHp = (page: Page) => page.evaluate(() => Number(document.querySelector('[aria-label="Health"]')?.getAttribute('aria-valuenow')))

/** The account's outbox record on this device (C2's store; keyed by the server's account id), or null. */
async function cacheRecord(page: Page, account: string): Promise<Record<string, any> | null> {
  return page.evaluate(async (account) => {
    const dbs = await indexedDB.databases()
    if (!dbs.some((d) => d.name === 'glimway-outbox')) return null
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('glimway-outbox')
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
    try {
      if (!db.objectStoreNames.contains('records')) return null
      // Keyed by [account, device]: this page's device is the only one here.
      return await new Promise<Record<string, any> | null>((resolve) => {
        const r = db.transaction('records').objectStore('records').getAll()
        r.onsuccess = () => resolve((r.result as Record<string, any>[]).find((rec) => rec.account === account) ?? null)
        r.onerror = () => resolve(null)
      })
    } finally {
      db.close()
    }
  }, account)
}

/** Read a conversation to its end (replies included). */
async function finishTalking(page: Page): Promise<void> {
  await readDialogue(page)
  await expect(page.getByRole('dialog', { name: /Conversation/ })).toBeHidden()
}

/** Open the lantern's conversation (its prompt must be up) and read on to the replies. */
async function lanternReplies(page: Page): Promise<void> {
  await expect(page.locator('.prompt')).toContainText('Rest by the lantern')
  await waitForLive(page)
  await page.keyboard.press('e')
  await expect(page.getByRole('dialog', { name: /Conversation/ })).toBeVisible()
  await untilChoices(page)
}

/** Sign in from the title as a new allowlisted player, past the opening. */
async function freshPlayer(page: Page): Promise<string> {
  const id = newUser()
  allow(id)
  await routeHabitica(page.context())
  await openTitleGuide(page)
  await pasteAndConnect(page, id)
  await waitForWorld(page)
  await pastOpening(page, id)
  return id
}

/** Sync from the Menu, wait for the toast, and go back to the road. */
async function sync(page: Page, toast: RegExp): Promise<void> {
  await syncFromMenu(page)
  await expectToast(page, toast)
  await page.getByRole('button', { name: 'Back to the road' }).click()
}

test('login + fresh start: the guide signs in, the world starts fresh, a sync pays the welcome', { tag: '@smoke' }, async ({ page }) => {
  const id = await freshPlayer(page)
  const s = await serverState(page)
  expect(s.status).toBe(200)
  // The account is the sign-in's subject (its id the server's own).
  expect(s.body.accountId).toBe(accountOf(id))
  // Fresh imports the verified Habitica vitals right away, under the name Habitica reports.
  expect(s.body.displayName).toBe('Tansy')
  expect(s.body.vitalsSource).toBe('imported')
  await sync(page, /glims into your hand/)
  await expect(hud(page)).toHaveText('3')
  await expect.poll(async () => (await serverState(page)).body.state.glims).toBe(3)
  // Nothing about the token reached the connected cache.
  await expect.poll(() => cacheRecord(page, accountOf(id))).not.toBeNull()
  const cache = JSON.stringify(await cacheRecord(page, accountOf(id)))
  expect(cache).toContain(id)
  expect(cache).not.toContain('99999999-ffff')
})

test('invite-only: denied without a code, then joins with one', async ({ page, context }) => {
  const id = newUser() // not on the allowlist
  await routeHabitica(context)
  await openTitleGuide(page)
  await pasteAndConnect(page, id)
  const box = page.getByTestId('invite-only')
  await expect(box).toContainText('This world is invite-only')
  await box.getByLabel('Invite code').fill('not-a-real-code')
  await box.getByRole('button', { name: 'Join with this code' }).click()
  await expect(box).toContainText('That invite code didn’t work')
  // Readable codes work in any case, with spaces instead of hyphens.
  const code = adminInvite()
  expect(code).toMatch(/^[a-z]+(-[a-z]+){5}-\d{4}$/)
  await box.getByLabel('Invite code').fill(`  ${code.toUpperCase().replace(/-/g, ' ')} `)
  await box.getByRole('button', { name: 'Join with this code' }).click()
  await waitForWorld(page)
  expect((await serverState(page)).body.accountId).toBe(accountOf(id))
})


test('sync credits glims from the server, counted against its XP mark', async ({ page }) => {
  const id = await freshPlayer(page)
  await sync(page, /glims into your hand/)
  await expect(hud(page)).toHaveText('3')
  // 25 more XP on Habitica: lifetime 45 → 70, three glim steps.
  await setHabitica(id, { exp: 45 })
  await sync(page, /3 glims caught the light/)
  await expect(hud(page)).toHaveText('6')
  const s = (await serverState(page)).body
  expect(s.state.glims).toBe(6)
  expect(s.state.xpGlims).toBe(3)
  // The same profile again pays nothing.
  await sync(page, /All caught up/)
  await expect(hud(page)).toHaveText('6')
})

test('a rest is paid on the server, and the world waits for its answer', async ({ page }) => {
  await freshPlayer(page)
  await sync(page, /glims into your hand/)
  await hurt(page, 6)
  // The hurt goes up with the next report (about every 10 s).
  await expect.poll(async () => (await serverState(page)).body.state.hp, { timeout: 15_000 }).toBeLessThan(41)
  await warp(page, 'village', 11, 13)
  await lanternReplies(page)
  const choice = page.locator('.choice', { hasText: 'Rest by the flame' })
  await expect(choice).toBeEnabled()
  await page.keyboard.press('1')
  await expectToast(page, 'Warm and rested')
  await expect(hud(page)).toHaveText('1')
  const s = (await serverState(page)).body
  expect(s.state.glims).toBe(1)
  expect(s.state.hp).toBe(s.state.maxHp)
})

test('quest glims come from the server once the story upload lands', async ({ page }) => {
  await freshPlayer(page)
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await warp(page, 'ruin', 15, 3)
  await talkThrough(page, /Copy the naming from the stone/)
  await settleWarden(page)
  await expectToast(page, '+2 glims. A little warmth from the road.')
  await expect(hud(page)).toHaveText('2')
  const s = (await serverState(page)).body
  expect(s.state.quests['lantern-road']).toBe('guardian-defeated')
  expect(s.state.glims).toBe(2)
})

test('the shared library shelf: a connected donation lands on the world shelf and stays', async ({ page }) => {
  await freshPlayer(page)
  // Elara keeps the library from :10 to :40, and takes donations at her desk (both clocks).
  await setHour(page, { minute: 20, server: true })
  // Find a paper and donate it straight away: the donation must wait for the
  // upload that carries the find, so there's no wait for the server here.
  // Hold the pickup (its own operation now) for a while so the donation is
  // sure to race it (review: donate must flush first; the outbox keeps order).
  await page.route('**/api/papers/take', async (route) => {
    await new Promise((r) => setTimeout(r, 4000))
    await route.continue()
  })
  await warp(page, 'village', 25, 15)
  await expect(page.locator('.prompt')).toContainText('Pick up the folded paper')
  await page.keyboard.press('e')
  await expectToast(page, 'Found: A Page from Pip’s Copybook')

  // Elara's desk, in the reading room.
  await goIn(page, 'in:village:library')
  await page.evaluate(() => (window as unknown as { __fsDevLibrary: (p: { focus: 'donate' }) => void }).__fsDevLibrary({ focus: 'donate' }))
  const library = page.getByRole('dialog', { name: 'Hearthwick Library' })
  const desk = library.getByTestId('library-donate')
  await desk.locator('[data-donate="pip-copybook-warden-corrections"]').click()
  // The donation waits for the held upload carrying the find.
  await expect(library.getByTestId('library-message')).toContainText('is on the shelves now', { timeout: 20_000 })
  await desk.getByRole('button', { name: /The shelves/ }).click()
  await expect(library.getByText('14 of 52')).toBeVisible()
  await expect(library.getByRole('button', { name: /First donated by Tansy/ })).toBeVisible()
  await page.unroute('**/api/papers/take')

  // The world's shelf on the server: one donation, credited by the server.
  const shelf = await page.request.get('/api/library', CONTRACT)
  expect(shelf.status()).toBe(200)
  const body = await served(shelf)
  expect(body.shelves).toHaveLength(1)
  expect(body.shelves[0].paperId).toBe('pip-copybook-warden-corrections')
  expect(body.shelves[0].donatedBy).toBe('Tansy')
  expect(Number.isNaN(Date.parse(body.shelves[0].donatedAt))).toBe(false)

  // The shared shelf survives a reload without a local donation flag.
  await page.keyboard.press('Escape')
  await page.reload()
  await page.getByRole('button', { name: /Continue/ }).click()
  // A reload inside comes back inside the reading room.
  await waitForArea(page, 'in:village:library')
  await openLibraryShelves(page)
  await expect(page.getByRole('dialog', { name: 'Hearthwick Library' }).getByText('14 of 52')).toBeVisible()
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
  await sync(page, /glims into your hand/)
  await context.setOffline(true)
  await hurt(page, 5)
  // The next report (about every 10 s) finds no connection.
  await expect(page.getByTestId('net-offline')).toBeVisible({ timeout: 15_000 })
  // Story still moves offline.
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  // Spends say they need a connection.
  await warp(page, 'village', 11, 13)
  await lanternReplies(page)
  const choice = page.locator('.choice', { hasText: 'Rest by the flame' })
  await expect(choice).toBeDisabled()
  await expect(choice).toContainText('Needs a connection')
  await page.keyboard.press('2')
  await finishTalking(page)
  const localHp = await shownHp(page)

  await context.setOffline(false)
  await expect.poll(() => linkStatus(page), { timeout: 20_000 }).toBe('online')
  await expect(page.getByTestId('net-offline')).toBeHidden()
  // Back online, what was played offline goes up at once (not at the next
  // 10 s report): the world holds it within moments of reconnecting.
  await expect.poll(async () => Math.ceil((await serverState(page)).body.state.hp), { timeout: 5_000 }).toBe(localHp) // vitals uploaded as-is
  expect((await serverState(page)).body.state.quests['lantern-road']).toBe('accepted')
  await expect(page.getByTestId('link-notice')).toBeHidden()
})


test('invites: create a code (shown once), list it, revoke it, and respect the limit', async ({ page }) => {
  await freshPlayer(page)
  await page.keyboard.press('Escape')
  const card = page.getByTestId('invites-card')
  // The quota shows up front, including explicit admission flags and an empty list.
  const initialInvites = await page.request.get('/api/invites', CONTRACT)
  expect(initialInvites.ok()).toBe(true)
  expect(await initialInvites.json()).toEqual({ invites: [], remaining: 5, outstandingLimit: 3, partyWorld: false, partyAdmitted: false })
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

test('logout ends the session and returns to the title', async ({ page }) => {
  await freshPlayer(page)
  await page.keyboard.press('Escape')
  await page.getByTestId('world-card').getByRole('button', { name: 'Log out' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Log out' }).click()
  // Back to the title: the connect card, and nothing playing.
  await expect(page.getByTestId('connect-hero')).toBeVisible()
  expect((await serverState(page)).status).toBe(401)
})

test('a returning player is signed in by the cookie alone', async ({ page, context }) => {
  await freshPlayer(page)
  await hurt(page, 4)
  await expect.poll(() => shownHp(page)).toBeLessThan(41)
  const hp = await shownHp(page)
  // The hurt goes up with the next report (about every 10 s).
  await expect.poll(async () => Math.ceil((await serverState(page)).body.state.hp), { timeout: 15_000 }).toBe(hp)
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
  // The world can't take the quest step for a while: it stays in the outbox.
  // (A refusal would be final; an unreachable server keeps the step queued.)
  let held = 0
  await page.route('**/api/quest/step', (route) => {
    held += 1
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable' } }) })
  })
  const queuedStep = (rec: Record<string, any> | null) => (rec?.entries ?? []).some((e: { path: string }) => e.path === '/api/quest/step')
  await warp(page, 'village', 16, 14)
  await talkThrough(page, /Talk to Mara/)
  await expect.poll(() => held).toBeGreaterThan(0)
  await expect.poll(async () => queuedStep(await cacheRecord(page, accountOf(id)))).toBe(true)
  await page.keyboard.press('Escape')
  await page.getByTestId('world-card').getByRole('button', { name: 'Log out' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('hasn’t reached your world yet')
  await dialog.getByRole('button', { name: 'Log out' }).click()
  await expect(page.getByTestId('connect-hero')).toBeVisible()
  expect((await serverState(page)).status).toBe(401)
  // The outbox keeps the unsent step for the next sign-in on this device.
  const kept = await cacheRecord(page, accountOf(id))
  expect(kept?.loggedOut).toBe(true)
  expect(queuedStep(kept)).toBe(true)

  // The server is fine again; signing in brings the step up.
  await page.unroute('**/api/quest/step')
  await page.getByTestId('connect-hero').click()
  await page.getByRole('button', { name: 'I have them' }).click()
  await pasteAndConnect(page, id)
  // Logout released that session's lease, so signing straight back in plays at once.
  await waitForWorld(page)
  await expect(leaseGate(page)).toHaveCount(0)
  await expect.poll(async () => (await serverState(page)).body.state.quests['lantern-road']).toBe('accepted')
})

test('a logout with nothing unsent clears the device copy', async ({ page }) => {
  const id = await freshPlayer(page)
  await expect.poll(() => cacheRecord(page, accountOf(id))).not.toBeNull()
  await page.keyboard.press('Escape')
  await page.getByTestId('world-card').getByRole('button', { name: 'Log out' }).click()
  await expect(page.getByRole('alertdialog')).toContainText('Your journey stays in your world')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Log out' }).click()
  await expect(page.getByTestId('connect-hero')).toBeVisible()
  expect(await cacheRecord(page, accountOf(id))).toBeNull()
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

test('closing the tab still sends the last steps (review 6)', async ({ page }) => {
  await freshPlayer(page)
  const before = Math.ceil((await serverState(page)).body.state.hp)
  // Playwright's request interception (the Habitica route) can drop a closing
  // page's keepalive request: lift it, so the test sees what a browser sends.
  await page.context().unrouteAll({ behavior: 'ignoreErrors' })
  await hurt(page, 6)
  // Close inside the 350 ms save debounce: only the page-hide upload can carry it.
  await page.close({ runBeforeUnload: true })
  await expect
    .poll(async () => Math.ceil((await serverState(page)).body.state.hp), { timeout: 10_000 })
    .toBeLessThan(before)
})
