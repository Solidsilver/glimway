import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

/** Opt-in, single-worker browser measurement for the first-paint budget. */
export default defineConfig({
  ...base,
  testDir: 'e2e',
  testMatch: 'first-paint.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: 'list',
  reportSlowTests: null,
})
