import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end playtests against the Vite dev server (the dev-only playtest
 * hooks — __fsDevWarp, __fsDevStrike — are stripped from production builds).
 * Runs on its own port so it never collides with a running `npm run dev`.
 * Set E2E_PORT to give each git worktree its own server; with the shared
 * default, a second worktree would reuse the first one's dev server.
 *
 * Connected playtests (e2e/connected*.spec.ts) also need the real Go server
 * and a fake Habitica for its login proof. Both start here on their own
 * ports (E2E_API_PORT, E2E_HABITICA_PORT) with a throwaway database under
 * .e2e-server/; Vite proxies /api to that server. Guest specs block /api in
 * the browser (e2e/fixtures.ts), so they still play with no server at all.
 */
const PORT = Number(process.env.E2E_PORT) || 5199
export const API_PORT = Number(process.env.E2E_API_PORT) || 18203
export const HABITICA_PORT = Number(process.env.E2E_HABITICA_PORT) || 18303

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  // One worker: the playtests drive real-time movement, and two browsers
  // under one machine's load drop enough frames to miss timed walks.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1200, height: 760 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1200, height: 760 } } }],
  webServer: [
    {
      command: `node e2e/server/fake-habitica.ts ${HABITICA_PORT}`,
      url: `http://127.0.0.1:${HABITICA_PORT}/__health`,
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      // Built, then run directly (same as `go run`, but the admin CLI the
      // tests call reuses the binary). Insecure cookies: the tests use http.
      command:
        `sh -c 'rm -rf .e2e-server && mkdir -p .e2e-server && go build -o .e2e-server/fingersnap-server ./server/cmd/fingersnap-server && ` +
        `exec .e2e-server/fingersnap-server -listen 127.0.0.1:${API_PORT} -db .e2e-server/fingersnap.sqlite -cookie-secure=false ` +
        `-habitica-url http://127.0.0.1:${HABITICA_PORT} -login-rate 10000'`,
      url: `http://127.0.0.1:${API_PORT}/api/state`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore'
    },
    {
      command: `npx vite --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      // Never reuse: an existing Vite would not proxy /api to the test server.
      reuseExistingServer: false,
      timeout: 60_000,
      env: { FINGERSNAP_API: `http://127.0.0.1:${API_PORT}` }
    }
  ]
})
