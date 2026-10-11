/**
 * Lets node tests import scene modules that Vite builds: `phaser` becomes a
 * stub (nothing here draws), extensionless relative imports find their
 * `.ts`, and TypeScript that strip-only mode refuses (constructor parameter
 * properties) is compiled with TypeScript's own transpiler. Import this first, then load the module under
 * test with a dynamic `await import(…)`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

const PHASER_STUB = 'data:text/javascript,export default {}'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'phaser') return { url: PHASER_STUB, shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of ['.ts', '.js']) {
        const url = new URL(specifier + ext, context.parentURL)
        if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context)
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.ts') || url.endsWith('.svelte.ts') || url.includes('/node_modules/')) return nextLoad(url, context)
    const source = readFileSync(fileURLToPath(url), 'utf8')
    const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false, useDefineForClassFields: true } })
    return { format: 'module', source: outputText, shortCircuit: true }
  }
})
