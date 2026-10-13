import { Bus, type EventMap } from '../src/game/events.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { PresenceMessageSchema, PresenceFrameSchema } from '../src/lib/gen/glimway/v2/presence_pb.js'
import { PresenceFeed } from '../src/game/presence-feed.ts'
import { PRESENCE_PROTOCOL } from '../src/lib/presence-codec.ts'
import type { SocketLike } from '../src/lib/presence-client.ts'

function rig(latency = { lag: 0, jitter: 0 }) {
  let now = 1000, seq = 0
  const tasks = new Map<number, { at: number; fn: () => void }>()
  const sent: ReturnType<typeof fromBinary<typeof PresenceMessageSchema>>[] = []
  const socket: SocketLike = { readyState: 1, protocol: PRESENCE_PROTOCOL, onopen: null, onmessage: null, onclose: null, onerror: null, send: data => sent.push(fromBinary(PresenceMessageSchema, data as Uint8Array)), close() {} }
  const feed = new PresenceFeed({ link: { active: true, status: 'online', lease: 'lease', beat: async () => {} }, bus: new Bus<EventMap>(), url: 'ws://fake', makeSocket: () => socket, latency, now: () => now, every: () => 0, cancel() {}, timers: { now: () => now, set: (fn, ms) => { tasks.set(++seq, { at: now + ms, fn }); return seq }, clear: t => { tasks.delete(t as number) } } })
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const task = [...tasks].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!task) break
      tasks.delete(task[0]); now = task[1].at; task[1].fn()
    }
    now = end
  }
  // The server's frames (v3) carry one or more events; one here.
  const push = (event: NonNullable<Parameters<typeof create<typeof PresenceMessageSchema>>[1]>['event']) => socket.onmessage?.({ data: toBinary(PresenceFrameSchema, create(PresenceFrameSchema, { events: [create(PresenceMessageSchema, { event })] })) })
  feed.setArea('wilds:0:0'); socket.onopen?.({})
  push({ case: 'ready', value: { accountId: 'me' } }); advance(latency.lag + latency.jitter)
  return { feed, socket, sent, advance, push }
}
const join = { room: 1, tick: 100, critSeed: 123, roomKey: { world: 'world', realm: 'wilds', layer: 0, cx: 0, cy: 0, epoch: 'still' }, enemies: [{ enemy: 0, id: 'camp:0:0:0:0', campId: 'camp:0:0:0', kind: 1, x: 100, y: 100, hp: 28, maxHp: 28, state: 1, stateTick: 100, facing: 0 }] }

test('fake server feed decodes real join/delta/event/result wire and sends one protobuf swing', () => {
  const r = rig()
  r.push({ case: 'fightJoin', value: join })
  r.advance(100); r.feed.fights.observe()
  r.push({ case: 'fightDelta', value: { room: 1, tick: 101, changed: [{ enemy: 0, x: 120 }] } })
  r.advance(50); r.feed.fights.observe()
  assert.equal(r.feed.fights.draw()[0]!.x, 110)
  const counter = r.feed.nextSwing(), seen = r.feed.fights.seen()!
  assert.equal(r.feed.swing({ kind: 1, x: 100, y: 100, facing: { x: 1, y: 0 }, tool: true, swingCounter: counter, seenTick: seen.tick, seenOffsetMs: seen.offsetMs, predicted: [{ room: 1, enemy: 0 }] }), true)
  const message = r.sent.at(-1)!.event
  assert.equal(message.case, 'fightSwing')
  if (message.case !== 'fightSwing') return
  assert.equal(message.value.seenOffsetMs, 50); assert.equal(message.value.predicted[0]!.room, 1)
  r.advance(200)
  r.push({ case: 'fightSwingResult', value: { swingCounter: counter, hits: [{ room: 1, enemy: 0, damage: 5 }] } })
  assert.equal(r.feed.fights.measures().hitConfirmationP95, 200)
  r.push({ case: 'fightEvent', value: { room: 1, enemy: 0, tick: 102, kind: 3 } })
  r.feed.fights.observe(); assert.equal(r.feed.fights.campWon('camp:0:0:0', 'still'), true)
  r.feed.stop()
})
test('lag+jitter is applied both ways in WebSocket order, and stop cancels queued frames', () => {
  const r = rig({ lag: 150, jitter: 50 })
  r.advance(200)
  const before = r.sent.length
  r.push({ case: 'fightJoin', value: join })
  r.push({ case: 'fightDelta', value: { room: 1, tick: 101, changed: [{ enemy: 0, x: 120 }] } })
  assert.equal(r.feed.fights.rooms.size, 0)
  r.advance(99); assert.equal(r.feed.fights.rooms.size, 0)
  r.advance(101); r.feed.fights.observe()
  assert.equal(r.feed.fights.rooms.size, 1)
  assert.equal(r.feed.swing({ kind: 2, x: 100, y: 100, facing: { x: 1, y: 0 }, tool: false, swingCounter: 0, seenTick: 100, seenOffsetMs: 0, predicted: [] }), true)
  assert.equal(r.sent.length, before)
  r.advance(200); assert.equal(r.sent.at(-1)!.event.case, 'fightSwing')
  const count = r.sent.length
  r.feed.swing({ kind: 2, x: 100, y: 100, facing: { x: 1, y: 0 }, tool: false, swingCounter: 1, seenTick: 100, seenOffsetMs: 0, predicted: [] })
  r.push({ case: 'fightJoin', value: join }); r.feed.stop(); r.advance(500)
  assert.equal(r.sent.length, count); assert.equal(r.feed.fights.rooms.size, 0)
})
test('room edge pruning and reconnect discard old rooms and reset the socket counter', () => {
  const r = rig(); r.push({ case: 'fightJoin', value: join })
  r.feed.setArea('wilds:1:0'); assert.equal(r.feed.fights.rooms.size, 1)
  r.feed.setArea('wilds:2:0'); assert.equal(r.feed.fights.rooms.size, 0)
  assert.equal(r.feed.nextSwing(), 0); assert.equal(r.feed.nextSwing(), 1)
  r.socket.onclose?.({ code: 1006 }); assert.equal(r.feed.fights.seed, 0)
  r.advance(1500); r.socket.onopen?.({}); r.push({ case: 'ready', value: { accountId: 'me' } })
  assert.equal(r.feed.nextSwing(), 0); r.feed.stop()
})

test('unsent closing socket and synchronous send failure create no pending result or timeout', () => {
  const r = rig(); r.push({ case: 'fightJoin', value: join }); r.advance(100); r.feed.fights.observe()
  const swing = { kind: 1 as const, x: 100, y: 100, facing: { x: 0, y: 0 }, tool: false, swingCounter: 0, seenTick: 100, seenOffsetMs: 0, predicted: [] }
  ;(r.socket as { readyState: number }).readyState = 2
  assert.equal(r.feed.swing(swing), false)
  assert.equal(r.feed.fights.measures().pending, 0)
  ;(r.socket as { readyState: number }).readyState = 1
  r.socket.send = () => { throw Error('transport closed') }
  assert.equal(r.feed.swing(swing), false)
  r.advance(4000); assert.equal(r.feed.fights.measures().timeouts, 0)
  r.feed.stop()
})
test('chunk-edge ROOM_CLOSED retains targets for a swing and the fresh same-key join resyncs them', () => {
  const r = rig(); r.push({ case: 'fightJoin', value: join }); r.advance(100); r.feed.fights.observe()
  const original = r.feed.fights.draw()[0]!.incarnation
  r.feed.setArea('wilds:1:0')
  r.push({ case: 'fightEvent', value: { room: 1, tick: 100, kind: 5 } }); r.advance(100); r.feed.fights.observe()
  assert.equal(r.feed.fights.draw().length, 1)
  assert.equal(r.feed.swing({ kind: 1, x: 100, y: 100, facing: { x: 0, y: 0 }, tool: false, swingCounter: 0, seenTick: 101, seenOffsetMs: 0, predicted: [{ room: 1, enemy: 0 }] }), true)
  const message = r.sent.at(-1)!.event
  if (message.case !== 'fightSwing') assert.fail('missing swing during grace')
  assert.deepEqual([message.value.facing!.x, message.value.facing!.y], [0, 1])
  r.push({ case: 'fightJoin', value: { ...join, tick: 102 } }); r.feed.fights.observe()
  assert.equal(r.feed.fights.draw()[0]!.incarnation, original)
  assert.equal(r.feed.fights.measures().pending, 1)
  r.feed.stop()
})

test('a queued lagged swing that cannot be delivered is withdrawn rather than timing out', () => {
  const r = rig({ lag: 150, jitter: 0 }); r.advance(200)
  r.push({ case: 'fightJoin', value: join }); r.advance(150); r.feed.fights.observe()
  assert.equal(r.feed.swing({ kind: 1, x: 100, y: 100, facing: { x: 1, y: 0 }, tool: false, swingCounter: 0, seenTick: 100, seenOffsetMs: 0, predicted: [{ room: 1, enemy: 0 }] }), true)
  assert.equal(r.feed.fights.measures().pending, 1)
  ;(r.socket as { readyState: number }).readyState = 2
  r.advance(150)
  assert.equal(r.feed.fights.measures().pending, 0)
  assert.equal(r.feed.fights.measures().predictedRows, 0)
  r.advance(4000); assert.equal(r.feed.fights.measures().timeouts, 0)
  r.feed.stop()
})

test('through a real feed: dead rows only ask for a read; a disconnect keeps the store’s word; a reconnect’s standing rows hide it', async () => {
  const { ServerCampOutcome } = await import('../src/game/wilds/camp-fights.ts')
  const r = rig(); r.push({ case: 'fightJoin', value: join }); r.advance(100); r.feed.fights.observe()
  let asks = 0
  const outcome = new ServerCampOutcome(camp => r.feed.live ? r.feed.fights.campWon(camp.id, camp.epoch) : undefined, async () => { asks++ }, () => 0)
  const camp = { id: 'camp:0:0:0', epoch: 'still', cycle: 1, claimable: false }
  assert.equal(outcome.won(camp), false)
  r.push({ case: 'fightEvent', value: { room: 1, tick: 100, enemy: 0, kind: 3 } }); r.feed.fights.observe()
  assert.equal(outcome.won(camp), false, 'the room’s death is not the server’s word')
  assert.equal(asks, 1, 'it asks for a near read')
  assert.equal(outcome.won({ ...camp, claimable: true }), true, 'the read names it claimable')
  r.socket.onclose?.({ code: 1006 })
  assert.equal(r.feed.fights.campWon(camp.id, camp.epoch), undefined)
  assert.equal(outcome.won({ ...camp, claimable: true }), true, 'unknown keeps the confirmed word')
  r.advance(1500); r.socket.onopen?.({}); r.push({ case: 'ready', value: { accountId: 'me' } })
  r.push({ case: 'fightJoin', value: join }); assert.equal(outcome.won({ ...camp, claimable: true }), false, 'a standing row hides it')
  r.feed.stop()
})

test('a cast with a fight part goes on the shared counter as one PresenceAbility, waits for its result, and withdraws if unsent', () => {
  const r = rig()
  r.push({ case: 'fightJoin', value: join }); r.advance(100); r.feed.fights.observe()
  assert.equal(r.feed.nextSwing(), 0)
  const seen = r.feed.fights.seen()!
  assert.equal(r.feed.ability('cleave', 100, 100, { seenTick: seen.tick, seenOffsetMs: seen.offsetMs, facing: { x: 2, y: 0 }, swingCounter: r.feed.nextSwing(), predicted: [{ room: 1, enemy: 0 }] }), true)
  const sent = r.sent.at(-1)!.event
  assert.equal(sent.case, 'ability')
  const ability = sent.value as { ability: string; fight?: { swingCounter: number; facing?: { x: number; y: number }; predicted: { room: number; enemy: number }[] } }
  assert.equal(ability.ability, 'cleave')
  assert.equal(ability.fight!.swingCounter, 1)
  assert.deepEqual([ability.fight!.facing!.x, ability.fight!.facing!.y], [1, 0], 'facing normalized on the wire')
  assert.deepEqual(ability.fight!.predicted.map(t => [t.room, t.enemy]), [[1, 0]])
  assert.equal(r.feed.fights.measures().pending, 1)
  r.push({ case: 'fightSwingResult', value: { swingCounter: 1, hits: [{ room: 1, enemy: 0, damage: 9 }] } })
  assert.equal(r.feed.fights.measures().pending, 0)
  assert.equal(r.feed.fights.measures().confirmations, 1)
  // A closing socket: nothing sent, nothing pending.
  ;(r.socket as { readyState: number }).readyState = 2
  assert.equal(r.feed.ability('stand', 100, 100, { seenTick: seen.tick, seenOffsetMs: 0, facing: { x: 0, y: 1 }, swingCounter: r.feed.nextSwing(), predicted: [] }), false)
  assert.equal(r.feed.fights.measures().pending, 0)
  r.feed.stop()
})
