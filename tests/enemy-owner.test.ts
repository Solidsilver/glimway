import './helpers/svelte-runes.ts'
import './helpers/scene-modules.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
const { EnemySystem } = await import('../src/game/entities/enemies.ts')

test('EnemySystem.update routes Stand through both owners in one list; server state never changes', () => {
  const system = Object.create(EnemySystem.prototype)
  const body = () => ({ enable: false, setVelocity: () => {} })
  const sprite = () => ({ active: true, body: body(), setDepth: () => {}, clearTint: () => {} })
  const enemy = () => ({ id: 'test', type: 'wisp', x: 100, y: 100, state: 'lunge', stateTimer: .2, lungeX: 190, lungeY: 0, dead: false, sprite: sprite() })
  const server = enemy(), local = enemy()
  let stopped = 0
  server.owner = { observe() {}, act() {}, struck() {}, stopped(e: object, seconds: number) { assert.equal(e, server); assert.equal(seconds, 2); stopped++ } }
  local.owner = { observe() {}, act() {}, struck() {}, stopped(e: object, seconds: number) { system.stagger(e, seconds) } }
  system._enemies = [server, local]
  system.deps = { hero: () => ({ sprite: { x: 100, y: 102 }, field: { stand: { stagger: 2 }, tick() {} }, damagePlayer() { assert.fail('Stand must suppress the observed contact') } }), fx: { floatText() {} } }
  system.setEnemyPose = () => {}
  system.update(.016)
  assert.equal(stopped, 1)
  assert.equal(server.state, 'lunge'); assert.equal(server.stateTimer, .2)
  assert.equal(server.lungeX, 190); assert.equal(server.sprite.body.enable, false)
  assert.equal(local.state, 'recover'); assert.equal(local.stateTimer, 2); assert.equal(local.lungeX, 0)
})

test('server Stand prediction changes a temporary pose window, not authoritative state', async () => {
  const { ServerEnemies } = await import('../src/game/entities/server-enemies.ts')
  const owner = new ServerEnemies({ scene: { time: { now: 1000 } } } as any)
  const enemy = { state: 'lunge', stateTimer: .2, lungeX: 190, hp: 28, type: 'wisp' } as any
  const entry = { enemy, draw: { row: { stateTick: 10 } }, stopTick: -1, stoppedUntil: 0 }
  ;(owner as any).drawn.set('1:0', entry)
  owner.owner.stopped(enemy, 2)
  assert.equal(entry.stoppedUntil, 3000)
  assert.deepEqual(enemy, { state: 'lunge', stateTimer: .2, lungeX: 190, hp: 28, type: 'wisp' })
  owner.owner.stopped(enemy, 2)
  assert.equal(entry.stoppedUntil, 3000)
})
test('local camp detach never removes server-owned enemies in the same list', () => {
  const system = Object.create(EnemySystem.prototype)
  let destroyed = 0
  system._enemies = [{ id: 'wilds:camp:0:0:0:0', fight: { room: 1, enemy: 0 }, sprite: { active: true, destroy() { assert.fail('server lifecycle belongs to its owner') } } }, { id: 'wilds:camp:0:0:0:1', sprite: { active: true, destroy() { destroyed++ } } }]
  system.removeWilds('wilds:camp:0:0:0:')
  assert.equal(destroyed, 1); assert.equal(system.enemies.length, 1)
  assert.equal(system.enemies[0].fight.room, 1)
})

test('removeLocalCamp deletes only matching local copies, keeping server and unrelated local enemies', () => {
  const system = Object.create(EnemySystem.prototype)
  let destroyed = 0
  const enemy = (id: string, fight?: object) => ({ id, fight, sprite: { active: true, destroy() { this.active = false; destroyed++ } } })
  const replacement = enemy('wilds:camp:0:0:0:0')
  const server = enemy('wilds:camp:0:0:0:1', { room: 1, enemy: 1 })
  const other = enemy('wilds:camp:0:0:01:0')
  system._enemies = [replacement, server, other]
  system.removeLocalCamp('camp:0:0:0')
  assert.equal(destroyed, 1); assert.deepEqual(system.enemies, [server, other])
  system.removeLocalCamp('camp:0:0:0'); assert.equal(destroyed, 1)
})
test('flag off: real local owner update and Hero.land keep contact, damage, knockback and interruption', async () => {
  const { Hero } = await import('../src/game/entities/hero.ts')
  const { FIGHT_OPTIONS } = await import('../src/lib/fight-options.ts')
  const { slashStrike, ENEMY_TUNING, KNOCK } = await import('../src/game/entities/fight-rules.ts')
  assert.equal(FIGHT_OPTIONS.enabled, false)
  const hurts: number[] = [], velocities: number[][] = [], numbers: string[] = []
  const scene: any = { events: { on() {}, once() {}, off() {} }, time: { now: 0, delayedCall() {} }, add: { graphics: () => ({ setDepth() { return this } }) } }
  const heroView = { sprite: { x: 100, y: 100 }, facing: { x: 1, y: 0 }, damagePlayer(n: number) { hurts.push(n) } }
  const system: any = new EnemySystem(scene, { world: { areaId: 'woodland', enemies: [] }, hero: () => heroView, fx: { floatText(_x: number, _y: number, n: string) { numbers.push(n) }, hitStop() {} } } as any, {} as any)
  const body = { setVelocity(x: number, y: number) { velocities.push([x, y]) } }
  const enemy: any = { id: 'local', type: 'wisp', x: 110, y: 100, hp: 28, maxHp: 28, dead: false, state: 'lunge', stateTimer: .2, knockTimer: .2, knockX: 10, knockY: 0, lungeX: 190, sprite: { body, active: true, y: 100, setDepth() {}, setTint() {}, clearTint() {} }, owner: system.local }
  system._enemies = [enemy]; system.setEnemyPose = () => {}
  system.observe(.1); assert.equal(enemy.stateTimer, .2, 'local observation does not simulate')
  system.update(.1)
  assert.equal(enemy.stateTimer, .1); assert.deepEqual(velocities, [[10, 0]])
  assert.deepEqual(hurts, [ENEMY_TUNING.wisp.hop])
  const hero: any = Object.create(Hero.prototype)
  hero.deps = { enemies: () => system }
  hero.land(slashStrike(heroView.sprite, heroView.facing, { meleeDamage: 5, critChance: 0 }, false), 100)
  assert.equal(enemy.hp, 23); assert.deepEqual(numbers, ['5'])
  assert.equal(enemy.state, 'recover'); assert.equal(enemy.stateTimer, ENEMY_TUNING.wisp.recover)
  assert.equal(enemy.knockX, KNOCK.small); assert.equal(enemy.knockTimer, KNOCK.time)
  assert.equal(system.server, null)
})
