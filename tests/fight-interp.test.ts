import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from '@bufbuild/protobuf'
import { FightJoinSchema, FightDeltaSchema, FightEventSchema, FightSwingResultSchema } from '../src/lib/gen/glimway/v2/presence_pb.js'
import { FightInterp, FIGHT_RESULT_TIMEOUT, FIGHT_RESYNC_GRACE } from '../src/lib/fight-interp.ts'
import { fightCrit } from '../src/lib/fight-math.ts'
import { fightOptions } from '../src/lib/fight-options.ts'

function rig(tick = 100) {
  let now = 1000
  const interp = new FightInterp(() => now)
  const join = create(FightJoinSchema, { room: 1, tick, critSeed: 123, roomKey: { world: 'world', realm: 'wilds', layer: 0, cx: 0, cy: 0, epoch: 'still' }, enemies: [{ enemy: 0, id: 'camp:0:0:0:0', campId: 'camp:0:0:0', kind: 1, x: 100, y: 100, hp: 28, maxHp: 28, state: 1, stateTick: tick, facing: 0 }] })
  interp.join(join)
  return { interp, join, advance: (ms: number) => { now += ms; interp.observe() }, delta: (at: number, changed: object[] = [{ enemy: 0, x: 120 }]) => interp.delta(create(FightDeltaSchema, { room: 1, tick: at, changed })) }
}

test('tick-stamped interpolation patches fields, holds through gaps, ignores stale deltas', () => {
  const r = rig()
  r.advance(100); r.delta(101); r.advance(50)
  const row = r.interp.draw()[0]!
  assert.equal(row.x, 110)
  assert.equal(row.row.hp, 28)
  assert.deepEqual(r.interp.seen(), { tick: 100, offsetMs: 50 })
  r.advance(2000)
  assert.equal(r.interp.draw()[0]!.x, 120)
  assert.equal(r.interp.draw()[0]!.row.state, 1)
  r.delta(100, [{ enemy: 0, hp: 0 }])
  assert.equal(r.interp.draw()[0]!.row.hp, 28)
})
test('delay rises under jitter, stays <=200, settles to100 without reversing drawn time', () => {
  const r = rig()
  r.advance(190); r.delta(101); r.advance(10)
  assert.ok(r.interp.measures().interpolationDelay > 180)
  let last = r.interp.seen()!.tick * 100 + r.interp.seen()!.offsetMs
  for (let tick = 102; tick < 175; tick++) {
    r.advance(100); r.delta(tick); r.interp.observe()
    const t = r.interp.seen()!
    assert.ok(t.tick * 100 + t.offsetMs >= last)
    last = t.tick * 100 + t.offsetMs
    assert.ok(r.interp.measures().interpolationDelay <= 200)
  }
  assert.equal(r.interp.measures().interpolationDelay, 100)
})
test('tick wrap and same world clock across rooms', () => {
  const r = rig(0xffffffff)
  r.advance(100); r.delta(0); r.advance(50)
  assert.equal(r.interp.draw()[0]!.x, 110)
  assert.deepEqual(r.interp.seen(), { tick: 0xffffffff, offsetMs: 50 })
  r.advance(100)
  assert.deepEqual(r.interp.seen(), { tick: 0, offsetMs: 50 })
})
test('late windup events use start and offset, survive late delta; duplicate effects once', () => {
  const r = rig()
  r.advance(300)
  const event = create(FightEventSchema, { room: 1, enemy: 0, kind: 1, tick: 101, offsetMs: 25 })
  r.interp.event(event); r.interp.event(event)
  const effects = r.interp.observe()
  assert.equal(effects.length, 1); assert.equal(effects[0]!.elapsedMs, 75)
  assert.equal(r.interp.draw()[0]!.telegraphMs, 75)
  r.advance(100)
  assert.equal(r.interp.draw()[0]!.telegraphMs, 175)
  r.delta(104, [{ enemy: 0, state: 2, stateTick: 101 }])
  r.advance(100)
  assert.equal(r.interp.draw()[0]!.telegraphMs, 275)
  assert.equal(r.interp.observe().length, 0)
})
test('knock offsets blend back over150ms without HP, phase or path mutation', () => {
  const r = rig(); r.advance(100)
  r.interp.knock({ room: 1, enemy: 0 }, 30, -10)
  assert.equal(r.interp.draw()[0]!.x, 130)
  r.advance(75); assert.equal(r.interp.draw()[0]!.x, 115)
  r.advance(75); assert.equal(r.interp.draw()[0]!.x, 100)
  assert.equal(r.interp.draw()[0]!.row.hp, 28)
  assert.equal(r.interp.draw()[0]!.row.state, 1)
})
test('seeded crits, row and swing refusals, duplicate results and pending timeout', () => {
  const r = rig()
  for (let c = 0; c < 100; c++) assert.equal(r.interp.crit(c, .2), fightCrit(123, c, .2))
  r.interp.sent(1, [{ room: 1, enemy: 0 }]); r.advance(180)
  const result = create(FightSwingResultSchema, { swingCounter: 1, hits: [{ room: 1, enemy: 0, refusedReason: 2 }] })
  r.interp.result(result); r.interp.result(result)
  assert.equal(r.interp.measures().refusedRows, 1)
  assert.equal(r.interp.measures().hitConfirmationP95, 180)
  for (const [counter, refusedReason] of [[2, 3], [3, 5], [4, 6]]) {
    r.interp.sent(counter!, [{ room: 1, enemy: 0 }]); r.interp.result(create(FightSwingResultSchema, { swingCounter: counter, refusedReason }))
  }
  assert.equal(r.interp.measures().swingRefusals, 3)
  r.interp.sent(5, []); r.advance(FIGHT_RESULT_TIMEOUT)
  assert.equal(r.interp.measures().timeouts, 1)
  assert.equal(r.interp.measures().pending, 0)
})
test('spawn/remove, room rejoin and close discard buffers; camp deaths retain completion', () => {
  const r = rig(); r.advance(100)
  r.interp.event(create(FightEventSchema, { room: 1, enemy: 0, tick: 100, kind: 3 }))
  r.interp.observe()
  assert.equal(r.interp.campWon('camp:0:0:0', 'still'), true)
  r.delta(101, [])
  r.interp.delta(create(FightDeltaSchema, { room: 1, tick: 102, removed: [0] }))
  r.advance(200)
  assert.equal(r.interp.draw().length, 0)
  assert.equal(r.interp.campWon('camp:0:0:0', 'still'), true)
  r.interp.join(r.join)
  assert.equal(r.interp.campWon('camp:0:0:0', 'still'), false)
  r.interp.event(create(FightEventSchema, { room: 1, tick: 100, kind: 5 }))
  r.interp.observe(); assert.equal(r.interp.rooms.size, 1)
  r.advance(FIGHT_RESYNC_GRACE); assert.equal(r.interp.rooms.size, 0)
})
test('flags reserve one camp and clamp latency knobs', () => {
  assert.deepEqual(fightOptions('?fights=server&fightsCamp=camp:1:0:0&lag=150&jitter=50'), { enabled: true, camp: 'camp:1:0:0', lag: 150, jitter: 50 })
  assert.equal(fightOptions('?lag=-5&jitter=Infinity').jitter, 5000)
  assert.equal(fightOptions('').enabled, false)
})

test('aim-lock hints preserve sub-tick windup origin; new state ends the event pose', () => {
  const r = rig(); r.advance(100)
  r.interp.event(create(FightEventSchema, { room: 1, enemy: 0, tick: 100, offsetMs: 25, kind: 1 }))
  r.interp.event(create(FightEventSchema, { room: 1, enemy: 0, tick: 101, offsetMs: 75, kind: 2 }))
  r.advance(200)
  assert.equal(r.interp.draw()[0]!.telegraphMs, 175)
  assert.equal(r.interp.draw()[0]!.aimLocked, true)
  r.delta(102, [{ enemy: 0, state: 3, stateTick: 102 }]); r.advance(100)
  assert.equal(r.interp.draw()[0]!.telegraphMs, undefined)
  assert.equal(r.interp.draw()[0]!.row.state, 3)
})
test('same-handle rejoin resets prediction and increments the renderer incarnation', () => {
  const r = rig(); r.advance(100)
  const old = r.interp.draw()[0]!.incarnation
  r.interp.knock({ room: 1, enemy: 0 }, 25, 0)
  r.interp.join(r.join); r.interp.observe()
  assert.equal(r.interp.draw()[0]!.x, 100)
  assert.notEqual(r.interp.draw()[0]!.incarnation, old)
})
test('a removal is held until the drawn instant, preserving its scheduled death effect', () => {
  const r = rig(); r.advance(100)
  r.interp.delta(create(FightDeltaSchema, { room: 1, tick: 101, removed: [0] }))
  r.interp.event(create(FightEventSchema, { room: 1, enemy: 0, tick: 101, kind: 3 }))
  assert.equal(r.interp.draw().length, 1)
  r.advance(100)
  assert.equal(r.interp.draw().length, 0)
  assert.equal(r.interp.campWon('camp:0:0:0', 'still'), true)
})

test('join and spawn wait for their server stamp so targets match the reported instant', () => {
  const r = rig(); r.interp.observe()
  assert.equal(r.interp.draw().length, 0)
  r.advance(100); assert.equal(r.interp.draw().length, 1)
  r.interp.delta(create(FightDeltaSchema, { room: 1, tick: 101, spawned: [{ ...r.join.enemies[0]!, enemy: 1, id: 'second' }] }))
  assert.equal(r.interp.draw().length, 1)
  r.advance(100); assert.equal(r.interp.draw().length, 2)
})

test('same-tick delta applies every optional field after a join and rejects only older ticks', () => {
  const r = rig(); r.advance(100)
  r.delta(100, [{ enemy: 0, hp: 20, x: 110, state: 2, stateTick: 100, facing: 64 }]); r.interp.observe()
  assert.deepEqual([r.interp.draw()[0]!.row.hp, r.interp.draw()[0]!.row.x, r.interp.draw()[0]!.row.state, r.interp.draw()[0]!.row.facing], [20, 110, 2, 64])
  r.delta(100, [{ enemy: 0, hp: 0 }]); r.interp.observe()
  assert.equal(r.interp.draw()[0]!.row.hp, 0)
  r.delta(99, [{ enemy: 0, hp: 28 }]); assert.equal(r.interp.draw()[0]!.row.hp, 0)
})
test('close and same full key resync retains incarnation, drawn history, predicted knock and pending swing', () => {
  const r = rig(); r.advance(100)
  const incarnation = r.interp.draw()[0]!.incarnation
  r.interp.knock({ room: 1, enemy: 0 }, 30, 0)
  r.interp.sent(0, [{ room: 1, enemy: 0 }])
  r.interp.event(create(FightEventSchema, { room: 1, tick: 101, kind: 5 })); r.advance(50)
  assert.equal(r.interp.draw()[0]!.incarnation, incarnation)
  assert.equal(r.interp.draw()[0]!.x, 120)
  const refresh = create(FightJoinSchema, { ...r.join, tick: 101, enemies: [{ ...r.join.enemies[0]!, hp: 20 }] })
  r.interp.join(refresh)
  assert.equal(r.interp.draw()[0]!.incarnation, incarnation)
  assert.equal(r.interp.draw()[0]!.x, 120)
  assert.equal(r.interp.measures().pending, 1)
  r.advance(50); assert.equal(r.interp.draw()[0]!.row.hp, 20)
  r.advance(FIGHT_RESYNC_GRACE)
  assert.equal(r.interp.rooms.size, 1, 'queued close cannot kill the refreshed view')
})
test('grace expired or a changed epoch is a new incarnation, while a new handle for the same key resyncs', () => {
  const r = rig(); r.advance(100)
  const original = r.interp.draw()[0]!.incarnation
  r.interp.event(create(FightEventSchema, { room: 1, tick: 100, kind: 5 }))
  r.interp.join(create(FightJoinSchema, { ...r.join, room: 2 }))
  assert.equal(r.interp.draw()[0]!.incarnation, original)
  assert.equal(r.interp.draw()[0]!.room, 2)
  r.interp.event(create(FightEventSchema, { room: 2, tick: 100, kind: 5 }))
  r.interp.join(create(FightJoinSchema, { ...r.join, room: 3, roomKey: { ...r.join.roomKey!, epoch: 'next' } }))
  assert.notEqual(r.interp.draw()[0]!.incarnation, original)
  const changed = r.interp.draw()[0]!.incarnation
  r.interp.event(create(FightEventSchema, { room: 3, tick: 100, kind: 5 })); r.advance(FIGHT_RESYNC_GRACE)
  assert.equal(r.interp.draw().length, 0)
  r.interp.join(create(FightJoinSchema, { ...r.join, room: 3, roomKey: { ...r.join.roomKey!, epoch: 'next' } }))
  assert.notEqual(r.interp.draw()[0]!.incarnation, changed)
})
