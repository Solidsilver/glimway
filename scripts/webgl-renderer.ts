/**
 * Prints the WebGL renderer Chromium gets with the playtest launch options
 * (playwright.config.ts, E2E_GPU), before a CI run spends minutes on the
 * suite. A GPU mode that falls back to SwiftShader still runs the suite,
 * slowly; on GitHub Actions it leaves a warning on the run.
 *
 *   E2E_GPU=nvidia node scripts/webgl-renderer.ts
 */
import { chromium } from '@playwright/test'
import { GPU_LAUNCH } from '../playwright.config.ts'

const browser = await chromium.launch(GPU_LAUNCH)
const page = await browser.newPage()
const renderer = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) return 'no WebGL2 context'
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
})
await browser.close()

console.log(`WebGL renderer: ${renderer}`)
console.log(`Launch: ${JSON.stringify(GPU_LAUNCH)}`)
const software = /SwiftShader|llvmpipe|no WebGL/i.test(renderer)
if (GPU_LAUNCH.args.length > 0 && software && process.env.GITHUB_ACTIONS) {
  console.log(`::warning title=No GPU::E2E_GPU=${process.env.E2E_GPU ?? ''} asked for the GPU, but Chromium renders with ${renderer}`)
}
