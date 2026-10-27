import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// A fake npx records the runner's orchestration; no browser, Vite or
// Playwright process is ever started by these Node tests.
function run(t: test.TestContext, changed: string, args: string[] = [], fail = '') {
  const dir = mkdtempSync(join(tmpdir(), 'terrain-ci-plan-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const log = join(dir, 'calls.jsonl')
  const npx = join(dir, 'npx')
  writeFileSync(npx, `#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2);fs.appendFileSync(process.env.PLAN_LOG,JSON.stringify({args,report:process.env.E2E_RESULTS||null})+'\\n');process.exit(process.env.PLAN_FAIL&&args.some(a=>a.includes(process.env.PLAN_FAIL))?2:0)\n`)
  chmodSync(npx, 0o755)
  const result = spawnSync(process.execPath, [resolve('scripts/e2e-changed.ts'), ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, E2E_CHANGED: changed, E2E_RESULTS: '', PLAN_LOG: log, PLAN_FAIL: fail } })
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; report: string | null })
  return { result, calls }
}

test('terrain proofs run after ordinary specs with one worker and keep all reports', (t) => {
  const { result, calls } = run(t, 'src/game/terrain/find.ts,src/unmapped-runtime.ts', ['--workers=4'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(calls.length, 3)
  assert(calls[0]!.args.includes('e2e/height-lab-slopes.spec.ts'))
  assert(!calls[0]!.args.includes('e2e/terrain-find.spec.ts'))
  assert(calls[1]!.args.includes('e2e/terrain-find.spec.ts'))
  assert(calls[1]!.args.includes('e2e/terrain-ingame.spec.ts'))
  assert.equal(calls[1]!.args.at(-1), '--workers=1')
  assert.equal(calls[1]!.report, 'test-results/terrain-proof/e2e-results.json')
  assert.equal(calls[2]!.report, 'test-results/smoke/e2e-results.json')
})

test('a terrain-only selection writes the required primary report', (t) => {
  const { result, calls } = run(t, 'e2e/terrain-find.spec.ts')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.report, 'test-results/e2e-results.json')
})

test('full CI runs exclude terrain proofs from the parallel pass and run them afterwards', (t) => {
  const { result, calls } = run(t, 'docs/notes.md', ['--full'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(calls.length, 2)
  assert(calls[0]!.args.includes('--grep-invert'))
  assert(calls[0]!.args.includes('terrain-proof'))
  assert.equal(calls[1]!.args.at(-1), '--workers=1')
})

test('a failure in the regular or isolated pass survives later passing work', (t) => {
  for (const fail of ['height-lab-slopes.spec.ts', 'terrain-find.spec.ts']) {
    const { result, calls } = run(t, 'src/game/terrain/find.ts,src/unmapped-runtime.ts', [], fail)
    assert.equal(result.status, 2)
    assert.equal(calls.length, 3)
  }
})
