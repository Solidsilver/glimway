import test from 'node:test'
import assert from 'node:assert/strict'
import { ownCollider } from '../src/game/entities/collider-lifetime.ts'

test('destroying a sprite unregisters its collider exactly once', () => {
  let onDestroy: (() => void) | undefined
  let destroys = 0
  ownCollider({ once(event, fn) { assert.equal(event, 'destroy'); onDestroy = fn } }, { destroy() { destroys++ } })
  assert.equal(destroys, 0)
  onDestroy!()
  assert.equal(destroys, 1)
})
