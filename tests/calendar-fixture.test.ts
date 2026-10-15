import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

// Isolate synchronous fixture selection so an unbounded search fails this test
// instead of blocking the runner's own timeout, as the E2E search did.
test('the flower fixture selects Bloom wick and rejects absent names without looping', () => {
  const helper = new URL('./helpers/calendar.ts', import.meta.url).href
  const calendar = new URL('../src/lib/calendar.ts', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { wickStart } from ${JSON.stringify(helper)};
    import { calendarAt, CALENDAR } from ${JSON.stringify(calendar)};
    assert.ok(!CALENDAR.marks.includes('Bloom'));
    for (const wick of CALENDAR.wicks) {
      const day = calendarAt(wickStart(wick));
      assert.equal(day.wick, wick);
      assert.equal(day.day, 1);
    }
    assert.equal(calendarAt(wickStart('Bloom')).mark, 'Carting');
    assert.throws(() => wickStart('missing'), /Unknown wick/);
  `], { timeout: 5000, encoding: 'utf8' })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
})
