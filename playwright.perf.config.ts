import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

/**
 * The walk (perf/walk.perf.ts): walking the open map with ?perf=1 and
 * reporting long frames, frame times and what the scene holds
 * (docs/testing.md, "Performance"). Its own config, outside the e2e suites
 * and never in CI: one worker, nothing else running beside it.
 *
 *   npx playwright test -c playwright.perf.config.ts
 */
export default defineConfig({
  ...base,
  testDir: 'perf',
  testMatch: '*.perf.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20 * 60_000,
  reporter: 'list',
  reportSlowTests: null,
})
