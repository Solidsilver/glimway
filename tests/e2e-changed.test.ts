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

for (const path of [
  'server/internal/fights/room.go',
  'server/internal/api/presence_fights.go',
  'server/internal/api/fall_writer.go',
  'server/internal/api/proto.go',
  'server/internal/api/presence_abilities.go',
  'server/internal/rules/fight_math.go',
  'server/internal/rules/combat_kit.go',
  'src/game/entities/fight-strike.ts',
  'src/game/entities/fight-rules.ts',
  'src/lib/fight-interp.ts',
  'src/lib/combat.ts',
  'src/game/entities/server-enemies.ts',
  'src/game/wilds/camp-fights.ts',
  'src/lib/gen/glimway/v2/presence_pb.js',
  'content/enemies.json',
  'content/combat.json',
  'content/abilities.json',
] as const) {
  test(`changed selector maps ${path} to the shared-fight specs`, () => {
    const output = list(path)
    for (const spec of ['fights-server.spec.ts', 'fights-shared.spec.ts']) {
      assert.ok(output.includes(`e2e/${spec}`), `${spec}: ${output}`)
    }
    assert.doesNotMatch(output, /not in e2e\/changed-map\.json/, output)
  })
}

for (const path of ['src/lib/api/queued-operation.ts', 'server/internal/api/op.go', 'server/internal/api/http.go', 'server/internal/api/projection.go', 'server/internal/api/mutation.go']) {
  test(`changed selector maps shared operation/maintenance path ${path} to affected domains`, () => {
    const output = list(path)
    for (const spec of ['fishing.spec.ts', 'companions.spec.ts', 'paths.spec.ts', 'repairs.spec.ts', 'items.spec.ts', 'glims.spec.ts']) {
      assert.ok(output.includes(`e2e/${spec}`), `${spec}: ${output}`)
    }
    assert.doesNotMatch(output, /not in e2e\/changed-map\.json/, output)
  })
}

const specsOf = (output: string) => (output.trim().split('\n').pop()?.match(/e2e\/\S+\.spec\.ts/g) ?? []).map((s) => s.slice('e2e/'.length))
const fullSuite = (output: string) => /→ full suite/.test(output)
const smokeTier = (output: string) => /the smoke tier$/m.test(output.trim().split('\n').pop() ?? '')

test('the trowel lane (b542aa9b) still selects lot-lantern and camps', () => {
  const files = ['server/internal/api/camp_teardown.go', 'server/internal/api/camps.go', 'server/internal/api/lot_location.go', 'server/internal/api/plants.go', 'src/game/entities/homestead-talk.ts', 'src/game/wilds/camps.ts', 'src/lib/belt.ts', 'src/lib/camps.ts', 'src/lib/trowel.ts', 'proto/glimway/v1/camps.proto', 'proto/glimway/v1/items.proto']
  const specs = specsOf(list(files.join(',')))
  for (const spec of ['lot-lantern.spec.ts', 'camps.spec.ts']) assert.ok(specs.includes(spec), `${spec}: ${specs}`)
  for (const file of ['src/lib/belt.ts', 'src/lib/trowel.ts', 'src/lib/lots.ts', 'server/internal/api/lot_location.go', 'server/internal/api/camp_teardown.go']) {
    assert.ok(specsOf(list(file)).includes('lot-lantern.spec.ts'), file)
  }
  for (const file of ['src/lib/camps.ts', 'src/lib/trowel.ts', 'src/game/wilds/camps.ts', 'server/internal/api/camps.go', 'server/internal/api/camp_teardown.go']) {
    assert.ok(specsOf(list(file)).includes('camps.spec.ts'), file)
  }
})

test('homestead-talk.ts runs one spec per branch it routes to, plus the smoke tier', () => {
  const output = list('src/game/entities/homestead-talk.ts')
  assert.deepEqual(specsOf(output), ['camps.spec.ts', 'companions.spec.ts', 'crafting.spec.ts', 'gifts.spec.ts', 'heirlooms.spec.ts', 'homestead.spec.ts', 'lot-lantern.spec.ts', 'playtest1.spec.ts', 'village.spec.ts', 'yard.spec.ts'])
  assert.ok(smokeTier(output), output)
  // The other homestead entities keep their broad rules.
  assert.ok(specsOf(list('src/game/entities/homestead-art.ts')).includes('talk.spec.ts'))
})

test('the Wilds camps run camps.spec and the smoke tier, not every Wilds spec', () => {
  for (const file of ['src/game/wilds/camps.ts', 'src/game/wilds/camps-state.ts']) {
    const output = list(file)
    assert.deepEqual(specsOf(output), ['camps.spec.ts'], output)
    assert.ok(smokeTier(output), output)
  }
  // `!` only takes those files out: the rest of the Wilds keeps its rule.
  assert.ok(specsOf(list('src/game/wilds/paths.ts')).includes('wilds.spec.ts'))
})

for (const [file, want, not] of [
  ['proto/glimway/v1/camps.proto', ['camps.spec.ts', 'lot-lantern.spec.ts'], ['fights-server.spec.ts', 'connected.spec.ts']],
  ['server/internal/gen/glimway/v1/items.pb.go', ['items.spec.ts', 'inventory.spec.ts', 'lot-lantern.spec.ts'], ['fights-server.spec.ts', 'connected.spec.ts']],
  ['src/lib/gen/glimway/v1/goods_pb.js', ['items.spec.ts', 'homestead.spec.ts'], ['fights-server.spec.ts']],
  ['src/lib/gen/glimway/v1/errors_pb.d.ts', ['connected.spec.ts', 'version.spec.ts'], ['fights-server.spec.ts']],
  ['proto/glimway/v1/state.proto', ['connected.spec.ts', 'onboarding.spec.ts'], ['fights-server.spec.ts']],
  ['proto/glimway/v2/presence.proto', ['presence.spec.ts', 'fights-server.spec.ts', 'fights-shared.spec.ts'], []],
  ['gen/glimway/content/v1/enemies.pb.go', ['fights-server.spec.ts', 'fights-shared.spec.ts'], []],
  ['gen/glimway/content/v1/homestead.pb.go', ['homestead.spec.ts', 'lot-lantern.spec.ts'], ['fights-server.spec.ts']],
  ['src/lib/api/items.ts', ['items.spec.ts', 'inventory.spec.ts'], ['party-worlds.spec.ts', 'coop.spec.ts']],
] as const) {
  test(`proto family: ${file} runs its family's specs`, () => {
    const output = list(file)
    const specs = specsOf(output)
    for (const s of want) assert.ok(specs.includes(s), `${s}: ${output}`)
    for (const s of not) assert.ok(!specs.includes(s), `not ${s}: ${output}`)
    assert.doesNotMatch(output, /not in e2e\/changed-map\.json/, output)
  })
}

test('a content schema with no family rule runs only the smoke tier', () => {
  const output = list('proto/glimway/content/v1/contract.proto')
  assert.deepEqual(specsOf(output), [])
  assert.ok(smokeTier(output), output)
})

test('the server catch-all applies only to files with no rule of their own', () => {
  const signIn = ['connected.spec.ts', 'connected-screens.spec.ts', 'onboarding.spec.ts', 'polish.spec.ts']
  assert.deepEqual(specsOf(list('server/internal/api/recovery.go')), ['camps.spec.ts'])
  assert.deepEqual(specsOf(list('server/internal/api/login.go')), [...signIn].sort())
  assert.deepEqual(specsOf(list('server/internal/api/camps.go')), ['camps.spec.ts'])
  assert.deepEqual(specsOf(list('src/lib/api/client.ts')), [...signIn, 'party-worlds.spec.ts', 'party-worlds-screens.spec.ts', 'presence.spec.ts', 'coop.spec.ts'].sort())
})

for (const path of ['server/internal/api/camps_test.go', 'server/internal/api/testdata/server-first.json', 'server/internal/store/storetest/composition.go', 'e2e/hooks.d.ts']) {
  test(`test-only ${path} selects nothing`, () => {
    const output = list(path)
    assert.doesNotMatch(output, /smoke tier|e2e\/\S+\.spec\.ts|full suite/, output)
  })
}

for (const path of ['e2e/room-helpers.ts', 'e2e/positions.ts', 'go.mod', 'svelte.config.js']) {
  test(`shared infrastructure ${path} runs the full suite`, () => assert.ok(fullSuite(list(path))))
}

test('e2e/harness runs only the spec that loads it', () => {
  assert.deepEqual(specsOf(list('e2e/harness/phaser.html')), ['window-order.spec.ts'])
})

// The 0.13 domains the step-back review found unmapped (T1): each now runs the specs that use it.
for (const [file, want, smoke] of [
  ['content/papers.json', ['papers.spec.ts', 'papers-screens.spec.ts', 'connected.spec.ts', 'inventory.spec.ts'], true],
  ['content/items.json', ['items.spec.ts', 'crafting.spec.ts', 'camps.spec.ts', 'lot-lantern.spec.ts', 'homestead.spec.ts', 'inventory.spec.ts'], true],
  ['content/crafting.json', ['items.spec.ts', 'crafting.spec.ts', 'camps.spec.ts', 'lot-lantern.spec.ts', 'homestead.spec.ts', 'inventory.spec.ts'], true],
  ['content/homestead.json', ['items.spec.ts', 'crafting.spec.ts', 'camps.spec.ts', 'lot-lantern.spec.ts', 'homestead.spec.ts', 'inventory.spec.ts'], true],
  ['content/quests.json', ['quest.spec.ts', 'camps.spec.ts', 'rumour.spec.ts'], true],
  ['content/story.json', ['quest.spec.ts', 'camps.spec.ts', 'rumour.spec.ts'], true],
  ['src/content/quests/keepers-hand.ts', ['quest.spec.ts', 'camps.spec.ts', 'rumour.spec.ts'], true],
  ['server/internal/api/common_ways.go', ['paths.spec.ts'], false],
  ['server/internal/api/frontier_reach.go', ['camps.spec.ts', 'lot-lantern.spec.ts', 'land-chip.spec.ts', 'paths.spec.ts'], false],
  ['server/internal/api/claim_rules.go', ['camps.spec.ts', 'lot-lantern.spec.ts', 'land-chip.spec.ts', 'paths.spec.ts'], false],
  ['server/internal/store/holds.go', ['camps.spec.ts', 'lot-lantern.spec.ts', 'land-chip.spec.ts', 'paths.spec.ts'], false],
  ['server/internal/store/reach.go', ['camps.spec.ts', 'lot-lantern.spec.ts', 'land-chip.spec.ts', 'paths.spec.ts'], false],
  ['server/internal/store/commons.go', ['camps.spec.ts', 'lot-lantern.spec.ts', 'land-chip.spec.ts', 'paths.spec.ts'], false],
  ['src/lib/lamp-naming.ts', ['camps.spec.ts'], false],
  ['src/content/lamp-naming.ts', ['camps.spec.ts'], false],
  ['src/ui/LampNamingPanel.svelte', ['camps.spec.ts'], false],
] as const) {
  test(`0.13 domain: ${file} runs its own specs, not the catch-all`, () => {
    const output = list(file)
    assert.deepEqual(specsOf(output), [...want].sort(), output)
    assert.equal(smokeTier(output), smoke, output)
    assert.doesNotMatch(output, /not in e2e\/changed-map\.json/, output)
  })
}

// The step-back's E2E guards (lane A9): each fix's files run the spec that guards it.
for (const [file, guard] of [
  ['src/game/ways-home.ts', 'ways-home.spec.ts'],
  ['server/internal/api/ways_home.go', 'ways-home.spec.ts'],
  ['src/game/scenes/travel-hold.ts', 'ways-home.spec.ts'],
  ['src/game/scenes/world-turning.ts', 'ways-home.spec.ts'],
  ['src/game/scenes/world-turning.ts', 'wilds-outer.spec.ts'],
  ['src/ui/layers.ts', 'camps.spec.ts'],
  ['src/ui/panel-state.svelte.ts', 'camps.spec.ts'],
  ['src/ui/panel-state.svelte.ts', 'gifts.spec.ts'],
  ['src/ui/CratePanel.svelte', 'camps.spec.ts'],
  ['src/ui/GateShelfPanel.svelte', 'gifts.spec.ts'],
  ['src/ui/InventoryPanel.svelte', 'camps.spec.ts'],
] as const) {
  test(`step-back guard: ${file} runs ${guard}`, () => {
    const output = list(file)
    assert.ok(specsOf(output).includes(guard), output)
  })
}
