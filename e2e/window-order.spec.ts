import { expect, test } from '@playwright/test'

/**
 * The open map builds attached chunks a slice a frame, in attachment order
 * (src/game/wilds/window-chunk.ts BuildQueue), because Phaser's depth sort
 * keeps ties in display-list order: two trees of equal depth overlapping
 * across a chunk edge cover each other the way they were added. A patch (a
 * near read carrying someone's laid stone) or a relay (a plank turning to
 * meet one across the edge) can need a later chunk whole before an earlier
 * one is: it must not draw the later chunk's trees first.
 *
 * Real Phaser 3.90, on a bare harness page (e2e/harness/phaser.html), no
 * server: chunk A (an oak on its east edge) attached before chunk B (a pine
 * on its west edge, the same row), the two overlapping on screen.
 */

type Outcome = { order: string[]; pixels: number[] }

for (const interrupt of ['patch', 'relay'] as const) {
  test(`a ${interrupt} reaching a later chunk mid-build leaves the same overlap and pixels as building in order`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/e2e/harness/phaser.html')
    await page.waitForFunction(() => !!(window as unknown as { harness?: unknown }).harness)
    const run = (how: 'in order' | 'patch' | 'relay') =>
      page.evaluate(async (how): Promise<Outcome> => {
        type Chunk = { build(d: number): boolean; destroy(): void; patch(t: unknown): boolean; relay(tx: number, ty: number): boolean }
        const { scene: s, game, AttachedChunk, BuildQueue, TileArt, TERRAIN } = (window as unknown as { harness: Record<string, any> }).harness
        const terrain = (cx: number, kind: string, tx: number) => {
          const t = {
            epochId: 'e', cx, cy: 0, size: 24, look: 'tangle', mark: null, tier: 1, land: 'woods', sites: [], entities: [], places: [],
            decor: [{ kind, tx, ty: 5, ox: 0, oy: 0, variant: 0, flip: false, overhang: false }],
            ground: Array.from({ length: 24 }, () => Array(24).fill(0)),
            solid: Array.from({ length: 24 }, () => Array(24).fill(false)),
          }
          t.solid[5]![tx] = true
          return t
        }
        const builds = new BuildQueue()
        const deps = {
          scene: s, solids: s.physics.add.staticGroup(), tileArt: new TileArt(), builds,
          ground: { ground: () => 0, solid: () => false }, gather: () => [], reducedMotion: true,
          gathering: () => null, entities: { attach() {}, detach() {} }, occluders: { add() {}, remove() {} },
        }
        const ta = terrain(0, 'oak', 23)
        const tb = terrain(1, 'pine', 0)
        s.cameras.main.setScroll(320, 20).setZoom(1)
        const a: Chunk = new AttachedChunk(deps, ta, 'ground')
        const b: Chunk = new AttachedChunk(deps, tb, 'ground')
        if (how !== 'in order') {
          builds.step(-Infinity) // a slice of A: A is still building
          if (how === 'patch') {
            // Someone's laid stone in B, well away from the trees (and off screen).
            const changed = structuredClone(tb)
            changed.ground[10]![10] = TERRAIN.stone_a
            b.patch(changed)
          } else b.relay(24 + 10, 10) // a neighbour's plank turning B's tile
        }
        builds.step(Infinity)
        const pixels = await new Promise<number[]>((resolve) =>
          game.events.once('postrender', () => {
            const gl = game.renderer.gl as WebGLRenderingContext
            const data = new Uint8Array(128 * 128 * 4)
            gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, data)
            resolve([...data])
          }),
        )
        const order = s.children.list.filter((o: any) => o.getData?.('tile')).map((o: any) => o.getData('tile'))
        a.destroy()
        b.destroy()
        return { order, pixels }
      }, how)
    const expected = await run('in order')
    expect(expected.order, 'A attached first: its oak first').toEqual(['23,5', '24,5'])
    expect(expected.pixels.some((v, i) => i % 4 !== 3 && v !== 0), 'the trees are on screen').toBe(true)
    const actual = await run(interrupt)
    expect(actual.order).toEqual(expected.order)
    let differing = 0
    for (let i = 0; i < actual.pixels.length; i += 4) if ([0, 1, 2, 3].some((j) => actual.pixels[i + j] !== expected.pixels[i + j])) differing++
    expect(differing, 'pixels differing from building in order').toBe(0)
    expect(errors).toEqual([])
  })
}
