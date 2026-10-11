import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

for (const path of ['server/internal/api/open_map_paths.go', 'server/internal/api/open_map.go', 'server/internal/chunks/effective.go', 'server/internal/store/chunks.go', 'server/internal/wildsgen/wildsgen.go', 'server/internal/frontier/frontier.go', 'server/internal/worldchange/worldchange.go', 'content/wilds.json', 'content/wilds.go']) {
  test(`changed selector maps ${path} to the open map domain`, () => {
    const output = execFileSync(process.execPath, ['scripts/e2e-changed.ts', '--list'], { encoding: 'utf8', env: { ...process.env, E2E_CHANGED: path } })
    for (const spec of ['open-map.spec.ts', 'paths.spec.ts', 'rumour.spec.ts']) assert.ok(output.includes(`e2e/${spec}`), `${spec}: ${output}`)
    assert.ok(!output.includes('not in e2e/changed-map.json'), output)
  })
}
test('unmapped runtime content keeps the cheap smoke fallback', () => {
 const output = execFileSync(process.execPath, ['scripts/e2e-changed.ts','--list'],{encoding:'utf8',env:{...process.env,E2E_CHANGED:'content/new-runtime.json'}})
 assert.match(output,/the smoke tier/)
})

const list = (path: string) => execFileSync(process.execPath, ['scripts/e2e-changed.ts', '--list'], { encoding: 'utf8', env: { ...process.env, E2E_CHANGED: path } })
for (const path of ['content/vectors/economy.json', 'content/fishing_test.go', 'content/wilds/budget_test.go']) {
  test(`non-runtime content ${path} selects nothing`, () => {
    const output = list(path)
    assert.doesNotMatch(output, /smoke tier|e2e\/\S+\.spec\.ts/, output)
  })
}
for (const [path, specs] of [
  ['server/internal/api/purse.go', ['purse.spec.ts', 'glims.spec.ts']],
  ['server/internal/api/purse_budget.go', ['purse.spec.ts', 'glims.spec.ts']],
  ['server/internal/api/fishing.go', ['fishing.spec.ts']],
  ['server/internal/api/presence_abilities.go', ['abilities.spec.ts']],
] as const) {
  test(`changed selector maps ${path} to its own specs`, () => {
    const output = list(path)
    for (const spec of specs) assert.ok(output.includes(`e2e/${spec}`), `${spec}: ${output}`)
  })
}
