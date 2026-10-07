import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { installDirs, installStaged } from '../scripts/atlas-install.ts'
import { hook, type FsHooks } from '../src/game/dev-hooks.ts'
import { onSceneEnd } from '../src/game/scene-end.ts'
import { setSyncSafety, syncSafety, type SyncSafety } from '../src/game/sync-safety.ts'
import { DialogueHold } from '../src/game/dialogue-hold.ts'

/**
 * The game lane's review fixes (cleanup phases 0-1, .agent/REVIEW.md): the
 * atlas install's rollback, playtest hooks owned per registration and
 * cleared on either end of a scene, the sync-safety seam's owner, and
 * Silas's loading hold.
 */

// ---------------------------------------------------------------- atlas install

function packedFixture() {
  const root = mkdtempSync(join(tmpdir(), 'glimway-install-'))
  const dest = join(root, 'public', 'packed')
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'atlases.json'), 'old')
  const dirs = installDirs(dest, 'test')
  mkdirSync(dirs.staged)
  writeFileSync(join(dirs.staged, 'atlases.json'), 'new')
  return { root, dest, dirs, read: () => readFileSync(join(dest, 'atlases.json'), 'utf8') }
}

test('install: staging and backup sit beside the destination, dot-named and tagged per run', () => {
  const dest = '/x/public/assets/fingersnap/packed'
  const a = installDirs(dest, 'a')
  assert.equal(dirname(a.staged), dirname(dest), 'same folder, so the renames stay on one filesystem')
  assert.equal(dirname(a.backup), dirname(dest))
  assert.match(a.staged, /\/\.packed-staging-a$/)
  assert.match(a.backup, /\/\.packed-old-a$/)
  assert.notEqual(a.staged, installDirs(dest, 'b').staged, 'two runs never share a folder')
})

test('install: the new folder replaces the old one, and the backup is removed', () => {
  const f = packedFixture()
  try {
    installStaged(f.dest, f.dirs)
    assert.equal(f.read(), 'new')
    assert.equal(existsSync(f.dirs.backup), false)
    assert.equal(existsSync(f.dirs.staged), false)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('install: a first build has nothing to set aside', () => {
  const f = packedFixture()
  try {
    rmSync(f.dest, { recursive: true })
    installStaged(f.dest, f.dirs)
    assert.equal(f.read(), 'new')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('install: when the new folder can’t go in, the old one comes back (review finding 1)', async () => {
  const { renameSync } = await import('node:fs')
  const f = packedFixture()
  try {
    let calls = 0
    const failing = (from: string, to: string) => {
      calls += 1
      if (calls === 2) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      renameSync(from, to)
    }
    assert.throws(() => installStaged(f.dest, f.dirs, failing), /EACCES/)
    assert.equal(f.read(), 'old', 'public/ keeps the committed atlases')
    assert.equal(existsSync(f.dirs.backup), false, 'restored from the backup, not left beside it')
    assert.equal(existsSync(f.dirs.staged), true, 'the bake is left for the build to clean up')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- scene end and hooks

const scene = () => ({ events: new EventEmitter() })
const listeners = (s: ReturnType<typeof scene>) => s.events.listenerCount('shutdown') + s.events.listenerCount('destroy')

test('onSceneEnd: runs once on shutdown or destroy, and leaves no listener behind', () => {
  for (const event of ['shutdown', 'destroy']) {
    const s = scene()
    let ran = 0
    onSceneEnd(s, () => ran++)
    s.events.emit(event)
    s.events.emit('shutdown')
    s.events.emit('destroy')
    assert.equal(ran, 1, event)
    assert.equal(listeners(s), 0, `${event}: nothing piles up across restarts`)
  }
})

test('hooks: cleared when their scene shuts down or is destroyed (review finding 2)', () => {
  for (const event of ['shutdown', 'destroy']) {
    const w: Partial<FsHooks> = {}
    const s = scene()
    hook(w, '__fsHomes', () => 'homes', s)
    assert.equal(w.__fsHomes?.(), 'homes')
    s.events.emit(event)
    assert.equal('__fsHomes' in w, false, `${event} removes the hook`)
  }
})

test('hooks: an older scene ending never removes a newer registration, even of the same function', () => {
  const w: Partial<FsHooks> = {}
  const shared = () => null // like terrain's groundView or the world's syncSafety
  const older = scene()
  const newer = scene()
  hook(w, '__fsGround', shared, older)
  hook(w, '__fsGround', shared, newer)
  older.events.emit('shutdown')
  assert.equal(w.__fsGround, shared, 'the newer owner keeps it')
  newer.events.emit('destroy')
  assert.equal('__fsGround' in w, false)
})

test('hooks: one without a scene stays until replaced', () => {
  const w: Partial<FsHooks> = {}
  hook(w, '__fsHeld', () => 1)
  const next = () => 2
  hook(w, '__fsHeld', next)
  assert.equal(w.__fsHeld, next)
})

// ---------------------------------------------------------------- sync safety

const answer = (areaId: string): (() => SyncSafety) => () => ({ areaId, transitioning: false, dialogueOpen: false, enemiesNear: false })

test('sync safety: no live world answers null; a world answers until its scene ends (review finding 3)', () => {
  const s = scene()
  onSceneEnd(s, setSyncSafety(answer('village')))
  assert.equal(syncSafety()?.areaId, 'village')
  s.events.emit('destroy') // game.destroy: a session swap
  assert.equal(syncSafety(), null, 'a dead world never answers for the next one')
})

test('sync safety: an older world ending never clears a newer one', () => {
  const older = scene()
  const newer = scene()
  onSceneEnd(older, setSyncSafety(answer('village')))
  onSceneEnd(newer, setSyncSafety(answer('commons')))
  older.events.emit('shutdown')
  assert.equal(syncSafety()?.areaId, 'commons')
  newer.events.emit('shutdown')
  assert.equal(syncSafety(), null)
})

// ---------------------------------------------------------------- Silas's hold

test('dialogue hold: the owner ending lets go; a late answer never clears a newer conversation (review finding 4)', () => {
  const ui = { dialogueOpen: false }
  const hold = new DialogueHold(ui)
  hold.take()
  assert.equal(ui.dialogueOpen, true, 'the world holds still while Silas reads')
  hold.release() // his scene ends before the plot book answers
  assert.equal(ui.dialogueOpen, false)
  ui.dialogueOpen = true // a conversation in the next scene
  hold.release() // the old load settles late
  assert.equal(ui.dialogueOpen, true, 'the newer conversation keeps its flag')
})

test('dialogue hold: once the conversation opens, the hold no longer owns the flag', () => {
  const ui = { dialogueOpen: false }
  const hold = new DialogueHold(ui)
  hold.take()
  hold.settle() // Silas speaks: the dialogue owns the flag now
  hold.release() // the scene ends mid-conversation
  assert.equal(ui.dialogueOpen, true, 'closing is the dialogue’s business')
})
