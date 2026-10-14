import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from '@bufbuild/protobuf'
import { FightJoinSchema } from '../src/lib/gen/glimway/v2/presence_pb.js'
import { FightInterp } from '../src/lib/fight-interp.ts'
import { canStartFight, pressServerCast, pressServerSwing, sendServerBolt } from '../src/game/entities/fight-strike.ts'
import { SIGNATURES, cleaveStrike, hitOutcome, mendStrike, shadowstepEnd, slashStrike, snapstrike, strikeHits, type EnemyState } from '../src/game/entities/fight-rules.ts'
import { fightCrit } from '../src/lib/fight-math.ts'
import type { FightCastIntent, FightSwingIntent } from '../src/lib/presence.ts'

for (const direction of ['enter', 'leave'] as const) test(`press-time target ${direction}s reach before60ms feedback: sent instant and prediction agree`, () => {
  let clock = 1000, counter = 0
  const fights = new FightInterp(() => clock)
  fights.join(create(FightJoinSchema, { room: 1, tick: 100, critSeed: 123, roomKey: { world: 'w', realm: 'wilds', epoch: 'still' } }))
  clock += 100; fights.observe()
  const sent: FightSwingIntent[] = []
  const feed = { fights, nextSwing: () => counter++, swing: (intent: FightSwingIntent) => { sent.push(intent); return true } }
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
  const feed = { fights, nextSwing: () => counter++, swing: (intent: FightSwingIntent) => { sent.push(intent); return true } }
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
  const feed = { fights, nextSwing: () => { assert.fail('no counter for a local fight') }, swing: () => { assert.fail('no message for a local fight') } }
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
  const feed = { fights, nextSwing: () => sent.length, swing: (s: FightSwingIntent) => { sent.push(s); return true } }
  const enemy = { id: 'wisp', type: 'wisp' as const, x: 100, y: 115, hp: 28, maxHp: 28, state: 'chase' as const, dead: false, fight: { room: 1, enemy: 0 } }
  for (const facing of [{ x: 0, y: 0 }, { x: 0, y: 2 }]) {
    const strike = slashStrike({ x: 100, y: 100 }, facing, { meleeDamage: 5, critChance: 0 }, false)
    assert.equal(pressServerSwing(strike, [enemy], feed).length, 1)
    assert.deepEqual(sent.at(-1)!.facing, { x: 0, y: 1 })
  }
  sendServerBolt({ x: 100, y: 100 }, { x: 0, y: 0 }, feed)
  assert.deepEqual(sent.at(-1)!.facing, { x: 0, y: 1 })
})

function castRig(joined = true) {
  let clock = 1000, counter = 0
  const fights = new FightInterp(() => clock)
  if (joined) fights.join(create(FightJoinSchema, { room: 1, tick: 100, critSeed: 123, roomKey: { world: 'w', realm: 'wilds', epoch: 'still' } }))
  clock += 100; fights.observe()
  const casts: { id: string; x: number; y: number; fight?: FightCastIntent }[] = []
  let accept = true
  const feed = { fights, nextSwing: () => counter++, ability: (id: string, x: number, y: number, fight?: FightCastIntent) => { casts.push({ id, x, y, fight }); return accept } }
  const enemy = (x: number, fight: boolean, extra: Partial<EnemyState> = {}) => ({ id: `e${x}`, type: 'wisp', x, y: 100, hp: 28, maxHp: 28, state: 'chase', dead: false, ...(fight ? { fight: { room: 1, enemy: x } } : {}), ...extra }) as EnemyState & { fight?: { room: number; enemy: number } }
  return { fights, feed, casts, enemy, refuse: () => { accept = false }, get counter() { return counter } }
}

test('cleave and mend: press-time rows on server enemies only, one counter shared with swings, never a crit', () => {
  const r = castRig()
  const server = r.enemy(130, true), local = r.enemy(131, false), far = r.enemy(300, true)
  const cleave = pressServerCast('cleave', { x: 100, y: 100 }, { x: 1, y: 0 }, cleaveStrike({ x: 100, y: 100 }, { x: 1, y: 0 }, 12), [server, local, far], r.feed)
  assert.deepEqual(cleave.hits.map(h => h.enemy), [server], 'local enemies keep their landing-time path')
  assert.equal(cleave.hits[0]!.crit, false); assert.equal(cleave.hits[0]!.amount, 12)
  assert.deepEqual(r.casts[0]!.fight!.predicted, [{ room: 1, enemy: 130 }])
  assert.equal(r.casts[0]!.fight!.swingCounter, 0)
  assert.deepEqual([r.casts[0]!.fight!.seenTick, r.casts[0]!.fight!.seenOffsetMs], [100, 0])
  const mend = pressServerCast('mend', { x: 100, y: 100 }, { x: 0, y: 1 }, mendStrike({ x: 100, y: 100 }, 7), [server, far], r.feed)
  assert.equal(r.casts[1]!.fight!.swingCounter, 1, 'the next number on the shared sequence')
  assert.deepEqual(mend.hits.map(h => h.enemy), [server])
})

test('shadowstep predicts rows at its projected end (the shared dash numbers), with twice the seeded crit chance', () => {
  const r = castRig()
  // As hero.ts presses it: the end on open ground from content's dash speed and window.
  const end = shadowstepEnd({ x: 100, y: 100 }, { x: 1, y: 0 })
  assert.equal(end.x, 100 + SIGNATURES.shadowstep.dashSpeed * SIGNATURES.shadowstep.dashSeconds)
  const atStart = r.enemy(100, true), atEnd = r.enemy(end.x, true)
  const strike = snapstrike(end, true, 10, 0.3)
  assert.equal(strike.critChance, 0.6)
  const cast = pressServerCast('shadowstep', { x: 100, y: 100 }, { x: 1, y: 0 }, strike, [atStart, atEnd], r.feed)
  assert.deepEqual(cast.hits.map(h => h.enemy), [atEnd])
  assert.equal(cast.hits[0]!.crit, fightCrit(123, 0, 0.6))
})

test('a stunned server beetle takes 1.5× and shows as a crit on the predicted number', () => {
  const beetle = { id: 'b', type: 'beetle', x: 0, y: 0, hp: 40, maxHp: 40, state: 'stunned', dead: false } as const
  assert.deepEqual(hitOutcome(beetle, 10, false), { amount: 15, crit: true })
})

test('moves and fingersnap carry a fight part with no rows; no observed room sends a plain relay and no counter', () => {
  const r = castRig()
  for (const id of ['kindle', 'stand', 'echo', 'ward-light', 'fingersnap']) {
    const cast = pressServerCast(id, { x: 5, y: 6 }, { x: 0, y: 0 }, null, [r.enemy(5, true)], r.feed)
    assert.deepEqual([cast.sent, cast.fight, cast.hits.length], [true, true, 0], id)
  }
  assert.deepEqual(r.casts.map(c => c.fight!.predicted.length), [0, 0, 0, 0, 0])
  assert.deepEqual(r.casts[0]!.fight!.facing, { x: 0, y: 1 }, 'zero facing faces down')
  const none = castRig(false)
  const cast = pressServerCast('stand', { x: 5, y: 6 }, { x: 0, y: 1 }, null, [], none.feed)
  assert.deepEqual([cast.sent, cast.fight], [true, false])
  assert.equal(none.casts[0]!.fight, undefined); assert.equal(none.counter, 0)
})

test('a cast the socket did not send predicts nothing on server enemies', () => {
  const r = castRig(); r.refuse()
  const cast = pressServerCast('cleave', { x: 100, y: 100 }, { x: 1, y: 0 }, cleaveStrike({ x: 100, y: 100 }, { x: 1, y: 0 }, 12), [r.enemy(130, true)], r.feed)
  assert.deepEqual([cast.sent, cast.fight, cast.hits.length], [false, false, 0])
})


test('safe origins refuse slash, tool, bolts in every direction and enemy workings before prediction or counters', () => {
  let clock = 1000
  const fights = new FightInterp(() => clock)
  fights.join(create(FightJoinSchema, { room: 1, tick: 100, critSeed: 123, roomKey: { world: 'w', realm: 'wilds', epoch: 'still' } }))
  clock += 100; fights.observe()
  const feed = { fights, nextSwing: () => { assert.fail('safe attack consumed counter') }, swing: () => { assert.fail('safe attack sent') }, ability: () => { assert.fail('safe cast sent') } }
  const feet = { x: 40, y: 391 }
  const enemy = { id: 'wisp', type: 'wisp' as const, x: 40, y: 360, hp: 28, maxHp: 28, state: 'chase' as const, dead: false, fight: { room: 1, enemy: 0 } }
  for (const facing of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
    for (const tool of [false, true]) assert.deepEqual(pressServerSwing(slashStrike(feet, facing, { meleeDamage: 5, critChance: 0 }, tool), [enemy], feed), [])
    assert.equal(sendServerBolt(feet, facing, feed), false)
    for (const id of ['cleave', 'fingersnap', 'shadowstep', 'mend', 'stand', 'kindle', 'echo']) {
      assert.equal(canStartFight('outdoors', feet, id), false)
      assert.deepEqual(pressServerCast(id, feet, facing, null, [enemy], feed), { sent: false, fight: false, hits: [] })
    }
  }
  // The Hero uses this gate before setting cooldowns, spending mana or spawning
  // projectiles. It follows feet through the seam, independent of room labels.
  assert.equal(canStartFight('outdoors', { x: 40, y: 383 }), true)
  assert.equal(canStartFight('outdoors', { x: 40, y: 384 }), false)
  assert.equal(canStartFight('outdoors', feet, 'ward-light'), true)
  assert.equal(canStartFight('ruin', feet), true)
})
