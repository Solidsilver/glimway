import './helpers/svelte-runes.ts'
import './helpers/scene-modules.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { EventEmitter } from 'node:events'
import { CAMP_READ_EVERY_MS } from '../src/game/wilds/camp-fights.ts'
const storeURL = new URL('../src/game/wilds/store.ts', import.meta.url).href
const reads: { cx: number; resolve: (ok: boolean) => void }[] = []
;(globalThis as any).__campNear = (_session: unknown, cx: number) => new Promise<boolean>(resolve => reads.push({ cx, resolve }))
// Replace only the network boundary of WildsEntities; keep its real recovery and refresh wiring.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './store.ts' && context.parentURL?.endsWith('/wilds/entities.ts')) {
    const source = `export * from ${JSON.stringify(storeURL)}; export const refreshNear = (...args) => globalThis.__campNear(...args);`
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
  }
  return next(specifier, context)
} })
const { WildsEntities } = await import('../src/game/wilds/entities.ts')
const { takeReadRequest } = await import('../src/game/wilds/store.ts')

test('movement and an unrelated refresh cannot release the recovery read gate', async () => {
  reads.length = 0; takeReadRequest()
  let now = 0, hero = { x: 0, y: 0 }
  const entities: any = new WildsEntities({ textures: { exists: () => true }, events: new EventEmitter() } as any, { session: {}, hero: () => hero } as any)
  const outcome = entities.campOutcome
  outcome.read = () => true; outcome.now = () => now
  const camp = { id: 'camp:0:0:0', epoch: 'still', cycle: 1, claimable: false }
  outcome.won(camp)
  // Before the fix, recovery uses the store flag consumed by update().
  if (takeReadRequest()) void entities.refresh()
  assert.equal(reads.length, 1)
  assert.equal(reads[0]!.cx, 0)
  hero = { x: 10000, y: 0 }
  const unrelated = entities.refresh()
  assert.notEqual(reads[1]!.cx, reads[0]!.cx)
  reads[1]!.resolve(true); await unrelated
  now = CAMP_READ_EVERY_MS; outcome.won(camp)
  if (takeReadRequest()) void entities.refresh()
  assert.equal(reads.length, 2, 'C2 completion must not release the pending C1 recovery')
  reads[0]!.resolve(false); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  outcome.won(camp)
  if (takeReadRequest()) void entities.refresh()
  assert.equal(reads.length, 3, 'the recovery promise itself releases its gate even on failure')
  reads[2]!.resolve(true); await Promise.resolve()
})
