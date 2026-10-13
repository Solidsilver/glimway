import './helpers/svelte-runes.ts'
import './helpers/scene-modules.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { create } from '@bufbuild/protobuf'
import { FightJoinSchema, FightDeltaSchema, FightEventSchema } from '../src/lib/gen/glimway/v2/presence_pb.js'
import { FightInterp, FIGHT_RESYNC_GRACE } from '../src/lib/fight-interp.ts'
const { EnemySystem } = await import('../src/game/entities/enemies.ts')
const { ServerEnemies } = await import('../src/game/entities/server-enemies.ts')

function rig() {
  let now = 1000, created = 0
  const registered = new Set<object>(), sprites: any[] = [], tweens: any[] = []
  const scene: any = {
    events: new EventEmitter(),
    physics: { add: {
      sprite(x: number, y: number) {
        const events = new EventEmitter()
        const sprite: any = { x, y, active: true, body: { enable: true, setSize() {}, setOffset() {}, setCollideWorldBounds() {}, setVelocity() {} },
          once: events.once.bind(events), destroy() { if (!this.active) return; this.active = false; events.emit('destroy') } }
        for (const method of ['setOrigin', 'setScale', 'setDepth', 'setFlipX', 'setTintFill', 'clearTint', 'setTint', 'setAlpha', 'setVisible', 'play']) sprite[method] = () => sprite
        sprite.setPosition = (x: number, y: number) => { sprite.x = x; sprite.y = y; return sprite }
        sprites.push(sprite); return sprite
      },
      collider() { created++; const collider = { destroy() { assert.ok(registered.delete(collider), 'collider destroyed once') } }; registered.add(collider); return collider }
    } },
    textures: { get: () => ({ get: () => ({ width: 32, height: 32 }) }) }, anims: { exists: () => false },
    add: { graphics: () => ({ setDepth() { return this } }), particles: () => ({ explode() {}, destroy() {} }) },
    time: { get now() { return now }, delayedCall() {} }, tweens: { add: (t: object) => tweens.push(t) }
  }
  const system = new EnemySystem(scene, { world: { enemies: [], areaId: 'woodland' }, session: { recordDefeat() {} }, solidGroup: {}, fx: {}, hero: () => ({ sprite: { x: 0, y: 0 }, facing: { x: 1, y: 0 } }) } as any, { defeatedEnemies: [] } as any)
  // Art poses are irrelevant to physics registration; spawning and death use the real system.
  system.setEnemyPose = () => {}
  const fights = new FightInterp(() => now), owner = new ServerEnemies(system, () => ({ fights }))
  const join = create(FightJoinSchema, { room: 1, tick: 100, critSeed: 123, roomKey: { world: 'w', realm: 'wilds', epoch: 'still', cx: 0, cy: 0 }, enemies: [{ enemy: 0, id: 'camp:0:0:0:0', campId: 'camp:0:0:0', kind: 1, x: 100, y: 100, hp: 28, maxHp: 28, state: 1, stateTick: 100 }] })
  return { system, fights, owner, join, registered, sprites, get created() { return created }, advance(ms: number) { now += ms; owner.observe() }, dissolve() { for (const t of tweens.splice(0)) t.onComplete?.() } }
}

test('real local spawn and death cycles keep exactly the live colliders registered', () => {
  const r = rig()
  for (let life = 0; life < 20; life++) {
    const enemy = r.system.spawnEnemy(`wisp-${life}`, 'wisp', 0, 0)
    assert.equal(r.registered.size, 1)
    ;(r.system as any).killEnemy(enemy)
    assert.equal(r.registered.size, 1, 'collider belongs to the dissolving sprite until destruction')
    r.dissolve()
    assert.equal(r.registered.size, 0, 'death unregisters the collider')
    assert.equal(r.system.enemies.length, 0)
  }
  assert.equal(r.created, 20)
})

test('real server spawn, respawn, death and room removal never register colliders', () => {
  const r = rig()
  for (let life = 0; life < 10; life++) {
    r.fights.clear() // Each reconnect starts a new socket session, including event deduplication.
    r.fights.join(r.join); r.advance(100)
    assert.equal(r.system.enemies.length, 1)
    assert.equal(r.system.enemies[0]!.sprite.body!.enable, false)
    assert.equal(r.registered.size, 0)
    r.fights.delta(create(FightDeltaSchema, { room: 1, tick: 101, changed: [{ enemy: 0, hp: 0, state: 6 }] }))
    r.fights.event(create(FightEventSchema, { room: 1, tick: 101, enemy: 0, kind: 3 })); r.advance(200); r.dissolve()
    r.fights.delta(create(FightDeltaSchema, { room: 1, tick: 104, removed: [0], spawned: [{ ...r.join.enemies[0]!, enemy: 1, id: `life-${life}` }] })); r.advance(300)
    assert.equal(r.system.enemies.length, 1)
    assert.equal(r.registered.size, 0)
    r.fights.event(create(FightEventSchema, { room: 1, tick: 104, kind: 5 })); r.advance(FIGHT_RESYNC_GRACE)
    assert.equal(r.system.enemies.length, 0)
    assert.equal(r.registered.size, 0)
    assert.ok(r.sprites.every(sprite => !sprite.active))
  }
  assert.equal(r.created, 0, 'disabled server bodies never need solid-wall colliders')
})
