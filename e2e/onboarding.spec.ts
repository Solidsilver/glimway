import { expect, test, type Page } from './fixtures'
import { MOCK_TOKEN, MOCK_USER, mockHabitica, rememberedRecord, savedRecordText, waitForArea, warp, frames, expectToast } from './helpers'

const labeled = `User ID: ${MOCK_USER}\nAPI Token: ${MOCK_TOKEN}`

async function openGuide(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: /Play as your Habitica hero/ }).click()
  await expect(page.getByRole('heading', { name: 'Find your User ID and API Token' })).toBeVisible()
  await page.getByRole('button', { name: 'I have them' }).click()
}

test('title choice: both options, the ember line, and a guest start', async ({ page }) => {
  const mock = await mockHabitica(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: /Play as your Habitica hero/ })).toContainText('every 10 XP you earn in Habitica becomes an ember')
  await page.getByRole('button', { name: /Wander as a guest/ }).click()
  await waitForArea(page, 'village')
  expect(mock.calls).toEqual([])
  expect(await page.locator('.hud').count()).toBeGreaterThan(0)
})

test('guide tabs show the verified per-platform steps', async ({ page }) => {
  await mockHabitica(page)
  await page.goto('/')
  await page.getByRole('button', { name: /Play as your Habitica hero/ }).click()
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
})

test('new game → guide → labeled paste → connected → begin', async ({ page }) => {
  const mock = await mockHabitica(page)
  await openGuide(page)
  await page.getByLabel('Paste both values').fill(labeled)
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByTestId('hero-card')).toContainText('Tansy')
  await expect(page.getByTestId('hero-card')).toContainText('Level')
  await expect(page.locator('.guide')).toContainText('every 10 XP you earn in Habitica becomes an ember')
  expect(mock.calls).toEqual([{ user: MOCK_USER, key: MOCK_TOKEN }])
  await page.getByRole('button', { name: 'Begin your journey' }).click()
  await waitForArea(page, 'village')
  await expect(page.locator('.hud .embers')).toHaveText('3')
  // Nothing about the token reached the save.
  const saved = await savedRecordText(page)
  expect(saved).not.toContain(MOCK_TOKEN)
  expect(saved).not.toContain(MOCK_USER)
  expect(await rememberedRecord(page)).toBeNull()
})

test('unlabeled paste → preview → wrong order is refused → swap → connected', async ({ page }) => {
  const mock = await mockHabitica(page)
  await openGuide(page)
  // Token first: the parser files it as the User ID, so the sign-in fails.
  await page.getByLabel('Paste both values').fill(`${MOCK_TOKEN}\n${MOCK_USER}`)
  await expect(page.getByTestId('preview-user')).toHaveText(`${MOCK_TOKEN.slice(0, 4)}…${MOCK_TOKEN.slice(-4)}`)
  expect(mock.calls).toEqual([]) // nothing sent before confirming
  await page.getByRole('button', { name: 'Looks right — Connect' }).click()
  await expect(page.getByRole('alert')).toContainText('wrong way round')
  await page.getByRole('button', { name: 'Swap' }).click()
  await expect(page.getByTestId('preview-user')).toHaveText(`${MOCK_USER.slice(0, 4)}…${MOCK_USER.slice(-4)}`)
  await page.getByRole('button', { name: 'Looks right — Connect' }).click()
  await expect(page.getByTestId('hero-card')).toContainText('Tansy')
  expect(mock.calls).toHaveLength(2)
})

test('bad shapes say what was found', async ({ page }) => {
  await mockHabitica(page)
  await openGuide(page)
  const box = page.getByLabel('Paste both values')
  await box.fill(MOCK_USER)
  await expect(page.getByRole('alert')).toContainText('one ID')
  await expect(page.getByRole('button', { name: 'Connect' })).toBeDisabled()
  await box.fill(`${MOCK_USER} ${MOCK_TOKEN} ${MOCK_USER.replace('1', '3')}`)
  await expect(page.getByRole('alert')).toContainText('3 IDs')
})

test('remember → reload → sync without a paste → forget', async ({ page }) => {
  await mockHabitica(page)
  await openGuide(page)
  await page.getByLabel('Paste both values').fill(labeled)
  await page.getByLabel('Remember on this device').check()
  await expect(page.getByText('could read it', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByTestId('hero-card')).toContainText('Tansy')
  await expect(page.getByText('Remembered on this device.')).toBeVisible()
  expect(await rememberedRecord(page)).toMatchObject({ userId: MOCK_USER, apiToken: MOCK_TOKEN })
  await page.getByRole('button', { name: 'Begin your journey' }).click()
  await waitForArea(page, 'village')
  const saved = await savedRecordText(page)
  expect(saved).not.toContain(MOCK_TOKEN)

  // New visit: Continue, then the Menu is already connected.
  await page.reload()
  await page.getByRole('button', { name: /Continue/ }).click()
  await waitForArea(page, 'village')
  await page.keyboard.press('Escape')
  await expect(page.getByText('Remembered on this device.')).toBeVisible()
  await page.getByRole('button', { name: 'Sync character' }).click()
  await expect(page.locator('.toast')).toContainText(/All caught up|Synced/)

  // Disconnect asks about forgetting; Forget clears the store.
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(page.getByText('Forget your details too?')).toBeVisible()
  await page.getByRole('button', { name: 'Disconnect and forget' }).click()
  await expect.poll(() => rememberedRecord(page)).toBeNull()
  await page.reload()
  await page.getByRole('button', { name: /Continue/ }).click()
  await waitForArea(page, 'village')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tab', { name: 'Website' })).toBeVisible()
})

test('Forget button clears remembered details without disconnecting', async ({ page }) => {
  await mockHabitica(page)
  await openGuide(page)
  await page.getByLabel('Paste both values').fill(labeled)
  await page.getByLabel('Remember on this device').check()
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByText('Remembered on this device.')).toBeVisible()
  await page.getByRole('button', { name: 'Forget', exact: true }).click()
  await expect(page.getByText('Remembered on this device.')).toBeHidden()
  expect(await rememberedRecord(page)).toBeNull()
})

test('connect guide also works from the Menu, and Pip nudges a guest once', async ({ page }) => {
  await mockHabitica(page)
  await page.goto('/')
  await page.getByRole('button', { name: /Wander as a guest/ }).click()
  await waitForArea(page, 'village')

  // Pip, once, at the gate.
  await warp(page, 'village', 39, 10)
  await expectToast(page, 'connect your Habitica hero')
  await expect.poll(async () => (await savedRecordText(page)).includes('nudge:pip-gate')).toBe(true)
  const nudge = page.locator('.toast', { hasText: 'connect your Habitica hero' })
  await expect(nudge).toBeHidden({ timeout: 8000 })
  await warp(page, 'village', 10, 10)
  await warp(page, 'village', 39, 10)
  // Pip would speak up within a few frames at the gate: give him the chance.
  await frames(page, 48)
  await expect(nudge).toHaveCount(0)

  // Menu: same guide.
  await warp(page, 'village', 10, 10)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'I have them' }).click()
  await page.getByLabel('Paste both values').fill(labeled)
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByTestId('hero-card')).toContainText('Tansy')
  await expect(page.getByRole('button', { name: 'Sync character' })).toBeVisible()
})
