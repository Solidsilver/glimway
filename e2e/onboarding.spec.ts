import { expect, test, type Page } from './fixtures'
import { allow, CONTRACT, newUser, routeHabitica, setHabitica, TOKEN, waitForWorld } from './connected'
import { waitForLive } from './helpers'

/**
 * The title and its connect guide (no guest start any more): paste parsing,
 * the guide tabs, and Remember/Forget. The world server and the fake
 * Habitica are the worker's own (e2e/fixtures.ts, e2e/server/backend.ts).
 */

const labeled = (user: string) => `User ID: ${user}\nAPI Token: ${TOKEN}`

/** The title's connect guide, at its first step. */
async function openGuide(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: /Play as your Habitica hero/ }).click()
  await expect(page.getByRole('heading', { name: 'Find your User ID and API Token' })).toBeVisible()
}

/** The guide at its paste step. */
async function openPaste(page: Page): Promise<void> {
  await openGuide(page)
  await page.getByRole('button', { name: 'I have them' }).click()
}

test('the title asks for the Habitica hero; there is no guest start', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('connect-hero')).toContainText('Play as your Habitica hero')
  await expect(page.getByTestId('connect-hero')).toContainText('every 10 XP you earn in Habitica becomes an ember')
  await expect(page.getByRole('button', { name: /Wander as a guest/ })).toHaveCount(0)
})

test('guide tabs show the verified per-platform steps', async ({ page }) => {
  await openGuide(page)
  // (the tabs live on step 1; the paste tests step on themselves)
  await expect(page.getByRole('tab', { name: 'Website' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.unverified')).toHaveCount(0)
  await expect(page.locator('.how')).toContainText('click Learn More')
  await page.getByRole('tab', { name: 'iOS app' }).click()
  await expect(page.locator('.unverified')).toHaveCount(0)
  await expect(page.locator('.how')).toContainText('My Account')
  await expect(page.locator('.how')).toContainText('Copy Token')
  await page.getByRole('tab', { name: 'Android app' }).click()
  await expect(page.locator('.how')).toContainText('gear icon')
  await expect(page.getByText('Older app versions may differ.')).toBeVisible()
  await page.getByText('Why does it need my token?').click()
  await expect(page.getByText('Habitica API tokens aren’t read-only')).toBeVisible()
  // The token reaches the world server once, at sign-in, and is never kept.
  // 0.6: the server also sees it in a top-up or a gear check the player starts (purse-and-wardrobe.md 6.6).
  await expect(page.locator('.guide')).toContainText('sees it at sign-in to prove your account, and in a top-up or a gear check you start')
})

test('labeled paste → the world signs in → play', async ({ page }) => {
  const id = newUser()
  allow(id)
  await setHabitica(id, { name: 'Tansy' })
  await routeHabitica(page.context())
  await openPaste(page)
  await page.getByLabel('Paste both values').fill(labeled(id))
  // The sign-in carries the account straight into the world: the lease holds.
  await page.getByRole('button', { name: 'Connect' }).click()
  await waitForWorld(page)
})

test('unlabeled paste → preview → wrong order is refused → swap → connected', async ({ page }) => {
  const id = newUser()
  allow(id)
  await setHabitica(id, { name: 'Tansy' })
  await routeHabitica(page.context())
  await openPaste(page)
  // Token first: the parser files it as the User ID, so the check fails.
  await page.getByLabel('Paste both values').fill(`${TOKEN}\n${id}`)
  await expect(page.getByTestId('preview-user')).toHaveText(`${TOKEN.slice(0, 4)}…${TOKEN.slice(-4)}`)
  await page.getByRole('button', { name: 'Looks right — Connect' }).click()
  await expect(page.getByRole('alert')).toContainText('wrong way round')
  await page.getByRole('button', { name: 'Swap' }).click()
  await expect(page.getByTestId('preview-user')).toHaveText(`${id.slice(0, 4)}…${id.slice(-4)}`)
  await page.getByRole('button', { name: 'Looks right — Connect' }).click()
  await waitForWorld(page)
})

test('bad shapes say what was found', async ({ page }) => {
  await openPaste(page)
  const box = page.getByLabel('Paste both values')
  await box.fill(newUser())
  await expect(page.getByRole('alert')).toContainText('one ID')
  await expect(page.getByRole('button', { name: 'Connect' })).toBeDisabled()
  const user = newUser()
  await box.fill(`${user} ${TOKEN} ${user.replace('1', '3')}`)
  await expect(page.getByRole('alert')).toContainText('3 IDs')
})

test('remember → a new visit signs in without a paste → forget', async ({ page }) => {
  const id = newUser()
  allow(id)
  await setHabitica(id, { name: 'Tansy' })
  await routeHabitica(page.context())
  await openPaste(page)
  await page.getByLabel('Paste both values').fill(labeled(id))
  await page.getByLabel('Remember on this device').check()
  await expect(page.getByText('could read it', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Connect' }).click()
  await waitForWorld(page)

  // A new visit whose sign-in ended (a logout, an expired cookie): the
  // remembered details sign in without a paste.
  await page.request.delete('/api/session', CONTRACT)
  await page.reload()
  await page.getByTestId('connect-hero').click()
  const remembered = page.getByTestId('signin-remembered')
  await expect(remembered).toBeVisible()
  await remembered.click()
  await waitForWorld(page)

  // The Menu knows what was remembered.
  await waitForLive(page)
  await page.keyboard.press('Escape')
  await expect(page.getByText('Remembered on this device.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible()

  // Disconnect asks about forgetting; Forget clears the store.
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(page.getByText('Forget your details too?')).toBeVisible()
  await page.getByRole('button', { name: 'Disconnect and forget' }).click()
  await expect(page.getByText('Remembered on this device.')).toBeHidden()
  await page.reload()
  // The world is still there (the cookie holds); the details are not remembered.
  await expect(page.getByTestId('continue-world')).toBeVisible()
  await page.getByTestId('continue-world').click()
  await waitForWorld(page)
  await waitForLive(page)
  await page.keyboard.press('Escape')
  await expect(page.getByText('Remembered on this device.')).toBeHidden()
})

test('Forget clears remembered details without disconnecting', async ({ page }) => {
  const id = newUser()
  allow(id)
  await setHabitica(id, { name: 'Tansy' })
  await routeHabitica(page.context())
  await openPaste(page)
  await page.getByLabel('Paste both values').fill(labeled(id))
  await page.getByLabel('Remember on this device').check()
  await page.getByRole('button', { name: 'Connect' }).click()
  await waitForWorld(page)
  // The Menu's guide holds the same memory: Forget clears it.
  await page.keyboard.press('Escape')
  await expect(page.getByText('Remembered on this device.')).toBeVisible()
  await page.getByRole('button', { name: 'Forget', exact: true }).click()
  await expect(page.getByText('Remembered on this device.')).toBeHidden()
})
