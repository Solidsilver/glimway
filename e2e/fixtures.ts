import { expect, test as base } from '@playwright/test'

/**
 * Shared test fixture: every playtest fails on an uncaught page error, so new
 * runtime code can't throw silently behind a passing assertion.
 *
 * Guest playtests also run as if no Fingersnap server existed (a static
 * deploy): same-origin /api requests fail like a dead network. Connected
 * specs opt in with `test.use({ server: true })` and reach the real Go
 * server through Vite's proxy.
 */
export const test = base.extend<{ pageErrors: string[]; server: boolean; noServer: void }>({
  server: [false, { option: true }],
  noServer: [
    async ({ context, server, baseURL }, use) => {
      if (!server) {
        const origin = new URL(baseURL ?? 'http://localhost').host
        await context.route(
          (url) => url.host === origin && url.pathname.startsWith('/api/'),
          (route) => route.abort('internetdisconnected')
        )
      }
      await use()
    },
    { auto: true }
  ],
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await use(errors)
      expect(errors, 'uncaught page errors').toEqual([])
    },
    { auto: true }
  ]
})

export { expect }
export type { Page } from '@playwright/test'
