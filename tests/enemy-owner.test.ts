import './helpers/svelte-runes.ts'
import './helpers/scene-modules.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
const { EnemySystem } = await import('../src/game/entities/enemies.ts')

test('EnemySystem.update routes Stand through both owners in one list; server state never changes', () => {
  const system = Object.create(EnemySystem.prototype)
  const body = () => ({ enable: false, setVelocity: () => {} })
  const sprite = () => ({ active: true, body: body(), setDepth: () => {}, clearTint: () => {} })
  const enemy = () => ({ id: 'test', type: 'wisp', x: 100, y: 100, state: 'lunge', stateTimer: .2, lungeX: 190, lungeY: 0, dead: false, sprite: sprite(), owner: { observe() {}, act() {}, struck() {}, stopped(_e: object, _seconds: number) {} } })
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
  ;(owner as any).drawn.set(1, entry)
  owner.owner.stopped(enemy, 2)
  assert.equal(entry.stoppedUntil, 3000)
  assert.deepEqual({ ...enemy }, { state: 'lunge', stateTimer: .2, lungeX: 190, hp: 28, type: 'wisp' })
  owner.owner.stopped(enemy, 2)
  assert.equal(entry.stoppedUntil, 3000)
})
test('curated fights: the real local owner update and Hero.land keep contact, damage, knockback and interruption', async () => {
  const { Hero } = await import('../src/game/entities/hero.ts')
  const { slashStrike, ENEMY_TUNING, KNOCK } = await import('../src/game/entities/fight-rules.ts')
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

test('the Wilds always draw their camps from the server: no flag, and no local camp path left', () => {
  const scene: any = { events: { on() {}, once() {}, off() {} }, time: { now: 0, delayedCall() {} }, add: { graphics: () => ({ setDepth() { return this } }) } }
  const wilds: any = new EnemySystem(scene, { world: { areaId: 'wilds', enemies: [] }, hero: () => ({}), fx: {} } as any, {} as any)
  assert.notEqual(wilds.server, null)
  assert.equal(typeof wilds.removeWilds, 'undefined'); assert.equal(typeof wilds.removeLocalCamp, 'undefined')
  const woodland: any = new EnemySystem(scene, { world: { areaId: 'woodland', enemies: [] }, hero: () => ({}), fx: {} } as any, {} as any)
  assert.equal(woodland.server, null, 'curated areas keep only the local owner')
})

test('a late-landing signature shows its press-time server rows only, never on an enemy the room has since killed', async () => {
  const { Hero } = await import('../src/game/entities/hero.ts')
  const shown: [string, number, boolean][] = []
  const alive = { id: 'a', dead: false, x: 1, y: 1 }, killed = { id: 'k', dead: true, x: 1, y: 1 }, gone = { id: 'g', dead: false, x: 1, y: 1 }
  const enemies = { enemies: [alive, killed], damageEnemy: (e: { id: string }, amount: number, _from: number, crit: boolean) => shown.push([e.id, amount, crit]) }
  const hero: any = Object.create(Hero.prototype)
  hero.deps = { enemies: () => enemies, fx: { sparkBurst() {} } }
  hero.showPredicted([{ enemy: alive, amount: 12, crit: true }, { enemy: killed, amount: 12, crit: false }, { enemy: gone, amount: 12, crit: false }], 0)
  assert.deepEqual(shown, [['a', 12, true]])
})
