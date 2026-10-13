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
  return { interp, join, wait: (ms: number) => { now += ms }, advance: (ms: number) => { now += ms; interp.observe() }, delta: (at: number, changed: object[] = [{ enemy: 0, x: 120 }]) => interp.delta(create(FightDeltaSchema, { room: 1, tick: at, changed })) }
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
test('consecutive deltas in one arrival batch do not turn tick spacing into jitter', () => {
  const r = rig()
  r.advance(100)
  r.delta(101)
  r.delta(102)
  assert.equal(r.interp.measures().snapshotSamples, 1)
  assert.equal(r.interp.measures().interpolationDelay, 100)
  r.advance(100)
  r.delta(103)
  assert.equal(r.interp.measures().snapshotSamples, 2)
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
test('clear resets interpolation and fight metrics for the new socket session', () => {
  const r = rig()
  r.advance(190); r.delta(101)
  r.interp.sent(1, [{ room: 1, enemy: 0 }]); r.advance(180)
  r.interp.result(create(FightSwingResultSchema, { swingCounter: 1, hits: [{ room: 1, enemy: 0, refusedReason: 2 }] }))
  assert.ok(r.interp.measures().snapshotSamples > 0)
  assert.equal(r.interp.measures().confirmations, 1)
  r.interp.clear()
  assert.deepEqual(r.interp.measures(), { scope: 'socket-session', snapshotGapP95: 0, snapshotSamples: 0, interpolationDelay: 100, hitConfirmationP95: 0, confirmations: 0, predictedRows: 0, refusedRows: 0, refusedPercent: 0, swingRefusals: 0, timeouts: 0, pending: 0 })
})
test('spawn/remove, room rejoin and close discard buffers; a removed corpse is absent, never a win', () => {
  const r = rig(); r.advance(100)
  r.interp.event(create(FightEventSchema, { room: 1, enemy: 0, tick: 100, kind: 3 }))
  r.interp.observe()
  assert.equal(r.interp.campWon('camp:0:0:0', 'still'), true)
  r.delta(101, [])
  r.interp.delta(create(FightDeltaSchema, { room: 1, tick: 102, removed: [0] }))
  r.advance(200)
  assert.equal(r.interp.draw().length, 0)
  assert.equal(r.interp.campWon('camp:0:0:0', 'still'), undefined, 'no rows: unknown')
  r.interp.join(r.join)
  assert.equal(r.interp.campWon('camp:0:0:0', 'still'), false)
  r.interp.event(create(FightEventSchema, { room: 1, tick: 100, kind: 5 }))
  r.interp.observe(); assert.equal(r.interp.rooms.size, 1)
  r.advance(FIGHT_RESYNC_GRACE); assert.equal(r.interp.rooms.size, 0)
})
test('no ownership flag survives; latency knobs clamp', () => {
  assert.deepEqual(fightOptions('?fights=server&fightsCamp=camp:1:0:0&lag=150&jitter=50'), { lag: 150, jitter: 50 })
  assert.equal(fightOptions('?lag=-5&jitter=Infinity').jitter, 5000)
  assert.deepEqual(fightOptions(''), { lag: 0, jitter: 0 })
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
test('a same-key rejoin of a live room refreshes it: same incarnation and life, prediction kept', () => {
  const r = rig(); r.advance(100)
  const { incarnation, life } = r.interp.draw()[0]!
  r.interp.knock({ room: 1, enemy: 0 }, 25, 0)
  r.interp.join(create(FightJoinSchema, { ...r.join, tick: 101, enemies: [{ ...r.join.enemies[0]!, hp: 20 }] })); r.interp.observe()
  assert.deepEqual([r.interp.draw()[0]!.incarnation, r.interp.draw()[0]!.life], [incarnation, life])
  assert.ok(r.interp.draw()[0]!.x > 100, 'the predicted knock still blends')
  r.advance(100); assert.equal(r.interp.draw()[0]!.row.hp, 20)
})
test('a removal is held until the drawn instant, preserving its scheduled death effect', () => {
  const r = rig(); r.advance(100)
  r.interp.delta(create(FightDeltaSchema, { room: 1, tick: 101, removed: [0] }))
  r.interp.event(create(FightEventSchema, { room: 1, enemy: 0, tick: 101, kind: 3 }))
  assert.equal(r.interp.draw().length, 1)
  r.advance(100)
  assert.equal(r.interp.draw().length, 0)
  assert.equal(r.interp.campWon('camp:0:0:0', 'still'), undefined)
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

test('camp scaling and a cycle respawn: spawned rows count at once, removed corpses leave, each row is a new life', () => {
  const r = rig(); r.advance(100)
  const first = r.interp.draw()[0]!.life
  // First aggro freezes the camp at two: an extra rises.
  r.interp.delta(create(FightDeltaSchema, { room: 1, tick: 101, spawned: [{ ...r.join.enemies[0]!, enemy: 1, id: 'camp:0:0:0:1' }] }))
  r.interp.event(create(FightEventSchema, { room: 1, enemy: 0, tick: 101, kind: 3 })); r.delta(101, [{ enemy: 0, hp: 0, state: 6, stateTick: 101 }])
  assert.equal(r.interp.campWon('camp:0:0:0', 'still'), false, 'the extra still stands')
  r.interp.delta(create(FightDeltaSchema, { room: 1, tick: 102, changed: [{ enemy: 1, hp: 0, state: 6, stateTick: 102 }] }))
  assert.equal(r.interp.campWon('camp:0:0:0', 'still'), true)
  r.advance(200)
  // The next cycle, in the same room: corpses removed, fresh rows with new ids and indices.
  r.interp.delta(create(FightDeltaSchema, { room: 1, tick: 104, removed: [0, 1], spawned: [{ ...r.join.enemies[0]!, enemy: 2, id: 'camp:0:0:0:2', stateTick: 104 }] }))
  assert.equal(r.interp.campWon('camp:0:0:0', 'still'), false, 'old corpses never complete the new cycle')
  r.advance(300)
  const drawn = r.interp.draw()
  assert.deepEqual(drawn.map(d => d.row.id), ['camp:0:0:0:2'])
  assert.notEqual(drawn[0]!.life, first)
})

test('a refresh whose row stands where a corpse was is a new life, never a resurrection', () => {
  const r = rig(); r.advance(100)
  r.delta(101, [{ enemy: 0, hp: 0, state: 6, stateTick: 101 }]); r.advance(100)
  const dead = r.interp.draw()[0]!
  assert.equal(dead.row.state, 6)
  r.interp.join(create(FightJoinSchema, { ...r.join, room: 2, tick: 103 })); r.advance(100)
  const drawn = r.interp.draw()
  assert.equal(drawn.length, 1, 'the corpse leaves at the refresh stamp')
  assert.equal(drawn[0]!.row.state, 1)
  assert.notEqual(drawn[0]!.life, dead.life)
  assert.equal(drawn[0]!.incarnation, dead.incarnation, 'the room itself is the same')
})

test('chunk crossings never reset a room still in the 3×3: the same incarnation, samples and seed', () => {
  const r = rig(); r.advance(100)
  const before = r.interp.draw()[0]!
  r.interp.join(create(FightJoinSchema, { ...r.join, room: 7, tick: 101 })); r.advance(100)
  assert.equal(r.interp.seed, 123)
  assert.deepEqual([r.interp.draw()[0]!.incarnation, r.interp.draw()[0]!.life, r.interp.draw()[0]!.room], [before.incarnation, before.life, 7])
})


test('independent arrivals during a slow render frame retain real jitter', () => {
  const r = rig();
  r.wait(100); r.delta(101);
  r.wait(100); r.delta(102);
  r.wait(150); r.delta(103);
  assert.equal(r.interp.measures().snapshotSamples, 3);
  assert.equal(r.interp.measures().snapshotGapP95, 150);
  assert.equal(r.interp.measures().interpolationDelay, 150);
});

test('a resync in the same render frame accepts the next arrival gap', () => {
  const r = rig(); r.wait(100); r.delta(101);
  r.interp.join(create(FightJoinSchema, { ...r.join, tick: 101 }));
  r.wait(180); r.delta(102);
  assert.equal(r.interp.measures().snapshotSamples, 2);
  assert.equal(r.interp.measures().snapshotGapP95, 180);
  assert.equal(r.interp.measures().interpolationDelay, 180);
});

test('high-resolution burst delivery is coalesced without concealing later arrivals', () => {
  const r = rig(); r.wait(100); r.delta(101);
  r.wait(.2); r.delta(102);
  r.wait(.2); r.delta(103);
  assert.equal(r.interp.measures().snapshotSamples, 1);
  assert.equal(r.interp.measures().interpolationDelay, 100);
  r.wait(140); r.delta(104);
  assert.equal(r.interp.measures().snapshotSamples, 2);
  assert.equal(r.interp.measures().snapshotGapP95, 140);
});

test('fight measurements label their socket session scope and survive room churn', () => {
  const r = rig(); r.wait(150); r.delta(101);
  assert.equal(r.interp.measures().scope, 'socket-session');
  r.interp.drop(1);
  assert.equal(r.interp.measures().snapshotSamples, 1);
});
