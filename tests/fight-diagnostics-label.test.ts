import './helpers/scene-modules.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { FightInterp } from '../src/lib/fight-interp.ts'

// Terminal-only DOM/timer boundary: execute the real overlay's scheduled draw.
const intervals = new Map<number, () => void>(), nodes: any[] = []
const originalInterval = globalThis.setInterval
Object.assign(globalThis, {
  location: { search: '?perf=1' },
  document: { documentElement: {}, body: { appendChild: (node: object) => nodes.push(node) }, createElement: () => ({ style: {}, setAttribute() {}, textContent: '' }) },
  requestAnimationFrame() {},
  MutationObserver: class { observe() {} },
  PerformanceObserver: class { static supportedEntryTypes: string[] = [] },
  setInterval(fn: () => void, ms: number) { intervals.set(ms, fn); return ms }
})
const { perfFights } = await import('../src/game/perf.ts')
globalThis.setInterval = originalInterval

test('the production diagnostics overlay labels fight metrics as socket session scoped', () => {
  perfFights(new FightInterp(() => 0))
  intervals.get(500)!()
  assert.match(nodes[0]!.textContent, /fights \(socket-session\)/)
})
