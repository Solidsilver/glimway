import { cpus } from 'node:os'
import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end playtests against the Vite dev server (the dev-only playtest
 * hooks — __fsDevWarp, __fsDevStrike — are stripped from production builds).
 * See docs/testing.md for the tiers, workers and ports.
 *
 * Parallel and isolated: every worker gets its own Go server, SQLite
 * database and fake Habitica (e2e/server/backend.ts), started the first time
 * that worker runs a `server: true` test, on free ports. One Vite dev server
 * on E2E_PORT is shared; it sends each browser's /api and /ws to its worker's
 * server by a cookie (e2e/server/vite-routing.mjs). Guest specs block /api in
 * the browser (e2e/fixtures.ts), so they still play with no server at all.
 *
 * E2E_PORT gives each git worktree its own Vite (the default, 5199, would be
 * shared by two worktrees). E2E_WORKERS (or --workers) sets the worker count.
 * E2E_API_PORT and E2E_HABITICA_PORT are no longer used: those servers pick
 * free ports per worker.
 */
const PORT = Number(process.env.E2E_PORT) || 5199
/** @deprecated Per-worker servers pick free ports; see e2e/server/backend.ts. */
export const API_PORT = Number(process.env.E2E_API_PORT) || 18203
/** @deprecated Per-worker servers pick free ports; see e2e/server/backend.ts. */
export const HABITICA_PORT = Number(process.env.E2E_HABITICA_PORT) || 18303

// Render WebGL on the GPU (macOS: ANGLE over Metal). Headless Chromium's
// default is SwiftShader, software GL on the CPU: on a busy machine the game
// drew ~8 frames a second that way against 60 on the GPU, and every timing
// flake got worse. E2E_GPU=0 goes back to SwiftShader. 2D canvases stay in
// software: e2e/atlases.spec.ts compares their pixels exactly.
const GPU = process.env.E2E_GPU !== '0' && process.platform === 'darwin'
const GPU_ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-accelerated-2d-canvas']

// CI uses two workers per runner. Locally, keep canvases and Go servers from
// taking over the machine; E2E_WORKERS (or --workers) overrides it.
const WORKERS = Number(process.env.E2E_WORKERS) || (process.env.CI
  ? 2
  : Math.min(3, Math.max(2, Math.floor(cpus().length / 2))))

export default defineConfig({
  testDir: 'e2e',
  // SwiftShader is slower than Metal, so give timing-sensitive CI tests more room.
  timeout: process.env.CI ? 120_000 : 90_000,
  // Every test makes its own player and world, so tests spread across workers.
  fullyParallel: true,
  workers: WORKERS,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['blob', { outputDir: 'blob-report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    // 127.0.0.1, not localhost: page.request resolves the host in Node, and
    // under load a localhost lookup has stalled for seconds.
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1200, height: 760 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1200, height: 760 }, launchOptions: { args: GPU ? GPU_ARGS : [] } }
    }
  ],
  webServer: [
    {
      command: `npx vite --port ${PORT} --strictPort`,
      url: `http://127.0.0.1:${PORT}`,
      // Never reuse: an existing Vite would not route /api to the workers' servers.
      reuseExistingServer: false,
      timeout: 60_000,
      env: { GLIMWAY_E2E_ROUTING: '1' }
    }
  ]
})
