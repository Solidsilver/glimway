/**
 * Lets node tests import rune modules (`*.svelte.ts`): strips the types,
 * then compiles the runes with Svelte, as Vite does. Import this first, then
 * load the module under test with a dynamic `await import(…)` (static
 * imports are all loaded before this file runs).
 *
 * Only `$state`, `$derived` and plain classes work outside a component; an
 * `$effect` needs a root (`effectRoot` below).
 */
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { compileModule } from 'svelte/compiler'

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.svelte.ts')) return nextLoad(url, context)
    const filename = fileURLToPath(url)
    const js = stripTypeScriptTypes(readFileSync(filename, 'utf8'), { mode: 'strip' })
    const { js: out } = compileModule(js, { filename, generate: 'client', dev: false })
    return { format: 'module', source: out.code, shortCircuit: true }
  }
})

/** Runs `fn` inside an effect root (so `$effect`s it sets up run); returns the teardown. */
export async function effectRoot(fn: () => void): Promise<() => void> {
  const { effect_root, flush } = (await import('svelte/internal/client')) as unknown as {
    effect_root: (fn: () => void) => () => void
    flush: () => void
  }
  const stop = effect_root(fn)
  flush()
  return stop
}

/** Runs pending effects now. */
export async function flushEffects(): Promise<void> {
  const { flush } = (await import('svelte/internal/client')) as unknown as { flush: () => void }
  flush()
}
