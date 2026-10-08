import test from 'node:test'
import assert from 'node:assert/strict'
import { installFakeIndexedDB, resetFakeIndexedDB, readRawRecord } from './helpers/fake-indexeddb.ts'
import {
  REMEMBER_DB,
  forgetRemembered,
  loadRemembered,
  saveRemembered,
  setRememberedBackend,
  type RememberedBackend
} from '../src/lib/habitica/remembered.ts'
import { exportSave, loadGame, saveGame } from '../src/lib/save.ts'
import { createNewGame } from '../src/lib/state.ts'

const USER = '11111111-aaaa-4bbb-8ccc-222222222222'
const TOKEN = '99999999-ffff-4eee-9ddd-888888888888'
const creds = { userId: USER, apiToken: TOKEN }

function setup() {
  installFakeIndexedDB()
  resetFakeIndexedDB()
  setRememberedBackend(null)
}

test('nothing is remembered by default', async () => {
  setup()
  assert.equal(await loadRemembered(), null)
})

test('save → load → forget round-trips through IndexedDB', async () => {
  setup()
  assert.equal(await saveRemembered(creds), true)
  assert.deepEqual(await loadRemembered(), creds)
  assert.equal(await forgetRemembered(), true)
  assert.equal(await loadRemembered(), null)
})

test('credentials live in their own database, not the save database', async () => {
  setup()
  await saveRemembered(creds)
  await saveGame(createNewGame())
  assert.ok(readRawRecord(REMEMBER_DB, 'credentials', 'habitica'))
  assert.notEqual(REMEMBER_DB, 'fingersnap')
  assert.equal(readRawRecord('fingersnap', 'credentials', 'habitica'), undefined)
  assert.ok(!JSON.stringify(readRawRecord('fingersnap', 'saves', 'current')).includes(TOKEN))
})

test('saves and exports never contain remembered credentials', async () => {
  setup()
  await saveRemembered(creds)
  const state = createNewGame()
  await saveGame(state)
  const loaded = await loadGame()
  assert.ok(loaded)
  const exported = exportSave(state)
  for (const text of [exported, JSON.stringify(loaded), JSON.stringify(readRawRecord('fingersnap', 'saves', 'current'))]) {
    assert.ok(!text.includes(USER) && !text.includes(TOKEN))
  }
  // Even a stray credential handed to the state is stripped by validation.
  const dirty = { ...state, apiToken: TOKEN, userId: USER } as unknown as typeof state
  assert.ok(!exportSave(dirty).includes(TOKEN))
})

test('unavailable storage: every call degrades quietly', async () => {
  setup()
  const broken: RememberedBackend = {
    read: () => Promise.reject(new Error('nope')),
    write: () => Promise.reject(new Error('nope')),
    remove: () => Promise.reject(new Error('nope'))
  }
  setRememberedBackend(broken)
  assert.equal(await loadRemembered(), null)
  assert.equal(await saveRemembered(creds), false)
  assert.equal(await forgetRemembered(), false)
  // And with no indexedDB at all:
  setRememberedBackend(null)
  ;(globalThis as { indexedDB?: unknown }).indexedDB = undefined
  assert.equal(await loadRemembered(), null)
  assert.equal(await saveRemembered(creds), false)
  assert.equal(await forgetRemembered(), false)
})

test('a malformed stored record reads as nothing remembered', async () => {
  setup()
  setRememberedBackend({ read: async () => ({ userId: 5 }), write: async () => {}, remove: async () => {} })
  assert.equal(await loadRemembered(), null)
  setRememberedBackend(null)
})
