import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  server: { host: true, port: 5173, proxy: { '/api': 'http://127.0.0.1:8090' } },
  preview: { host: true, port: 4173 },
  build: { target: 'es2022' }
})
