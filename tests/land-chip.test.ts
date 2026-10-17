import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from '@bufbuild/protobuf'
import { ChunkLandStatusSchema } from '../src/lib/gen/glimway/v1/wilds_pb.js'
import { LampNoticeSchema } from '../src/lib/gen/glimway/v1/camps_pb.js'
import { lampNoticeText, landChip, landWhose, sameChip } from '../src/lib/wilds/land-chip.ts'
import { LAMP_NOTICE, LAND_CHIP } from '../src/content/land-chip.ts'
import { ASK_AGAIN_MS, LandHere } from '../src/game/wilds/land-here.ts'
import { bus, EV } from '../src/game/events.ts'
import type { WildsView } from '../src/game/wilds/store.ts'

type Land = Parameters<typeof create<typeof ChunkLandStatusSchema>>[1]
const land = (fields: Land) => create(ChunkLandStatusSchema, fields)
const camp = (fields: Land = {}) => land({ tier: 'built', claimId: 'way-lamp:abc', cost: 1, reserve: 2, nextTurning: 'held', ...fields })

test('held land says whose: your camp, a named friend’s, a friend’s, your lot, a lot', () => {
  assert.equal(landChip(camp({ yours: true, keeper: 'Ana' }))!.text, 'Held · your camp')
  assert.equal(landChip(camp({ keeper: 'Ana' }))!.text, 'Held · Ana’s camp')
  assert.equal(landChip(camp())!.text, 'Held · a friend’s camp')
  assert.equal(landChip(camp({ claimId: 'lot-lantern:3', yours: true }))!.text, 'Held · your lot')
  assert.equal(landChip(camp({ claimId: 'lot-lantern:3' }))!.text, 'Held · a lot')
  assert.equal(landWhose({ claimId: 'charter:1', keeper: '', yours: false }), LAND_CHIP.whose.land)
  const held = landChip(camp())!
  assert.equal(held.state, 'held')
  assert.equal(held.short, 'Held')
  assert.equal(held.why, LAND_CHIP.why.held)
})

test('a hold on its last oil is still held, and says it dims at the turning', () => {
  const c = landChip(camp({ reserve: 0, nextTurning: 'dimming', yours: true }))!
  assert.equal(c.state, 'held')
  assert.equal(c.why, LAND_CHIP.why.lastOil)
})

test('a dimming hold is its own state, with whose, and no countdown', () => {
  const c = landChip(camp({ reserve: 0, dimming: true, nextTurning: 'turns', yours: true }))!
  assert.equal(c.state, 'dimming')
  assert.equal(c.text, 'Dimming · your camp')
  assert.equal(c.short, 'Dimming')
  assert.match(c.why, /next turning/)
  assert.doesNotMatch(c.why, /\d/)
  // Filled while dimming: the store has oil again, so it reads as held.
  assert.equal(landChip(camp({ reserve: 1, dimming: true, nextTurning: 'held' }))!.state, 'held')
})

test('a released claim, wild land and common land', () => {
  assert.deepEqual(landChip(camp({ nextTurning: 'released' })), { state: 'turning', text: 'Turning', short: 'Turning', why: LAND_CHIP.why.released })
  const wild = landChip(land({ tier: 'wild', nextTurning: 'detail-turns' }))!
  assert.equal(wild.state, 'turning')
  assert.equal(wild.why, LAND_CHIP.why.turning)
  for (const visited of [false, true]) {
    const c = landChip(land({ tier: 'common', visited, nextTurning: visited ? 'carries' : 'paths-turn' }))!
    assert.equal(c.state, 'common')
    assert.equal(c.text, 'Common')
  }
})

test('town, the still Tangle and unknown land get no chip', () => {
  assert.equal(landChip(land({ tier: 'permanent', nextTurning: 'permanent' })), null)
  assert.equal(landChip(land({ tier: 'still', nextTurning: 'permanent' })), null)
  assert.equal(landChip(null), null)
  assert.equal(landChip(undefined), null)
})

test('sameChip compares the words', () => {
  assert.ok(sameChip(null, null))
  assert.ok(sameChip(landChip(camp()), landChip(camp())))
  assert.ok(!sameChip(landChip(camp()), landChip(camp({ yours: true }))))
  assert.ok(!sameChip(landChip(camp()), null))
})

test('dimming notices are short, plain and countdown-free', () => {
  assert.equal(lampNoticeText(create(LampNoticeSchema, { kind: 'way-lamp' })), 'Your way-lamp is guttering. A flask of oil keeps the camp lit.')
  assert.equal(lampNoticeText(create(LampNoticeSchema, { kind: 'way-lamp', name: 'First lamp past the Whitequiet' })), 'Your way-lamp, First lamp past the Whitequiet, is guttering. A flask of oil keeps the camp lit.')
  assert.equal(lampNoticeText(create(LampNoticeSchema, { kind: 'lot-lantern', id: '3' })), LAMP_NOTICE.lotLantern)
  assert.equal(lampNoticeText(create(LampNoticeSchema, { kind: 'charter' })), null)
  for (const text of [LAMP_NOTICE.wayLamp(''), LAMP_NOTICE.lotLantern]) {
    assert.doesNotMatch(text, /\d|hurry|soon|left|hours?|days?/i)
    assert.match(text, /guttering/)
  }
})

test('the tracker tells the HUD only of a change, and asks once per chunk and wick', () => {
  const told: (string | null)[] = []
  const asked: string[] = []
  const listen = (p: { chip: { text: string } | null }) => told.push(p.chip?.text ?? null)
  bus.on(EV.landHere, listen)
  try {
    const view = { version: 1, wick: { id: 'w1' }, land: new Map([['2,-4', camp({ yours: true })], ['3,-4', land({ tier: 'wild', nextTurning: 'detail-turns' })]]) } as unknown as WildsView
    let clock = 0
    const here = new LandHere((cx, cy) => asked.push(`${cx},${cy}`), () => clock)
    here.update(2, -4, view)
    here.update(2, -4, view) // the same frame again: nothing
    assert.deepEqual(told, ['Held · your camp'])
    view.version = 2 // a store change that leaves this chunk's words alone
    here.update(2, -4, view)
    assert.deepEqual(told, ['Held · your camp'])
    view.land.set('2,-4', camp({ yours: true, reserve: 0, dimming: true, nextTurning: 'turns' }))
    view.version = 3
    here.update(2, -4, view)
    here.update(3, -4, view)
    clock += ASK_AGAIN_MS - 1
    here.update(2, -4, view) // back soon: the answer is fresh
    assert.deepEqual(asked, ['2,-4', '3,-4'])
    here.update(3, -4, view)
    clock += 1
    here.update(2, -4, view) // back later: asked again
    assert.deepEqual(asked, ['2,-4', '3,-4', '2,-4'])
    // The turning: a store change in a new wick asks, without a step.
    ;(view as { wick: { id: string } }).wick = { id: 'w2' }
    view.version = 4
    here.update(2, -4, view)
    assert.deepEqual(asked, ['2,-4', '3,-4', '2,-4', '2,-4'])
    told.length = 0
    here.clear()
    here.clear()
    assert.deepEqual(told, [null])
  } finally {
    bus.off(EV.landHere, listen)
  }
})
