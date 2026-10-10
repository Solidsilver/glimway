import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MOUNT_FLOOR, STALLED_DEPTH, STALL_REACH, bayFront, bayFrontPiece, bayStand, homeBay, stableFootprint, stableLayout } from '../src/lib/stable-layout.ts'
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts'
import type { HomeView } from '../src/lib/api/homestead.ts'

const manifest = JSON.parse(readFileSync(new URL('../assets/generated/crafts-pass/manifest.json', import.meta.url), 'utf8')) as {
  frames: Record<string, { canvasSize: { w: number; h: number }; footprint: [number, number] | null }>
}
/** A frame's world size: 64 texels per 16-px tile. */
const world = (frame: string) => {
  const f = manifest.frames[frame]
  assert.ok(f, `${frame} is in the crafts pass`)
  return [f.canvasSize.w / 4, f.canvasSize.h / 4]
}

test('stable layout: the footprint grows east by two tiles a stall, 4 × 3 to 14 × 3', () => {
  assert.deepEqual(stableFootprint(1), [4, 3])
  assert.deepEqual(stableFootprint(2), [6, 3])
  assert.deepEqual(stableFootprint(6), [14, 3])
  // Out of range clamps: never a stable of 0 or 7 stalls.
  assert.deepEqual(stableFootprint(0), [4, 3])
  assert.deepEqual(stableFootprint(9), [14, 3])
})

test('stable layout: the west end, a bay per extra stall, the gable at the east edge', () => {
  for (let n = 1; n <= 6; n++) {
    const L = stableLayout(n)
    const width = L.footprint[0] * 16
    assert.equal(L.stalls, n)
    assert.equal(L.bays.length, n)
    assert.deepEqual(L.back.map((p) => p.frame), ['stable-west-back', ...Array(n - 1).fill('stable-bay-back')])
    // Back pieces tile the footprint edge to edge.
    let x = 0
    for (const p of L.back) {
      assert.equal(p.x, x)
      x += p.w
    }
    assert.equal(x, width)
    assert.deepEqual(L.over.map((p) => [p.frame, p.x]), [['stable-east-gable', width]])
    // Bays are numbered from the west and sit side by side, stall 1 in the west end's east half.
    assert.deepEqual(L.bays.map((b) => b.stall), Array.from({ length: n }, (_, i) => i + 1))
    assert.equal(L.bays[0].x, 32)
    for (const b of L.bays) assert.equal(b.w, 32)
    assert.equal(L.bays.at(-1)!.x + 32, width)
  }
})

test('stable layout: every piece is a delivered frame drawn at its canvas size', () => {
  const L = stableLayout(3)
  const pieces = [...L.back, ...L.over, ...L.bays.flatMap((b) => [bayFrontPiece(b, true), bayFrontPiece(b, false)])]
  for (const p of pieces) assert.deepEqual([p.w, p.h], world(p.frame), p.frame)
  // Stall 1's front is the whole west end (its tack-room wall too); later stalls' fronts are their bay.
  assert.deepEqual(bayFrontPiece(L.bays[0], true), { frame: 'stable-west-front-shut', x: 0, w: 64, h: 80 })
  assert.deepEqual(bayFrontPiece(L.bays[1], false), { frame: 'stable-bay-front-open', x: 64, w: 32, h: 80 })
  // The delivered footprints agree with the layout's.
  assert.deepEqual(manifest.frames['stable-west-back'].footprint, [4, 3])
  assert.deepEqual(manifest.frames['stable-bay-back'].footprint, [2, 3])
})

test('stable layout: a stall is only offered where the server lets you saddle up (two tiles from its bay)', () => {
  // The server's walk-up check (server/internal/api stable.go `stallRect`/`nearStall`): the bay's
  // tiles are x = stable.x + 2·stall, 2 wide, 3 deep; `where` within two tiles of them.
  const T = 16
  const near = (sx: number, sy: number, stall: number, wx: number, wy: number) => {
    const x0 = (sx + 2 * stall) * T, y0 = sy * T, x1 = x0 + 2 * T, y1 = y0 + 3 * T
    const dx = Math.max(x0 - wx, 0, wx - x1), dy = Math.max(y0 - wy, 0, wy - y1)
    return dx * dx + dy * dy <= (2 * T) ** 2
  }
  const sx = 10, sy = 7
  for (let count = 1; count <= 6; count++) {
    for (let stall = 1; stall <= count; stall++) {
      const at = bayFront(sx * T, (sy + 3) * T, count, stall)
      for (let a = 0; a < 360; a += 5) {
        const r = STALL_REACH
        const wx = at.x + r * Math.cos((a * Math.PI) / 180), wy = at.y + r * Math.sin((a * Math.PI) / 180)
        assert.ok(near(sx, sy, stall, wx, wy), `stall ${stall} of ${count}: (${wx.toFixed(1)}, ${wy.toFixed(1)}) is out of the server's reach`)
      }
    }
  }
})

test('Go home on your own land: your mount walks to its bay’s front, then in to where the stable draws it', () => {
  // A three-stall stable at tile (10, 4): its footprint is 8 × 3, so its bottom edge is row 7.
  const home = {
    id: 'h1',
    items: [{ itemDef: HOMESTEAD_DATA.stable.item, scene: 'outdoor', x: 10, y: 4, stalls: 3 }],
    stalls: [
      { stall: 1, mount: 'Lion-Golden', ownerId: 'ivy', ownerName: 'Ivy', out: false },
      { stall: 2, mount: 'Wolf-Shade', ownerId: 'me', ownerName: 'Me', out: true },
      { stall: 3, mount: '', ownerId: '', ownerName: '', out: false },
    ],
  } as unknown as HomeView
  const bx = 10 * 16
  const by = (4 + stableFootprint(3)[1]) * 16
  const walk = homeBay(home, 'me', 'Wolf-Shade')
  assert.ok(walk)
  assert.deepEqual(walk.front, bayFront(bx, by, 3, 2), 'first to the bay’s front, where you stand to use it')
  assert.deepEqual(walk.stand, bayStand(bx, by, 3, 2), 'then in, where a stalled mount stands')
  assert.equal(walk.stand.x, walk.front.x, 'straight in through the half door')
  assert.equal(walk.stand.y, by - MOUNT_FLOOR)
  assert.equal(walk.depth, by + STALLED_DEPTH, 'between the bay’s back and its front')
  // Elsewhere it walks off the screen: a partner’s mount, a mount not stalled here, no stable, no land.
  assert.equal(homeBay(home, 'me', 'Lion-Golden'), null)
  assert.equal(homeBay(home, 'me', 'Fox-Base'), null)
  assert.equal(homeBay({ ...home, items: [] }, 'me', 'Wolf-Shade'), null)
  assert.equal(homeBay(null, 'me', 'Wolf-Shade'), null)
  assert.equal(homeBay(home, null, 'Wolf-Shade'), null)
})
