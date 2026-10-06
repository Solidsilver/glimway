import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

/** Node's env without pulling Node types into the app's tsconfig. */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

// Playtests (playwright.config.ts): each Playwright worker has its own Go
// server, picked per request by a cookie (e2e/server/vite-routing.mjs). No
// hot reload, so editing a file mid-run doesn't reload the pages under test.
const e2e = env.FINGERSNAP_E2E_ROUTING === '1'

export default defineConfig(async () => {
  const routing = e2e ? [((await import(/* @vite-ignore */ new URL('./e2e/server/vite-routing.mjs', import.meta.url).href)) as { default: () => Plugin }).default()] : []
  return {
    plugins: [svelte(), ...routing],
    // /api goes to the Fingersnap server (`npm run server`, port 8090 by
    // default). FINGERSNAP_API points it elsewhere. With no server running,
    // the client sees the proxy error and plays as a guest.
    // changeOrigin stays off: the server rejects writes whose Origin host
    // differs from Host, exactly as behind Caddy.
    server: {
      host: true,
      port: 5173,
      hmr: !e2e,
      proxy: e2e
        ? undefined
        : {
            '/api': { target: env.FINGERSNAP_API || 'http://127.0.0.1:8090', changeOrigin: false },
            '/ws': { target: env.FINGERSNAP_API || 'http://127.0.0.1:8090', changeOrigin: false, ws: true }
          }
    },
    preview: { host: true, port: 4173 },
    build: { target: 'es2022' }
  }
})
