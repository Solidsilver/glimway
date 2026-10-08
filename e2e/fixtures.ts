import { expect, test as base, type Browser, type BrowserContext } from '@playwright/test'
import { ensureBackend, currentBackend, installLegacyDbPath, stopBackend, ROUTE_COOKIE, type Backend } from './server/backend.ts'

installLegacyDbPath()

/**
 * Shared test fixture: every playtest fails on an uncaught page error, and
 * every playtest runs against a server — each worker starts its own Go
 * server (e2e/server/backend.ts) with its own database and fake Habitica,
 * and every browser context of the worker reaches it through the shared
 * Vite, including contexts a test makes itself with `browser.newContext()`.
 * There is no guest play any more: a fresh player signs in with
 * `freshPlayer` (e2e/home-helpers.ts) or pastes into the guide directly
 * (e2e/connected.ts).
 */

async function routeToBackend(context: BrowserContext, backend: Backend, baseURL: string): Promise<void> {
  await context.addCookies([{ name: ROUTE_COOKIE, value: String(backend.apiPort), url: baseURL }])
}

export const test = base.extend<{ pageErrors: string[]; backend: void }, { e2eBackend: void }>({
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
  // Every context of this worker is routed to its backend, which is started
  // on first use and kept for the worker's remaining tests.
  backend: [
    async ({ context, baseURL }, use) => {
      await routeToBackend(context, await ensureBackend(), baseURL ?? 'http://127.0.0.1')
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
