import './helpers/svelte-runes.ts'
import './helpers/scene-modules.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from '@bufbuild/protobuf'
import { FightJoinSchema, FightEventSchema } from '../src/lib/gen/glimway/v2/presence_pb.js'
import { FightInterp, FIGHT_RESYNC_GRACE } from '../src/lib/fight-interp.ts'
import { pressServerSwing } from '../src/game/entities/fight-strike.ts'
import { slashStrike } from '../src/game/entities/fight-rules.ts'
const { ServerEnemies } = await import('../src/game/entities/server-enemies.ts')
const { perfFights } = await import('../src/game/perf.ts')

function rig() {
  let now = 1000, available = true, spawned = 0, destroyed = 0, tells = 0
  const fights = new FightInterp(() => now)
  const sprites: any[] = [], enemies: any[] = [], replaced: string[] = []
  const sprite = () => {
    const s: any = { active: true, body: { enable: true }, x: 100, y: 100, destroy() { assert.equal(this.active, true, 'no repeated destruction'); this.active = false; destroyed++ } }
    for (const name of ['setPosition', 'setDepth', 'setFlipX', 'setTintFill', 'clearTint', 'setTint', 'setAlpha']) s[name] = (...args: number[]) => { if (name === 'setPosition') [s.x, s.y] = args; return s }
    sprites.push(s); return s
  }
  const system: any = { scene: { time: { get now() { return now }, delayedCall() {} }, tweens: { add() {} } }, deps: { hero: () => ({ sprite: { x: 80, y: 100 }, facing: { x: 1, y: 0 } }) },
    removeLocalCamp: (id: string) => replaced.push(id),
    spawnWilds(id: string, type: string) { spawned++; const enemy = { id, type, sprite: sprite(), x: 100, y: 100, maxHp: 28, hp: 28, state: 'chase', dead: false }; enemies.push(enemy); return enemy },
    forget(enemy: object) { const index = enemies.indexOf(enemy); if (index >= 0) enemies.splice(index, 1) },
    setEnemyPose() {}, telegraph() { tells++ }, showDeath(enemy: object) { this.forget(enemy) } }
  const feed = { fights, serverFights: true }
  const owner = new ServerEnemies(system, () => available ? feed : null)
  const join = create(FightJoinSchema, { room: 1, tick: 100, critSeed: 123, roomKey: { world: 'w', realm: 'wilds', epoch: 'still', cx: 0, cy: 0 }, enemies: [{ enemy: 0, id: 'wilds:camp:0:0:0:0', campId: 'camp:0:0:0', kind: 1, x: 100, y: 100, state: 2, stateTick: 100, hp: 28, maxHp: 28 }] })
  const advance = (ms: number) => { now += ms; owner.observe() }
  return { fights, feed, owner, join, advance, sprites, enemies, replaced, get spawned() { return spawned }, get destroyed() { return destroyed }, get tells() { return tells }, disconnect() { fights.clear(); available = false; owner.observe() }, reconnect() { available = true; fights.join(join); advance(100) } }
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
test('a fresh all-corpse join removes advertised local copies without rendering corpses', () => {
  const r = rig()
  r.fights.join(create(FightJoinSchema, { ...r.join, enemies: [{ ...r.join.enemies[0]!, state: 6, hp: 0 }] })); r.advance(100)
  assert.deepEqual(r.replaced, ['camp:0:0:0'])
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
