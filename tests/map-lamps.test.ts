import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from '@bufbuild/protobuf'
import { MapLampSchema, ChunkLandStatusSchema, WildsMapStatusSchema } from '../src/lib/gen/glimway/v1/wilds_pb.js'
import { lampLedger, landLabel, turningLabel } from '../src/lib/wilds/map-lamps.ts'
import { validateMapStatus } from '../src/lib/api/near.ts'
import { loadWilds } from '../src/lib/wilds/data.ts'
import { gateTile } from '../src/lib/wilds/map-model.ts'

const land = (cx: number, cy: number) => create(ChunkLandStatusSchema, { chunk: { realm: loadWilds().realm, cx, cy }, tier: 'built', claimId: 'test', cost: 1, reserve: 2, nextTurning: 'held' })
test('ledger includes lot and future Common lamps, newest first with stable ties and neutral names', () => {
  const town = gateTile()!
  const lamps = [
    create(MapLampSchema, { id: 'lot', kind: 'lot-lantern', at: 1, x: town.tx, y: town.ty, land: land(-3,1) }),
    create(MapLampSchema, { id: 'b', kind: 'common-lamp', at: 3, name: 'Birch light', namer: 'Mara', naming: 'Beside the birch.', land: create(ChunkLandStatusSchema, { tier: 'common' }) }),
    create(MapLampSchema, { id: 'a', kind: 'way-lamp', at: 3, x: town.tx+3, y: town.ty+4, land: land(2,-4) }),
  ]
  const rows = lampLedger(lamps)
  assert.deepEqual(rows.map((r) => r.lamp.id), ['a','b','lot'])
  assert.equal(rows[0]!.name, 'Way-lamp')
  assert.equal(rows[0]!.distance, 5)
  assert.equal(rows[1]!.name, 'Birch light')
  assert.equal(rows[2]!.name, 'Lot lantern')
  assert.deepEqual(lamps.map((l) => l.id), ['lot','b','a'])
})
test('land words distinguish still/permanent and the two different empty-store outcomes', () => {
  const s = land(2,-4)
  assert.equal(landLabel(s),'Built · held')
  s.reserve=0;s.nextTurning='dimming'
  assert.equal(turningLabel(s),'Dims next turning unless tended')
  s.dimming=true;s.nextTurning='turns'
  assert.equal(turningLabel(s),'Turns next turning unless tended')
  s.nextTurning='released';assert.equal(turningLabel(s),'Turns at the next turning')
  s.tier='common';s.visited=false
  assert.equal(landLabel(s),'Common · needs a visit')
  s.visited=true
  assert.equal(landLabel(s),'Common · visited this wick')
  s.tier='still';assert.match(landLabel(s),/no oil/)
  s.tier='permanent';assert.match(landLabel(s),/permanent/)
})
test('map transport refuses unexplored extents and lamps while accepting a known lot stake alone', () => {
  const s=land(2,-4)
  const out=create(WildsMapStatusSchema,{wick:'wick',chunks:[s]})
  assert.throws(() => validateMapStatus(out,[]),/unexplored/)
  assert.equal(validateMapStatus(out,[{cx:2,cy:-4}]),out)
  out.chunks=[]
  out.lamps=[create(MapLampSchema,{id:'camp',kind:'way-lamp',land:s})]
  assert.throws(() => validateMapStatus(out,[]),/unexplored/)
  out.lamps=[create(MapLampSchema,{id:'lot',kind:'lot-lantern',land:land(-3,1)})]
  assert.equal(validateMapStatus(out,[]),out)
})
