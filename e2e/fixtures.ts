import { expect, test as base } from '@playwright/test'

/**
 * Shared test fixture: every playtest fails on an uncaught page error, so new
 * runtime code can't throw silently behind a passing assertion.
 */
export const test = base.extend<{ pageErrors: string[] }>({
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
