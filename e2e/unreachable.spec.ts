import { expect, test, type Page } from './fixtures'

/**
 * The title when no world server answers (design section 1.3: the old
 * no-server detection became a plain "can't reach the world" card). Two
 * shapes: a dead network (a static deploy's failed /api) and a static host
 * that answers /api with an HTML page. Try again (a reload) comes back when
 * the world is there.
 */

const origin = (baseURL: string) => new URL(baseURL).host

async function blockApi(page: Page, baseURL: string, mode: 'abort' | 'html'): Promise<void> {
  await page.route(
    (url) => url.host === origin(baseURL) && url.pathname.startsWith('/api/'),
    (route) => {
      if (mode === 'html') return route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><p>Not found' })
      return route.abort('internetdisconnected')
    }
  )
}

for (const mode of ['abort', 'html'] as const) {
  test(`${mode}: the title says it can't reach the world, and Try again comes back`, async ({ page, baseURL }) => {
    await blockApi(page, baseURL!, mode)
    await page.goto('/')
    const card = page.getByTestId('unreachable')
    await expect(card).toBeVisible()
    await expect(card).toContainText('Can’t reach the world')
    // There is nothing to play from: no connect card, no guest start.
    await expect(page.getByTestId('connect-hero')).toHaveCount(0)

    // The world is there again: Try again (a reload) shows the connect card.
    await page.unrouteAll()
    await card.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByTestId('unreachable')).toHaveCount(0)
    await expect(page.getByTestId('connect-hero')).toBeVisible()
  })
}
