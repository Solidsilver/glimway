import test from 'node:test'
import assert from 'node:assert/strict'
import './helpers/svelte-runes.ts'
import type { Release } from '../src/lib/changelog.ts'

const { WhatsNewStore } = await import('../src/ui/whats-new-store.svelte.ts')

const KEY = 'glimway:whats-new'
const RELEASES: Release[] = [
  { version: '0.3.0', date: null, players: ['Lamps.'] },
  { version: '0.2.0', date: null, players: ['Rooms.'] },
  { version: '0.1.0', date: null, players: ['The road.'] }
]
const RUNNING = { version: '0.3.0', build: 'new' }

/** A fresh localStorage holding `seen` (or nothing). */
function storage(seen?: unknown): Map<string, string> {
  const items = new Map<string, string>()
  if (seen !== undefined) items.set(KEY, JSON.stringify(seen))
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k)
  }
  return items
}

const versions = (shown: Release[] | null) => shown?.map((r) => r.version) ?? null
const stored = (items: Map<string, string>) => JSON.parse(items.get(KEY) ?? 'null')

test('a skipped release survives a look from the Menu while the catch-up waits (start → openLatest → close)', () => {
  const items = storage({ version: '0.1.0', build: 'old' })
  const store = new WhatsNewStore(RELEASES, RUNNING)
  store.start()
  assert.deepEqual(versions(store.shown), ['0.3.0', '0.2.0'])

  // The catch-up is still waiting (behind a conversation): the Menu's look shows the newest.
  store.openLatest()
  assert.deepEqual(versions(store.shown), ['0.3.0'])
  store.close()
  // Looking isn't catching up: nothing remembered, and the full catch-up is back.
  assert.deepEqual(stored(items), { version: '0.1.0', build: 'old' })
  assert.deepEqual(versions(store.shown), ['0.3.0', '0.2.0'])

  store.close()
  assert.equal(store.shown, null)
  assert.deepEqual(stored(items), RUNNING)

  // The next page has nothing to catch up.
  const next = new WhatsNewStore(RELEASES, RUNNING)
  next.start()
  assert.equal(next.shown, null)
})

test('a reload before closing the catch-up shows it again', () => {
  storage({ version: '0.1.0', build: 'old' })
  new WhatsNewStore(RELEASES, RUNNING).start()
  const again = new WhatsNewStore(RELEASES, RUNNING)
  again.start()
  assert.deepEqual(versions(again.shown), ['0.3.0', '0.2.0'])
})

test('the Menu’s look with no catch-up waiting remembers nothing, and start runs once a page', () => {
  const items = storage()
  const store = new WhatsNewStore(RELEASES, RUNNING)
  store.start()
  assert.equal(store.shown, null, 'a first visit catches up quietly')
  assert.deepEqual(stored(items), RUNNING)
  items.set(KEY, JSON.stringify({ version: '0.1.0', build: 'old' }))
  store.start()
  assert.equal(store.shown, null, 'only the first start counts')
  store.openLatest()
  assert.deepEqual(versions(store.shown), ['0.3.0'])
  store.close()
  assert.equal(store.shown, null)
  assert.deepEqual(stored(items), { version: '0.1.0', build: 'old' })
})

test('a build with nothing written up says so from the Menu', () => {
  storage()
  const store = new WhatsNewStore([], { version: '0.0.1', build: 'x' })
  store.openLatest()
  assert.deepEqual(store.shown, [])
  store.close()
  assert.equal(store.shown, null)
})
