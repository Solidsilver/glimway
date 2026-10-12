import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from '@bufbuild/protobuf'
import { FightJoinSchema } from '../src/lib/gen/glimway/v2/presence_pb.js'
import { FightInterp } from '../src/lib/fight-interp.ts'
import { pressServerSwing, sendServerBolt } from '../src/game/entities/fight-strike.ts'
import { slashStrike, strikeHits, type EnemyState } from '../src/game/entities/fight-rules.ts'
import type { FightSwingIntent } from '../src/lib/presence.ts'

for (const direction of ['enter', 'leave'] as const) test(`press-time target ${direction}s reach before60ms feedback: sent instant and prediction agree`, () => {
  let clock = 1000, counter = 0
  const fights = new FightInterp(() => clock)
  fights.join(create(FightJoinSchema, { room: 1, tick: 100, critSeed: 123, roomKey: { world: 'w', realm: 'wilds', epoch: 'still' } }))
  clock += 100; fights.observe()
  const sent: FightSwingIntent[] = []
  const feed = { fights, serverFights: true, nextSwing: () => counter++, swing: (intent: FightSwingIntent) => { sent.push(intent); return true } }
  const enemy: EnemyState & { x: number; fight: { room: number; enemy: number } } = { id: 'wisp', type: 'wisp', x: direction === 'enter' ? 143 : 131.6, y: 99, hp: 28, maxHp: 28, state: 'lunge', dead: false, fight: { room: 1, enemy: 0 } }
  const strike = slashStrike({ x: 100, y: 100 }, { x: 1, y: 0 }, { meleeDamage: 5, critChance: .2 }, false)
  const predicted = pressServerSwing(strike, [enemy], feed)
  const atPress = enemy.x
  clock += 60; enemy.x += direction === 'enter' ? -11.4 : 11.4
  // Today's local decision is deliberately different at the landing callback.
  assert.notEqual(strikeHits(strike, [enemy], false).length, predicted.length)
  assert.deepEqual(sent[0]!.predicted, predicted.map(hit => hit.enemy.fight))
  assert.equal(predicted.length, direction === 'enter' ? 0 : 1)
  assert.deepEqual([sent[0]!.seenTick, sent[0]!.seenOffsetMs], [100, 0])
  assert.equal(strikeHits(strike, [{ ...enemy, x: atPress }], fights.crit(0, .2)).length, predicted.length)
})
test('mixed owners: only server targets in message; tool damage and one crit match seed; bolts name none', () => {
  let clock = 1000, counter = 0
  const fights = new FightInterp(() => clock)
  fights.join(create(FightJoinSchema, { room: 1, tick: 100, critSeed: 123, roomKey: { world: 'w', realm: 'wilds', epoch: 'still' } }))
  clock += 150; fights.observe()
  const sent: FightSwingIntent[] = []
  const feed = { fights, serverFights: true, nextSwing: () => counter++, swing: (intent: FightSwingIntent) => { sent.push(intent); return true } }
  const enemy = { id: 'wisp', type: 'wisp' as const, x: 114, y: 99, hp: 28, maxHp: 28, state: 'chase' as const, dead: false }
  const strike = slashStrike({ x: 100, y: 100 }, { x: 1, y: 0 }, { meleeDamage: 5, critChance: 1 }, true)
  const hits = pressServerSwing(strike, [enemy, { ...enemy, fight: { room: 1, enemy: 0 } }], feed)
  assert.equal(hits.length, 1); assert.equal(hits[0]!.crit, true)
  assert.equal(sent[0]!.tool, true); assert.equal(sent[0]!.seenOffsetMs, 50)
  assert.equal(sendServerBolt({ x: 100, y: 100 }, { x: 1, y: 0 }, feed), true)
  assert.deepEqual(sent[1]!.predicted, []); assert.equal(sent[1]!.swingCounter, 1)
  assert.deepEqual(pressServerSwing(strike, [enemy], null), [])
})

test('curated/local play sends no fight intent after the last visible server room leaves', () => {
  let clock = 1000
  const fights = new FightInterp(() => clock)
  fights.join(create(FightJoinSchema, { room: 1, tick: 100, critSeed: 123, roomKey: { world: 'w', realm: 'wilds', epoch: 'still' } }))
  clock += 100; fights.observe(); fights.drop(1)
  const feed = { fights, serverFights: true, nextSwing: () => { assert.fail('no counter for a local fight') }, swing: () => { assert.fail('no message for a local fight') } }
  const strike = slashStrike({ x: 100, y: 100 }, { x: 1, y: 0 }, { meleeDamage: 5, critChance: .2 }, false)
  assert.deepEqual(pressServerSwing(strike, [], feed), [])
  assert.equal(sendServerBolt({ x: 100, y: 100 }, { x: 1, y: 0 }, feed), false)
})

test('zero and non-unit facing normalize for both prediction and wire; zero bolts face down', () => {
  let clock = 1000
  const fights = new FightInterp(() => clock)
  fights.join(create(FightJoinSchema, { room: 1, tick: 100, critSeed: 123, roomKey: { world: 'w', realm: 'wilds', epoch: 'still' } }))
  clock += 100; fights.observe()
  const sent: FightSwingIntent[] = []
  const feed = { fights, serverFights: true, nextSwing: () => sent.length, swing: (s: FightSwingIntent) => { sent.push(s); return true } }
  const enemy = { id: 'wisp', type: 'wisp' as const, x: 100, y: 115, hp: 28, maxHp: 28, state: 'chase' as const, dead: false, fight: { room: 1, enemy: 0 } }
  for (const facing of [{ x: 0, y: 0 }, { x: 0, y: 2 }]) {
    const strike = slashStrike({ x: 100, y: 100 }, facing, { meleeDamage: 5, critChance: 0 }, false)
    assert.equal(pressServerSwing(strike, [enemy], feed).length, 1)
    assert.deepEqual(sent.at(-1)!.facing, { x: 0, y: 1 })
  }
  sendServerBolt({ x: 100, y: 100 }, { x: 0, y: 0 }, feed)
  assert.deepEqual(sent.at(-1)!.facing, { x: 0, y: 1 })
})
