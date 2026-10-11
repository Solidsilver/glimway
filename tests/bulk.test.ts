import test from 'node:test'
import assert from 'node:assert/strict'
import type Phaser from 'phaser'
import { addAll, destroyAll, destroyStatics, enableStatics } from '../src/game/area/bulk.ts'

/**
 * A stand-in for Phaser 3.90's display list and game objects, as far as
 * src/game/area/bulk.ts reaches into them: the list array, the add and
 * remove callbacks, and `destroy` asking its list whether it is still on it
 * (GameObject.removeFromDisplayList) and taking itself off one by one.
 */
function fakeScene() {
  const scans = { exists: 0, removes: 0 }
  const events: string[] = []
  const children = {
    list: [] as Fake[],
    exists(o: Fake) {
      scans.exists++
      return this.list.includes(o)
    },
    remove(o: Fake) {
      scans.removes++
      this.list.splice(this.list.indexOf(o), 1)
      this.removeChildCallback(o)
    },
    addChildCallback(o: Fake) {
      o.displayList = children
      events.push(`added ${o.name}`)
    },
    removeChildCallback(o: Fake) {
      o.displayList = null
      events.push(`removed ${o.name}`)
    },
  }
  class Fake {
    displayList: { exists(o: Fake): boolean; remove?(o: Fake): void } | null = null
    destroyed = false
    readonly name: string
    constructor(name: string) {
      this.name = name
    }
    destroy() {
      const dl = this.displayList ?? children
      if (dl.exists(this)) dl.remove!(this)
      this.destroyed = true
      events.push(`destroyed ${this.name}`)
    }
  }
  const scene = { children } as unknown as Phaser.Scene
  const make = (name: string) => new Fake(name) as Fake
  const asObjects = (fs: Fake[]) => fs as unknown as Phaser.GameObjects.GameObject[]
  return { scene, children, scans, events, make, asObjects }
}

test('addAll puts objects on the list in order, each announced as an add', () => {
  const { scene, children, events, make, asObjects } = fakeScene()
  const objs = ['a', 'b', 'c'].map(make)
  addAll(scene, asObjects(objs))
  assert.deepEqual(children.list.map((o) => o.name), ['a', 'b', 'c'])
  assert.deepEqual(events, ['added a', 'added b', 'added c'])
  assert.ok(objs.every((o) => o.displayList === children))
})

test('destroyAll takes objects off in one pass: the rest keep their order, nothing scans the list per object', () => {
  const { scene, children, scans, events, make, asObjects } = fakeScene()
  const objs = Array.from({ length: 10 }, (_, i) => make(`o${i}`))
  addAll(scene, asObjects(objs))
  events.length = 0
  const going = [objs[7]!, objs[1]!, objs[4]!]
  const stray = make('never-added')
  destroyAll(scene, asObjects([...going, stray]))
  assert.deepEqual(children.list.map((o) => o.name), ['o0', 'o2', 'o3', 'o5', 'o6', 'o8', 'o9'])
  assert.equal(scans.exists, 0, 'destroy never asks the real list')
  assert.equal(scans.removes, 0, 'nothing is spliced out one by one')
  assert.ok([...going, stray].every((o) => o.destroyed && o.displayList !== children))
  // Each listed object is announced removed (in list order), then everything is destroyed.
  assert.deepEqual(events, ['removed o1', 'removed o4', 'removed o7', 'destroyed o7', 'destroyed o1', 'destroyed o4', 'destroyed never-added'])
  destroyAll(scene, [])
  assert.equal(children.list.length, 7)
})

/**
 * A stand-in for Arcade's static world and group as far as bulk.ts reaches
 * in: Phaser's Set (`entries`), the static tree, and the group's destroy
 * listener on each member.
 */
function fakeStatics() {
  const tree = new Set<object>()
  const world = { staticBodies: { entries: [] as object[] }, staticTree: { insert: (b: object) => tree.add(b), remove: (b: object) => tree.delete(b) }, add: () => assert.fail('one by one') }
  const group = { children: { entries: [] as object[] }, add: () => assert.fail('one by one'), remove() {} }
  const listeners = new Map<object, number>()
  const solid = (name: string) => {
    const o = {
      name,
      body: { enable: false, world: world as unknown, gameObject: null as unknown },
      destroyed: false,
      displayList: null as unknown,
      on: () => listeners.set(o, (listeners.get(o) ?? 0) + 1),
      off: () => listeners.set(o, (listeners.get(o) ?? 0) - 1),
      destroy() {
        assert.equal(o.body, undefined, 'a destroyed solid no longer asks the world to drop its body')
        o.destroyed = true
      },
    }
    o.body.gameObject = o
    return o
  }
  return { world, group, tree, listeners, solid }
}

test('static bodies go into the world and the group in one go, and out in one pass each', () => {
  const { world, group, tree, listeners, solid } = fakeStatics()
  const keep = ['k0', 'k1'].map(solid)
  const go = ['g0', 'g1', 'g2'].map(solid)
  enableStatics(world as never, group as never, [keep[0]!, ...go, keep[1]!] as never)
  assert.equal(world.staticBodies.entries.length, 5)
  assert.equal(group.children.entries.length, 5)
  assert.equal(tree.size, 5)
  assert.ok([...keep, ...go].every((o) => o.body.enable && listeners.get(o) === 1), 'enabled, and the group hears of its destroy')
  const bodies = go.map((o) => o.body)
  destroyStatics(world as never, group as never, go as never)
  assert.deepEqual(group.children.entries, keep, 'the rest keep their order')
  assert.deepEqual(world.staticBodies.entries, keep.map((o) => o.body))
  assert.equal(tree.size, 2)
  assert.ok(go.every((o) => o.destroyed && listeners.get(o) === 0))
  assert.ok(bodies.every((b) => !b.enable && b.world === undefined && b.gameObject === undefined), 'the bodies are let go')
})
