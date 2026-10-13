import test from 'node:test'
import assert from 'node:assert/strict'
import vectors from '../content/vectors/scuttle.json' with { type: 'json' }
import { fightScuttleOffset, fightLeashFraction } from '../src/lib/fight-math.ts'
import { ENEMY_TUNING } from '../src/lib/enemies.ts'

test('shared scuttle corners, end and leash intersections', () => {
  for (const v of vectors.scuttle) {
    const p = fightScuttleOffset(v.seconds)
    assert.ok(Math.abs(p.x - v.x) < 1e-9)
    assert.ok(Math.abs(p.y - v.y) < 1e-9)
  }
  for (const v of vectors.leash) assert.ok(Math.abs(fightLeashFraction(v.x, v.y, v.dx, v.dy) - v.fraction) < 1e-9)
  assert.ok(ENEMY_TUNING.beetle.chargeSpeed * ENEMY_TUNING.beetle.chargeTime <= 110)
})
