import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

/** Node's env without pulling Node types into the app's tsconfig. */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

export default defineConfig({
  plugins: [svelte()],
  // /api goes to the Fingersnap server (`npm run server`, port 8090 by
  // default). FINGERSNAP_API points it elsewhere (the e2e server). With no
  // server running, the client sees the proxy error and plays as a guest.
  // changeOrigin stays off: the server rejects writes whose Origin host
  // differs from Host, exactly as behind Caddy.
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: env.FINGERSNAP_API || 'http://127.0.0.1:8090', changeOrigin: false },
      '/ws': { target: env.FINGERSNAP_API || 'http://127.0.0.1:8090', changeOrigin: false, ws: true }
    }
  },
  preview: { host: true, port: 4173 },
  build: { target: 'es2022' }
})
