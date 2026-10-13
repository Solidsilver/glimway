import './helpers/svelte-runes.ts'
import './helpers/scene-modules.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { create, toBinary } from '@bufbuild/protobuf'
import { FightJoinSchema, FightEventSchema, FightDeltaSchema, PresenceFrameSchema } from '../src/lib/gen/glimway/v2/presence_pb.js'
import { decodePresenceFrame } from '../src/lib/presence-codec.ts'
import { FightInterp, FIGHT_RESYNC_GRACE } from '../src/lib/fight-interp.ts'
import { pressServerSwing } from '../src/game/entities/fight-strike.ts'
import { slashStrike } from '../src/game/entities/fight-rules.ts'
const { ServerEnemies } = await import('../src/game/entities/server-enemies.ts')
const { perfFights } = await import('../src/game/perf.ts')

function rig() {
  let now = 1000, available = true, spawned = 0, destroyed = 0, tells = 0
  const fights = new FightInterp(() => now)
  const sprites: any[] = [], enemies: any[] = [], poses: string[] = [], floats: string[] = []
  const sprite = () => {
    const s: any = { active: true, body: { enable: true }, x: 100, y: 100, destroy() { assert.equal(this.active, true, 'no repeated destruction'); this.active = false; destroyed++ } }
    for (const name of ['setPosition', 'setDepth', 'setFlipX', 'setTintFill', 'clearTint', 'setTint', 'setAlpha', 'setVisible']) s[name] = (...args: number[]) => { if (name === 'setPosition') [s.x, s.y] = args; return s }
    sprites.push(s); return s
  }
  const system: any = { parkedAll: false, scene: { time: { get now() { return now }, delayedCall() {} }, tweens: { add() {} } }, deps: { hero: () => ({ sprite: { x: 80, y: 100 }, facing: { x: 1, y: 0 } }), fx: { floatText: (_x: number, _y: number, t: string) => floats.push(t) } },
    spawnWilds(id: string, type: string) { spawned++; const enemy = { id, type, sprite: sprite(), x: 100, y: 100, maxHp: 28, hp: 28, state: 'chase', dead: false }; enemies.push(enemy); return enemy },
    forget(enemy: object) { const index = enemies.indexOf(enemy); if (index >= 0) enemies.splice(index, 1) },
    setEnemyPose(enemy: any, pose: string) { poses.push(`${enemy.type}:${pose}`) }, telegraph() { tells++ }, showDeath(enemy: object) { this.forget(enemy) } }
  const feed = { fights }
  const owner = new ServerEnemies(system, () => available ? feed : null)
  const join = create(FightJoinSchema, { room: 1, tick: 100, critSeed: 123, roomKey: { world: 'w', realm: 'wilds', epoch: 'still', cx: 0, cy: 0 }, enemies: [{ enemy: 0, id: 'wilds:camp:0:0:0:0', campId: 'camp:0:0:0', kind: 1, x: 100, y: 100, state: 2, stateTick: 100, hp: 28, maxHp: 28 }] })
  const advance = (ms: number) => { now += ms; owner.observe() }
  return { fights, feed, owner, join, advance, sprites, enemies, poses, floats, system, now: () => now, get spawned() { return spawned }, get destroyed() { return destroyed }, get tells() { return tells }, disconnect() { fights.clear(); available = false; owner.observe() }, reconnect() { available = true; fights.join(join); advance(100) } }
}
test('renderer retains sprites, telegraph and swing prediction across close/resync without spawning twice', () => {
  const r = rig(); r.fights.join(r.join); r.advance(100)
  const original = r.enemies[0]
  assert.equal(r.spawned, 1); assert.equal(original.sprite.body.enable, false)
  assert.equal(r.tells, 1)
  r.owner.owner.struck(original, { amount: 5, crit: false }, 80)
  r.fights.event(create(FightEventSchema, { room: 1, tick: 100, kind: 5 })); r.advance(50)
  const sent: any[] = []
  const feed = { ...r.feed, nextSwing: () => 0, swing: (s: object) => { sent.push(s); return true } }
  const hits = pressServerSwing(slashStrike({ x: 80, y: 100 }, { x: 1, y: 0 }, { meleeDamage: 5, critChance: 0 }, false), r.enemies, feed)
  assert.equal(hits.length, 1); assert.deepEqual(sent[0].predicted, [{ room: 1, enemy: 0 }])
  r.fights.join(create(FightJoinSchema, { ...r.join, tick: 101, enemies: [{ ...r.join.enemies[0]!, hp: 23 }] })); r.owner.observe()
  assert.equal(r.enemies[0], original); assert.equal(r.spawned, 1); assert.equal(r.destroyed, 0)
  assert.equal(r.tells, 1, 'the same telegraph is not restarted')
  r.advance(1000); assert.equal(r.enemies[0], original)
})
test('renderer releases close-expired and disconnected views; reconnect creates exactly one new sprite', () => {
  const r = rig(); r.fights.join(r.join); r.advance(100)
  r.fights.event(create(FightEventSchema, { room: 1, tick: 100, kind: 5 })); r.advance(FIGHT_RESYNC_GRACE)
  assert.equal(r.destroyed, 1); assert.equal(r.enemies.length, 0)
  assert.equal((r.owner as any).drawn.size, 0)
  r.fights.join(r.join); r.advance(100); r.owner.observe()
  assert.equal(r.spawned, 2); assert.equal(r.enemies.length, 1)
  r.disconnect(); r.owner.observe()
  assert.equal(r.destroyed, 2); assert.equal((r.owner as any).drawn.size, 0)
  r.reconnect(); r.owner.observe(); assert.equal(r.spawned, 3); assert.equal(r.enemies.length, 1)
  r.disconnect(); assert.equal(r.destroyed, 3)
})
test('same-key resync with another view handle updates wire reference without respawning', () => {
  const r = rig(); r.fights.join(r.join); r.advance(100)
  const enemy = r.enemies[0]
  r.fights.event(create(FightEventSchema, { room: 1, tick: 100, kind: 5 }))
  r.fights.join(create(FightJoinSchema, { ...r.join, room: 2 })); r.owner.observe()
  assert.equal(r.enemies[0], enemy); assert.deepEqual(enemy.fight, { room: 2, enemy: 0 })
  assert.equal(r.spawned, 1); assert.equal(r.destroyed, 0)
})
test('a fallen camp’s corpse-only join renders nothing and reads as completed rows', () => {
  const r = rig()
  r.fights.join(create(FightJoinSchema, { ...r.join, enemies: [{ ...r.join.enemies[0]!, state: 6, hp: 0 }] })); r.advance(100)
  assert.equal(r.spawned, 0); assert.equal(r.fights.campWon('camp:0:0:0', 'still'), true)
})
test('disabled perf instrumentation never computes or sorts fight measurements', () => {
  perfFights({ measures() { assert.fail('measurements should be lazy without perf=1') } })
})

test('a resync confirms a death missed during the view gap on the existing sprite', () => {
  const r = rig(); r.fights.join(r.join); r.advance(100)
  const original = r.enemies[0]
  r.fights.event(create(FightEventSchema, { room: 1, tick: 100, kind: 5 }))
  r.fights.join(create(FightJoinSchema, { ...r.join, tick: 101, enemies: [{ ...r.join.enemies[0]!, state: 6, stateTick: 101, hp: 0 }] }))
  r.owner.observe(); assert.equal(r.enemies[0], original)
  r.advance(100); assert.equal(original.dead, true); assert.equal(r.enemies.length, 0)
  assert.equal(r.spawned, 1); assert.equal(r.destroyed, 0)
})

test('a cycle respawn in the same room draws a new sprite; the death event reaches the newest life', () => {
  const r = rig(); r.fights.join(r.join); r.advance(100)
  const first = r.enemies[0]
  r.fights.delta(create(FightDeltaSchema, { room: 1, tick: 101, changed: [{ enemy: 0, hp: 0, state: 6, stateTick: 101 }] }))
  r.fights.event(create(FightEventSchema, { room: 1, tick: 101, enemy: 0, kind: 3 })); r.advance(300)
  assert.equal(first.dead, true)
  r.fights.delta(create(FightDeltaSchema, { room: 1, tick: 105, removed: [0], spawned: [{ ...r.join.enemies[0]!, enemy: 1, id: 'wilds:camp:0:0:0:1', state: 1, stateTick: 105 }] }))
  r.fights.event(create(FightEventSchema, { room: 1, tick: 105, enemy: 1, kind: 4 })); r.advance(300)
  assert.equal(r.spawned, 2, 'a new life, a new sprite')
  const second = r.enemies.find(e => e !== first)!
  assert.equal(second.dead, false); assert.deepEqual(second.fight, { room: 1, enemy: 1 })
  r.fights.event(create(FightEventSchema, { room: 1, tick: 106, enemy: 1, kind: 3 })); r.advance(200)
  assert.equal(second.dead, true, 'confirmed by the room')
})

test('server enemies die only on the room’s word: a predicted lethal hit leaves HP and life to the snapshots', () => {
  const r = rig(); r.fights.join(r.join); r.advance(100)
  const enemy = r.enemies[0]
  r.owner.owner.struck(enemy, { amount: 999, crit: true }, 80)
  r.advance(100)
  assert.equal(enemy.dead, false); assert.equal(enemy.hp, 28)
})

test('beetles keep their art and poses: kind 2 spawns a beetle; lunge squashes, stunned hurts; Stand predicts its daze', () => {
  const r = rig()
  r.fights.join(create(FightJoinSchema, { ...r.join, enemies: [{ ...r.join.enemies[0]!, kind: 2, state: 3, stateTick: 100, maxHp: 40, hp: 40 }] })); r.advance(100)
  const beetle = r.enemies[0]
  assert.equal(beetle.type, 'beetle'); assert.equal(beetle.maxHp, 40)
  assert.equal(r.poses.at(-1), 'beetle:squash')
  r.fights.delta(create(FightDeltaSchema, { room: 1, tick: 101, changed: [{ enemy: 0, state: 5, stateTick: 101 }] })); r.advance(100)
  assert.equal(beetle.state, 'stunned'); assert.equal(r.poses.at(-1), 'beetle:hurt')
  r.fights.delta(create(FightDeltaSchema, { room: 1, tick: 102, changed: [{ enemy: 0, state: 3, stateTick: 102 }] })); r.advance(100)
  r.owner.owner.stopped(beetle, 0.8); r.advance(16)
  assert.equal(r.poses.at(-1), 'beetle:hurt'); assert.deepEqual(r.floats, ['Staggered'])
  assert.equal(beetle.state, 'lunge', 'the room decides the stagger')
})

test('parked server enemies (dev only): off the map for targets and contact, room still updating, death silent, camp unfallen', () => {
  const r = rig(); r.system.parkedAll = true
  r.fights.join(r.join); r.advance(100)
  const enemy = r.enemies[0]
  assert.equal(enemy.parked, true)
  assert.deepEqual([enemy.x, enemy.y, enemy.sprite.x, enemy.sprite.y], [-2000, -2000, -2000, -2000], 'off the map for every reader')
  const tells = r.tells
  r.fights.delta(create(FightDeltaSchema, { room: 1, tick: 101, changed: [{ enemy: 0, hp: 20, state: 2, stateTick: 101 }] }))
  r.fights.event(create(FightEventSchema, { room: 1, tick: 101, enemy: 0, kind: 1 })); r.advance(200)
  assert.equal(enemy.hp, 20, 'the room’s state still arrives'); assert.equal(r.tells, tells, 'no telegraph plays')
  const hits = pressServerSwing(slashStrike({ x: 100, y: 100 }, { x: 1, y: 0 }, { meleeDamage: 5, critChance: 0 }, false), r.enemies, { ...r.feed, nextSwing: () => 0, swing: () => true })
  assert.equal(hits.length, 0, 'out of reach where it is parked')
  assert.equal(r.fights.campWon('camp:0:0:0', 'still'), false, 'parking is not a fall')
  r.fights.event(create(FightEventSchema, { room: 1, tick: 102, enemy: 0, kind: 3 })); r.advance(200)
  assert.equal(enemy.dead, true); assert.equal(r.enemies.length, 0); assert.equal(enemy.sprite.active, false)
})

// The websocket may deliver a wind-up and its later lunge together. Every
// event still reaches the observation model, whose stamped history draws both.
test('coalesced presence events retain the wind-up before the later lunge is drawn', () => {
  const r = rig()
  r.fights.join(create(FightJoinSchema, { ...r.join, enemies: [{ ...r.join.enemies[0]!, state: 1 }] }))
  r.advance(100)
  const bytes = toBinary(PresenceFrameSchema, create(PresenceFrameSchema, { events: [
    { event: { case: 'fightDelta', value: create(FightDeltaSchema, { room: 1, tick: 101, changed: [{ enemy: 0, state: 2, stateTick: 101 }] }) } },
    { event: { case: 'fightEvent', value: create(FightEventSchema, { room: 1, enemy: 0, tick: 101, kind: 1 }) } },
    { event: { case: 'fightDelta', value: create(FightDeltaSchema, { room: 1, tick: 106, changed: [{ enemy: 0, state: 3, stateTick: 106 }] }) } }
  ] }))
  const events = decodePresenceFrame(bytes)
  assert.equal(events.length, 3)
  for (const event of events) {
    if (event.type === 'fightDelta') r.fights.delta(event)
    if (event.type === 'fightEvent') r.fights.event(event)
  }
  r.owner.observe()
  assert.equal(r.enemies[0].state, 'telegraph')
  assert.equal(r.poses.at(-1), 'wisp:windup')
  assert.equal(r.tells, 1)
  r.advance(100)
  assert.equal(r.enemies[0].state, 'lunge')
  assert.equal(r.poses.at(-1), 'wisp:idle')
  assert.equal(r.tells, 1, 'the tell is not restarted by the later delta')
})
