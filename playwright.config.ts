import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end playtests against the Vite dev server (the dev-only playtest
 * hooks — __fsDevWarp, __fsDevStrike — are stripped from production builds).
 * Runs on its own port so it never collides with a running `npm run dev`.
 * Set E2E_PORT to give each git worktree its own server; with the shared
 * default, a second worktree would reuse the first one's dev server.
 */
const PORT = Number(process.env.E2E_PORT) || 5199

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1200, height: 760 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1200, height: 760 } } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  }
})
