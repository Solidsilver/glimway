/** F-D's rendering slice uses contract-10 packets from a fake fight server.
 * The real two-player sim/claims playtest belongs to F-G and runs in CI. */
import { expect, test } from './fixtures'
import { freshPlayer, go } from './home-helpers'
import { waitForLive, player } from './helpers'
import type { WebSocketRoute } from '@playwright/test'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { PresenceFrameSchema, PresenceMessageSchema } from '../src/lib/gen/glimway/v2/presence_pb.js'

const camp = 'camp:0:0:0'
type Enemy = { id: string; x: number; y: number; state: string; hp: number; fight: { room: number; enemy: number } | null; bodyEnabled: boolean }
const serverEnemy = async (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __fsEnemies(): Enemy[] }).__fsEnemies().find(e => e.fight?.room === 41) ?? null)
const serverFrame = (event: NonNullable<Parameters<typeof create<typeof PresenceMessageSchema>>[1]>['event']) => Buffer.from(toBinary(PresenceFrameSchema, create(PresenceFrameSchema, { events: [create(PresenceMessageSchema, { event })] })))

test('server wisp observes menus and close/resync; press predicts but death waits for server', async ({ page }) => {
  await freshPlayer(page)
  let socket: WebSocketRoute | undefined
  const swings: ReturnType<typeof fromBinary<typeof PresenceMessageSchema>>[] = []
  await page.routeWebSocket('**/ws', ws => {
    socket = ws
    const upstream = ws.connectToServer()
    // All real camps now use server fights. Keep this controlled rendering
    // test's baseline isolated from their joins/deltas/events/results.
    upstream.onMessage(data => {
      const message = fromBinary(PresenceMessageSchema, Buffer.from(data))
      if (!message.event.case?.startsWith('fight')) ws.send(data)
    })
    ws.onMessage(data => {
      const message = fromBinary(PresenceMessageSchema, Buffer.from(data))
      if (message.event.case === 'fightSwing') {
        swings.push(message)
        ws.send(serverFrame({ case: 'fightSwingResult', value: { swingCounter: message.event.value.swingCounter, hits: [{ room: 41, enemy: 0, damage: 10 }] } }))
      } else upstream.send(data)
    })
  })
  await page.goto('/?perf=1')
  await page.getByRole('button', { name: /^Continue/ }).click()
  await waitForLive(page)
  await go(page, 'wilds', 5, 5)
  await expect.poll(() => !!socket).toBe(true)
  const hero = await player(page)
  const tick = Math.floor(Date.now() / 100) >>> 0
  const send = (event: NonNullable<Parameters<typeof create<typeof PresenceMessageSchema>>[1]>['event']) => socket!.send(serverFrame(event))
  send({ case: 'fightJoin', value: { room: 41, tick, critSeed: 123, roomKey: { world: 'fake', realm: 'wilds', layer: 0, cx: 0, cy: 0, epoch: 'still' }, enemies: [{ enemy: 0, id: `${camp}:0`, campId: camp, kind: 1, x: Math.round(hero.x + 14), y: Math.round(hero.y), state: 1, stateTick: tick, hp: 28, maxHp: 28, facing: 0 }] } })
  await expect.poll(() => serverEnemy(page)).not.toBeNull()
  expect((await serverEnemy(page))!.bodyEnabled).toBe(false)
  await page.getByRole('button', { name: 'Menu (Esc)' }).click()
  send({ case: 'fightDelta', value: { room: 41, tick: (tick + 1) >>> 0, changed: [{ enemy: 0, x: Math.round(hero.x + 22), state: 2, stateTick: (tick + 1) >>> 0 }] } })
  send({ case: 'fightEvent', value: { room: 41, enemy: 0, tick: (tick + 1) >>> 0, kind: 1 } })
  await expect.poll(async () => (await serverEnemy(page))?.state).toBe('telegraph')
  await expect.poll(async () => (await serverEnemy(page))?.x).toBe(Math.round(hero.x + 22))
  await page.keyboard.press('Escape')
  await waitForLive(page)
  // Use the input path to face right, then the dev hook invokes the real Hero attack.
  await page.keyboard.down('ArrowRight'); await page.waitForTimeout(40); await page.keyboard.up('ArrowRight')
  send({ case: 'fightEvent', value: { room: 41, tick: (tick + 1) >>> 0, kind: 5 } })
  // No blank frame while the old view waits for its paced same-key join.
  const gaps = await page.evaluate(() => new Promise<number>(resolve => {
    let gaps = 0
    const until = performance.now() + 200
    const frame = () => {
      const enemies = (window as unknown as { __fsEnemies(): Enemy[] }).__fsEnemies()
      if (!enemies.some(e => e.fight?.room === 41)) gaps++
      if (performance.now() >= until) resolve(gaps)
      else requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }))
  expect(gaps).toBe(0)
  await page.evaluate(() => (window as unknown as { __fsDevAttack(): void }).__fsDevAttack())
  await expect.poll(() => swings.length).toBe(1)
  const swing = swings[0]!.event
  expect(swing.case).toBe('fightSwing')
  if (swing.case === 'fightSwing') expect(swing.value.predicted.map(t => [t.room, t.enemy])).toEqual([[41, 0]])
  expect((await serverEnemy(page))!.hp).toBe(28)
  const refreshTick = Math.floor(Date.now() / 100) >>> 0
  send({ case: 'fightJoin', value: { room: 41, tick: refreshTick, critSeed: 123, roomKey: { world: 'fake', realm: 'wilds', layer: 0, cx: 0, cy: 0, epoch: 'still' }, enemies: [{ enemy: 0, id: `${camp}:0`, campId: camp, kind: 1, x: Math.round(hero.x + 22), y: Math.round(hero.y), state: 2, stateTick: (tick + 1) >>> 0, hp: 28, maxHp: 28, facing: 0 }] } })
  await expect.poll(async () => (await serverEnemy(page))?.state).toBe('telegraph')
  const deathTick = (refreshTick + 1) >>> 0
  send({ case: 'fightDelta', value: { room: 41, tick: deathTick, changed: [{ enemy: 0, hp: 0, state: 6, stateTick: deathTick }] } })
  send({ case: 'fightEvent', value: { room: 41, enemy: 0, tick: deathTick, kind: 3 } })
  await expect.poll(() => serverEnemy(page)).toBeNull()
  const metrics = await page.evaluate(() => (window as unknown as { __fsPerf(): { fights: { confirmations: number } } }).__fsPerf().fights)
  expect(metrics.confirmations).toBe(1)
})
