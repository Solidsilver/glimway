import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from '@bufbuild/protobuf'
import { MapLampSchema, ChunkLandStatusSchema, WildsMapStatusSchema } from '../src/lib/gen/glimway/v1/wilds_pb.js'
import { lampLedger, landDimming, landLabel, mapLampMark, turningLabel } from '../src/lib/wilds/map-lamps.ts'
import { validateMapStatus } from '../src/lib/api/near.ts'
import { loadWilds } from '../src/lib/wilds/data.ts'
import { gateTile } from '../src/lib/wilds/map-model.ts'
import { readFileSync } from 'node:fs'
import { createOperationsApi } from '../src/lib/api/operations.ts'
import { MAP_LAMPS } from '../src/content/map-lamps.ts'

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
  assert.equal(turningLabel(s),'Last wick · gutters next turning unless tended')
  // The last wick is dimming already (owner, 2026-10-17): label, mark and hatch agree.
  assert.equal(landLabel(s),'Built · dimming')
  assert.ok(landDimming(s))
  assert.ok(mapLampMark({ land: s }).dimming)
  s.dimming=true;s.nextTurning='turns'
  assert.equal(turningLabel(s),'Turns next turning unless tended')
  assert.ok(landDimming(s))
  s.reserve=1;s.dimming=false;s.nextTurning='held'
  assert.ok(!landDimming(s))
  assert.ok(!mapLampMark({ land: s }).dimming)
  s.reserve=0;s.dimming=true;s.nextTurning='turns'
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
test('a lamp-only Common chunk from the real map endpoint decodes, visited and not (review B4)', async () => {
  const raw = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/map-lamps.json', import.meta.url), 'utf8')) as Record<'visited' | 'unvisited', unknown>
  let current: unknown = null
  const api = createOperationsApi(async (method, path) => {
    assert.equal(`${method} ${path}`, 'POST /api/wilds/map')
    return current
  })
  for (const [state, next] of [['visited', 'lamps-carry'], ['unvisited', 'lamps-turn']] as const) {
    current = raw[state]
    const out = await api.mapStatus([{ cx: 2, cy: -4 }])
    assert.equal(out.chunks[0]!.nextTurning, next)
    assert.equal(out.chunks[0]!.tier, 'common')
    assert.equal(out.lamps[0]!.kind, 'common-lamp')
    assert.equal(turningLabel(out.chunks[0]!), next === 'lamps-carry' ? MAP_LAMPS.lampsCarry : MAP_LAMPS.lampsTurn)
  }
})

test('the Lamps layer marks a lamp with the placeholder way-lamp icon, dimmed when its land dims', async () => {
  const { mapLampMark, MAP_LAMP_ICON } = await import('../src/lib/wilds/map-lamps.ts')
  const manifest = JSON.parse(readFileSync('public/assets/fingersnap/items-pass/manifest.json', 'utf8')) as { frames: { key: string }[] }
  for (const art of Object.values(MAP_LAMP_ICON)) assert.ok(manifest.frames.some((f) => f.key === art), `${art} is delivered`)
  assert.deepEqual(mapLampMark(create(MapLampSchema, { land: land(1, 1) })), { art: MAP_LAMP_ICON.lit, dimming: false })
  assert.deepEqual(mapLampMark(create(MapLampSchema, { land: create(ChunkLandStatusSchema, { tier: 'built', dimming: true, nextTurning: 'turns' }) })), { art: MAP_LAMP_ICON.dimming, dimming: true })
  assert.deepEqual(mapLampMark(create(MapLampSchema, {})), { art: MAP_LAMP_ICON.lit, dimming: false })
})
