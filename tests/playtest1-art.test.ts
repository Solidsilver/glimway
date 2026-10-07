import test from 'node:test'
import assert from 'node:assert/strict'
import { HEAL_BAND, flattenFamily, healFamily, seam, seamStep, type Rgba } from '../src/game/ground-heal.ts'
import { BASE_TILES, baseTile, classGrid, edgeKey, groundField, neighbourhood, parseEdgeKey, paintEdge, type GroundClass } from '../src/game/area/ground-field.ts'
import { APPROACH, ROUTINES, atHome, newWalker, tickWalker, tileFeet, type Step } from '../src/game/npc-routines.ts'
import { facingOf } from '../src/game/people.ts'
import { buildArea } from '../src/game/worlds.ts'
import { TERRAIN } from '../src/game/textures.ts'

/** A noisy 64-texel tile: stripes and speckle, different per seed, never seamless. */
function noiseTile(seed: number, n = 64): Rgba {
  const data = new Uint8Array(n * n * 4)
  let s = seed * 2654435761
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 1) | 0) >>> 0) / 4294967296
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4
      data[o] = Math.round(40 + x * 2 + 30 * Math.sin((x + seed * 7) / 5) + rnd() * 30)
      data[o + 1] = Math.round(60 + y * 2 + 30 * Math.cos((y + seed * 3) / 6) + rnd() * 30)
      data[o + 2] = Math.round(60 + rnd() * 80)
      data[o + 3] = 255
    }
  return { w: n, h: n, data }
}

test('heal: every pair of a family meets without a seam, both ways, and keeps its middle', () => {
  const raw = [noiseTile(1), noiseTile(2), noiseTile(3)]
  const healed = healFamily(raw)
  for (const a of raw) for (const b of raw) assert.ok(seamStep(a, b).border > seamStep(a, b).inside * 1.5, 'the raw tiles have seams')
  for (const a of healed)
    for (const b of healed) {
      for (const vertical of [false, true]) {
        const s = seamStep(a, b, vertical)
        // Across a border: two neighbouring columns (rows) of the reference.
        assert.ok(s.border <= s.inside * 1.6 + 6, `seam ${s.border.toFixed(1)} vs ${s.inside.toFixed(1)} inside`)
      }
    }
  // The middle, past the bands, is each tile's own.
  healed.forEach((t, i) => {
    for (let y = HEAL_BAND; y < 64 - HEAL_BAND; y++)
      for (let x = HEAL_BAND; x < 64 - HEAL_BAND; x++) {
        const o = (y * 64 + x) * 4
        assert.equal(t.data[o], raw[i].data[o])
      }
  })
})

test('heal: the edge columns and rows are the reference’s neighbours, so any two tiles continue', () => {
  const healed = healFamily([noiseTile(4), noiseTile(5)])
  const px = (t: Rgba, x: number, y: number) => Array.from(t.data.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4))
  // Left edges agree between tiles, and so do right edges (row by row).
  for (let y = 0; y < 64; y++) {
    assert.deepEqual(px(healed[0], 0, y), px(healed[1], 0, y))
    assert.deepEqual(px(healed[0], 63, y), px(healed[1], 63, y))
    assert.deepEqual(px(healed[0], y, 0), px(healed[1], y, 0))
    assert.deepEqual(px(healed[0], y, 63), px(healed[1], y, 63))
  }
})

test('heal: a seam path stays in its band, moves one step at a time and keeps its pins', () => {
  const path = seam(40, 3, 9, (s, p) => Math.abs(p - 6 - Math.round(Math.sin(s / 4) * 3)), 5, 7)
  assert.equal(path[0], 5)
  assert.equal(path[39], 7)
  for (let i = 1; i < path.length; i++) assert.ok(Math.abs(path[i] - path[i - 1]) <= 1 && path[i] >= 3 && path[i] <= 9)
})

test('flatten: evens out broad shading, keeps detail', () => {
  const t = noiseTile(6)
  // A dark left half.
  for (let y = 0; y < 64; y++) for (let x = 0; x < 32; x++) for (let c = 0; c < 3; c++) t.data[(y * 64 + x) * 4 + c] *= 0.5
  const mean = (img: Rgba, x0: number, x1: number) => {
    let s = 0
    for (let y = 0; y < 64; y++) for (let x = x0; x < x1; x++) s += img.data[(y * 64 + x) * 4 + 1]
    return s / (64 * (x1 - x0))
  }
  const [f] = flattenFamily([t], 0.8)
  assert.ok(Math.abs(mean(f, 0, 24) - mean(f, 40, 64)) < Math.abs(mean(t, 0, 24) - mean(t, 40, 64)) * 0.5)
})

test('ground: base tiles are stable by position, accents sparse', () => {
  const w = buildArea('village')
  const grid = classGrid(w.ground)
  const pick = () => w.ground.map((row, y) => row.map((id, x) => baseTile(id, grid[y][x], x, y)))
  assert.deepEqual(pick(), pick(), 'the same tiles every time')
  const all = pick().flat()
  const grass = all.filter((t) => t && (t.includes('grass') || t.includes('moss')))
  const moss = grass.filter((t) => t!.includes('moss'))
  const flowers = grass.filter((t) => t!.includes('flowered'))
  assert.ok(moss.length > 0 && moss.length < grass.length * 0.15, `moss ${moss.length} of ${grass.length}`)
  assert.ok(flowers.length < grass.length * 0.1, `flowers ${flowers.length} of ${grass.length}`)
  // Every grass variant shows up.
  for (const t of BASE_TILES.grass) assert.ok(all.includes(t), t)
  // Walls and roofs keep the old cells.
  assert.equal(baseTile(TERRAIN.roof, null, 0, 0), null)
})

test('ground: the Commons square is flagstones, stray cobbles on the lane are road', () => {
  const ground = [
    [TERRAIN.cobble_moss, TERRAIN.cobble_moss, TERRAIN.cobble, TERRAIN.cobble_moss],
    [TERRAIN.cobble, TERRAIN.cobble, TERRAIN.cobble, TERRAIN.cobble],
    [TERRAIN.cobble, TERRAIN.cobble_moss, TERRAIN.cobble, TERRAIN.cobble],
    [TERRAIN.cobble, TERRAIN.cobble, TERRAIN.cobble, TERRAIN.cobble_moss],
  ]
  const g = classGrid(ground)
  assert.equal(g[1][0], 'flag', 'a cobble joined to the square')
  assert.equal(g[0][2], 'road', 'a cobble with one clean neighbour')
  assert.equal(g[2][1], 'flag', 'a mossy hole in the square')
  assert.equal(g[0][0], 'road')
  assert.equal(classGrid([[TERRAIN.cobble_moss, TERRAIN.cobble, TERRAIN.cobble_moss]])[0][1], 'road', 'a lone cobble on the lane')
})

test('ground: neighbouring edge tiles agree on the texels at their shared border', () => {
  for (const area of ['village', 'commons'] as const) {
    const w = buildArea(area)
    const g = classGrid(w.ground)
    const k = 2
    const m = 3
    let pairs = 0
    let differ = 0
    let texels = 0
    for (let y = 1; y < w.height - 1; y++)
      for (let x = 1; x < w.width - 2; x++) {
        const a = neighbourhood(g, x, y)
        const b = neighbourhood(g, x + 1, y)
        if (!a || !b || !edgeKey(a, x, y) || !edgeKey(b, x + 1, y)) continue
        pairs++
        const fa = groundField(a, x, y, k, m)
        const fb = groundField(b, x + 1, y, k, m)
        const cell = 16 * k
        // A's ring just right of it is B's first columns.
        for (let r = 0; r < cell; r++)
          for (let c = 0; c < m; c++) {
            texels++
            const ca = fa.classes[fa.at[(r + m) * fa.size + m + cell + c]]
            const cb = fb.classes[fb.at[(r + m) * fb.size + m + c]]
            if (ca !== cb) differ++
          }
      }
    assert.ok(pairs > 20, `${area}: ${pairs} edge pairs`)
    assert.ok(differ <= texels * 0.002, `${area}: ${differ} of ${texels} border texels disagree`)
  }
})

test('ground: overlays paint only what changes, outlined on the lower ground', () => {
  // A path tile with grass along its north side: grass creeps over it, outlined on the path.
  const n: GroundClass[] = ['grass', 'grass', 'grass', 'dirt', 'dirt', 'dirt', 'dirt', 'dirt', 'dirt']
  const flat = (c: GroundClass): [number, number, number] => (c === 'grass' ? [40, 160, 40] : [180, 120, 60])
  const out = paintEdge(n, 5, 5, 2, 0, (c) => flat(c))
  let clear = 0
  let grass = 0
  let dark = 0
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) clear++
    else if (out[i + 1] >= 160) grass++
    else if (out[i] < 100 && out[i + 1] < 80) dark++
  }
  assert.ok(clear > 0 && grass > 0 && dark > 0, `${clear} clear, ${grass} grass, ${dark} outline`)
  assert.deepEqual(parseEdgeKey(edgeKey(n, 5, 5)!), { n, tx: 5, ty: 5 })
  assert.equal(edgeKey(Array(9).fill('grass'), 0, 0), null)
})

/** Walk a routine's legs on the map: open ground, one axis at a time, ending at home. */
function routeTiles(home: { tx: number; ty: number }, steps: readonly Step[]): { tx: number; ty: number }[] {
  const out: { tx: number; ty: number }[] = []
  let at = home
  for (const s of steps) {
    if (s.kind !== 'walk') continue
    assert.ok(s.tx === at.tx || s.ty === at.ty, `leg ${at.tx},${at.ty} → ${s.tx},${s.ty} is one axis`)
    for (let tx = Math.min(at.tx, s.tx); tx <= Math.max(at.tx, s.tx); tx++) for (let ty = Math.min(at.ty, s.ty); ty <= Math.max(at.ty, s.ty); ty++) out.push({ tx, ty })
    at = { tx: s.tx, ty: s.ty }
  }
  assert.deepEqual(at, { tx: home.tx, ty: home.ty }, 'the loop ends at home')
  return out
}

test('routines: every leg crosses open ground (no walls, props, trees or people) and comes home', () => {
  for (const [area, routines] of Object.entries(ROUTINES)) {
    const w = buildArea(area as 'village')
    const blocked = new Set<string>()
    for (const t of [...w.trees, ...w.bushes, ...w.rocks, ...w.props]) blocked.add(`${t.tx},${t.ty}`)
    for (const [id, steps] of Object.entries(routines)) {
      const spot = w.npcs.find((n) => n.id === id)
      assert.ok(spot, `${id} lives in ${area}`)
      for (const n of w.npcs) if (n.id !== id) blocked.add(`${n.tx},${n.ty}`)
      for (const t of routeTiles(spot!, steps)) {
        assert.equal(w.solid[t.ty][t.tx], false, `${id}: ${t.tx},${t.ty} is open`)
        assert.ok(!blocked.has(`${t.tx},${t.ty}`), `${id}: nothing stands on ${t.tx},${t.ty}`)
      }
      for (const n of w.npcs) if (n.id !== id) blocked.delete(`${n.tx},${n.ty}`)
      for (const s of steps) if (s.kind === 'sit') assert.ok(w.props.some((p) => p.frame === 'patched-bench' && p.tx === s.tx && p.ty === s.ty), `${id} sits on a bench`)
    }
  }
})

test('routines: a resident strolls when you are away and is home by the time you are near', () => {
  const home = tileFeet(12, 15)
  const routine = ROUTINES.village.hazel
  const w = newWalker(home)
  const far = { x: home.x + 300, y: home.y }
  const seen = new Set<string>()
  for (let t = 0; t < 60; t += 0.05) {
    tickWalker(w, routine, home, far, 0.05, false)
    seen.add(`${w.mode}:${w.facing}`)
  }
  assert.ok(seen.has('sit:down'), 'she sits')
  assert.ok([...seen].some((s) => s.startsWith('walk:')), 'she walks')
  // Mid-routine, you come near: she stands, walks home the way she came and stays.
  const w2 = newWalker(home)
  for (let t = 0; t < 14; t += 0.05) tickWalker(w2, routine, home, far, 0.05, false)
  assert.ok(!atHome(w2, home), 'away from home')
  const near = { x: home.x + APPROACH - 10, y: home.y }
  for (let t = 0; t < 10; t += 0.05) tickWalker(w2, routine, home, near, 0.05, false)
  assert.ok(atHome(w2, home), 'home again')
  assert.equal(w2.facing, 'down', 'looking down the lane while you are a way off')
  tickWalker(w2, routine, home, { x: home.x + 30, y: home.y }, 0.05, false)
  assert.equal(w2.facing, 'right', 'facing you once you are close')
  // Held still (a conversation): nobody moves.
  const w3 = newWalker(home)
  for (let t = 0; t < 30; t += 0.05) tickWalker(w3, routine, home, far, 0.05, true)
  assert.ok(atHome(w3, home))
})

test('facing: the larger axis wins', () => {
  assert.equal(facingOf(-1, 0.2), 'left')
  assert.equal(facingOf(0.1, -1), 'up')
  assert.equal(facingOf(0, 0, 'right'), 'right')
})

test('tileset assembly: a cell is copied in and ringed by its own edge texels, corners included', async () => {
  const { putCell } = await import('../src/game/area/ground-paint.ts')
  const cell = 3
  const w = cell + 2
  const t = { w, data: new Uint8ClampedArray(w * w * 4) }
  const rgba = new Uint8ClampedArray(cell * cell * 4).map((_, i) => (i % 4 === 3 ? 255 : Math.floor(i / 4) + 1))
  putCell(t, 1, 1, cell, rgba)
  const at = (x: number, y: number) => t.data[(y * w + x) * 4]
  // Inside: texels 1..9 row by row.
  assert.deepEqual([at(1, 1), at(3, 1), at(1, 3), at(3, 3)], [1, 3, 7, 9])
  // The ring repeats the nearest edge texel (as the four drawImage copies did).
  assert.deepEqual([at(0, 0), at(2, 0), at(4, 0)], [1, 2, 3])
  assert.deepEqual([at(0, 2), at(4, 2)], [4, 6])
  assert.deepEqual([at(0, 4), at(2, 4), at(4, 4)], [7, 8, 9])
})

test('tileset assembly: jobs paint the same overlays as paintEdge, in any batching', async () => {
  const { paintEdgeJobs, edgeRefNames } = await import('../src/game/area/ground-paint.ts')
  const k = 1
  const refs = Object.fromEntries(edgeRefNames().map((n, j) => [n, new Uint8ClampedArray(16 * 16 * 4).map((_, i) => (i * 7 + j * 31) & 255)]))
  const n: GroundClass[] = ['grass', 'grass', 'grass', 'water', 'water', 'grass', 'water', 'water', 'water']
  const key = edgeKey(n, 3, 4)!
  const jobs = [0, 1, 2].map((f) => ({ key, f, i: 10 + f }))
  const all = paintEdgeJobs(jobs, refs, k)
  const split = [...paintEdgeJobs(jobs.slice(0, 1), refs, k), ...paintEdgeJobs(jobs.slice(1), refs, k)]
  assert.deepEqual(all.map((c) => c.i), [10, 11, 12])
  for (let j = 0; j < 3; j++) assert.deepEqual(Array.from(split[j].rgba), Array.from(all[j].rgba))
})
