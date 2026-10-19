/** F-D's rendering slice uses contract-10 packets from a fake fight server.
 * The real two-player sim/claims playtest belongs to F-G and runs in CI. */
import { expect, test } from './fixtures'
import { freshPlayer, go } from './home-helpers'
import { noteHelperRetry, waitForLive, player } from './helpers'
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
  // The current socket's room: the area its client joined, and whether the
  // server's roster for that area has come back (the client takes fights
  // only once it has joined the room it stands in).
  let joined: string | null = null
  let rostered = false
  const swings: ReturnType<typeof fromBinary<typeof PresenceMessageSchema>>[] = []
  await page.routeWebSocket('**/ws', ws => {
    socket = ws
    joined = null
    rostered = false
    const upstream = ws.connectToServer()
    // All real camps now use server fights. Keep this controlled rendering
    // test's baseline isolated from their joins/deltas/events/results.
    // The server sends frames of events: drop the fight events, pass the rest.
    upstream.onMessage(data => {
      const frame = fromBinary(PresenceFrameSchema, Buffer.from(data))
      if (ws === socket && frame.events.some(e => e.event.case === 'room' && e.event.value.area === joined)) rostered = true
      const events = frame.events.filter(e => !e.event.case?.startsWith('fight'))
      if (events.length === frame.events.length) ws.send(data)
      else if (events.length) ws.send(Buffer.from(toBinary(PresenceFrameSchema, create(PresenceFrameSchema, { events }))))
    })
    ws.onMessage(data => {
      const message = fromBinary(PresenceMessageSchema, Buffer.from(data))
      if (ws === socket && message.event.case === 'join') {
        joined = message.event.value.area
        rostered = false
      }
      if (message.event.case === 'fightSwing') {
        swings.push(message)
        ws.send(serverFrame({ case: 'fightSwingResult', value: { swingCounter: message.event.value.swingCounter, hits: [{ room: 41, enemy: 0, damage: 10 }] } }))
      } else upstream.send(data)
    })
  })
  await page.goto('/?perf=1')
  await page.getByRole('button', { name: /^Continue/ }).click()
  await waitForLive(page)
  await go(page, 'outdoors', 5, 5)
  await expect.poll(() => !!socket).toBe(true)
  const hero = await player(page)
  const tick = Math.floor(Date.now() / 100) >>> 0
  const send = (event: NonNullable<Parameters<typeof create<typeof PresenceMessageSchema>>[1]>['event']) => socket!.send(serverFrame(event))
  const join = () => send({ case: 'fightJoin', value: { room: 41, tick, critSeed: 123, roomKey: { world: 'fake', realm: 'outdoors', layer: 0, cx: 0, cy: 0, epoch: 'still' }, enemies: [{ enemy: 0, id: `${camp}:0`, campId: camp, kind: 1, x: Math.round(hero.x + 14), y: Math.round(hero.y), state: 1, stateTick: tick, hp: 28, maxHp: 28, facing: 0 }] } })
  // A join sent before the link settled (or on a socket since replaced) is
  // lost (CI, 2026-10-18). Ready: the current socket is live, has joined the
  // hero's area and has its roster back. Then one join.
  const presence = () => page.evaluate(() => (window as unknown as { __fsPresence: () => { status: string; area: string | null } }).__fsPresence())
  await expect.poll(async () => {
    const p = await presence()
    return p.status === 'live' && rostered && joined === p.area
  }, { timeout: 15_000, message: 'the presence link has joined the hero\'s area' }).toBe(true)
  join()
  // A join is the room's whole picture, so sending it again is safe; each
  // extra one is recorded as a helper retry (the release bar reads them).
  for (let joins = 1; ; joins++) {
    const shown = await expect.poll(() => serverEnemy(page), { timeout: 5_000 }).not.toBeNull().then(() => true, () => false)
    if (shown) break
    if (joins >= 3) throw new Error(`no server enemy after ${joins} fight joins: ${JSON.stringify({ presence: await presence(), joined, rostered })}`)
    noteHelperRetry('fights-server join', `no enemy 5 s after join ${joins}; sending join ${joins + 1}`)
    join()
  }
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
  send({ case: 'fightJoin', value: { room: 41, tick: refreshTick, critSeed: 123, roomKey: { world: 'fake', realm: 'outdoors', layer: 0, cx: 0, cy: 0, epoch: 'still' }, enemies: [{ enemy: 0, id: `${camp}:0`, campId: camp, kind: 1, x: Math.round(hero.x + 22), y: Math.round(hero.y), state: 2, stateTick: (tick + 1) >>> 0, hp: 28, maxHp: 28, facing: 0 }] } })
  await expect.poll(async () => (await serverEnemy(page))?.state).toBe('telegraph')
  const deathTick = (refreshTick + 1) >>> 0
  send({ case: 'fightDelta', value: { room: 41, tick: deathTick, changed: [{ enemy: 0, hp: 0, state: 6, stateTick: deathTick }] } })
  send({ case: 'fightEvent', value: { room: 41, enemy: 0, tick: deathTick, kind: 3 } })
  await expect.poll(() => serverEnemy(page)).toBeNull()
  const metrics = await page.evaluate(() => (window as unknown as { __fsPerf(): { fights: { confirmations: number } } }).__fsPerf().fights)
  expect(metrics.confirmations).toBe(1)
})
