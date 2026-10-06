import { expect, test as base, type Browser, type BrowserContext } from '@playwright/test'
import { ensureBackend, currentBackend, installLegacyDbPath, stopBackend, ROUTE_COOKIE, type Backend } from './server/backend.ts'

installLegacyDbPath()

/**
 * Shared test fixture: every playtest fails on an uncaught page error, so new
 * runtime code can't throw silently behind a passing assertion.
 *
 * Guest playtests also run as if no Fingersnap server existed (a static
 * deploy): same-origin /api requests fail like a dead network. Connected
 * specs opt in with `test.use({ server: true })` and reach their worker's own
 * Go server (e2e/server/backend.ts) through the shared Vite: every browser
 * context of the worker carries the routing cookie, including contexts a
 * test makes itself with `browser.newContext()`.
 */

async function routeToBackend(context: BrowserContext, backend: Backend, baseURL: string): Promise<void> {
  await context.addCookies([{ name: ROUTE_COOKIE, value: String(backend.apiPort), url: baseURL }])
}

export const test = base.extend<{ pageErrors: string[]; server: boolean; noServer: void }, { e2eBackend: void }>({
  // Worker-scoped: stops this worker's server when the worker exits, and
  // routes contexts made by hand to it (browser.newContext / newPage).
  e2eBackend: [
    async ({ browser }, use, workerInfo) => {
      const baseURL = String(workerInfo.project.use.baseURL)
      const b = browser as Browser & { __fsRouted?: boolean }
      if (!b.__fsRouted) {
        b.__fsRouted = true
        const newContext = browser.newContext.bind(browser)
        b.newContext = async (options) => {
          const context = await newContext(options)
          const backend = currentBackend()
          if (backend) await routeToBackend(context, backend, options?.baseURL ?? baseURL)
          return context
        }
      }
      await use()
      await stopBackend()
    },
    { scope: 'worker', auto: true }
  ],
  server: [false, { option: true }],
  noServer: [
    async ({ context, server, baseURL }, use) => {
      if (server) {
        await routeToBackend(context, await ensureBackend(), baseURL ?? 'http://127.0.0.1')
      } else {
        const origin = new URL(baseURL ?? 'http://127.0.0.1').host
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
