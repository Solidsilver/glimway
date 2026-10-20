/**
 * A lot-lantern fill whose follow-up read lands after you've gone (step-back
 * 2 2026-10-18, C3): through the cottage door, or a world move. The fill
 * still counts (the land chip asks again, the pack and the home are read),
 * but the stake left behind neither chimes nor talks over the next scene.
 */
import './helpers/svelte-runes.ts'
import './helpers/scene-modules.ts'
import test from 'node:test'
import assert from 'node:assert/strict'

const { HomesteadTalk } = await import('../src/game/entities/homestead-talk.ts')
const { bus, EV } = await import('../src/game/events.ts')
const store = await import('../src/game/wilds/store.ts')

const flush = () => new Promise((r) => setTimeout(r, 0))

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => (resolve = res))
  return { promise, resolve }
}

/** A homestead layer at a lot's stake: its fill answers `act`, its follow-up read waits on `read`. */
function layer(act: unknown, read: Promise<unknown>) {
  const fetched: number[] = []
  const home = {
    gone: false,
    scene: { sys: { isActive: () => true } },
    deps: { session: { link: { worldId: 'w', accountId: 'acct', readWith: async () => ({ ok: false, code: 'offline' }) }, state: { flags: [], area: 'commons' } } },
    homes: {
      act: async () => act,
      fetchHome: (gate: number) => {
        fetched.push(gate)
        return read
      }
    }
  }
  return { home, fetched, talk: new HomesteadTalk(home as never) }
}

/** What reached the player: dialogues, sounds and toasts. */
function hear() {
  const heard: string[] = []
  const onDialogue = (p: { speaker?: string }) => heard.push(`dialogue:${p.speaker}`)
  const onSfx = (p: { cue: string }) => heard.push(`sfx:${p.cue}`)
  const onToast = (p: { text: string }) => heard.push(`toast:${p.text}`)
  bus.on(EV.dialogue, onDialogue)
  bus.on(EV.sfx, onSfx)
  bus.on(EV.toast, onToast)
  return {
    heard,
    stop: () => {
      bus.off(EV.dialogue, onDialogue)
      bus.off(EV.sfx, onSfx)
      bus.off(EV.toast, onToast)
    }
  }
}

const lantern = { lit: true, wicks: 3, oil: 0 }

test('a fill whose follow-up read lands after you left still counts, and opens nothing', async () => {
  const ear = hear()
  try {
    const read = deferred<unknown>()
    const { home, fetched, talk } = layer({ ok: true }, read.promise)
    const land = store.landRevision()
    const done = talk.onAction('home:lantern:3')
    await flush()
    assert.deepEqual(fetched, [3], 'the home is read again')
    assert.ok(store.landRevision() > land, 'the land chip asks again')
    // Through the door while the read is out.
    home.gone = true
    read.resolve({ lantern })
    await done
    assert.deepEqual(ear.heard, [], 'no chime and no Lot Lantern over the next scene')
  } finally {
    ear.stop()
  }
})

test('a fill answered while you stand there chimes and shows the lantern', async () => {
  const ear = hear()
  try {
    const read = deferred<unknown>()
    const { talk } = layer({ ok: true }, read.promise)
    const done = talk.onAction('home:lantern:3')
    read.resolve({ lantern })
    await done
    assert.deepEqual(ear.heard, ['sfx:settle', 'dialogue:Lot Lantern'])
  } finally {
    ear.stop()
  }
})

test('a fill refused after you left is told as a toast, not by the stake', async () => {
  const ear = hear()
  try {
    const refused = deferred<unknown>()
    const read = deferred<unknown>()
    const { home, talk } = layer(undefined, read.promise)
    ;(home.homes as { act: () => Promise<unknown> }).act = () => refused.promise
    const done = talk.onAction('home:lantern:3')
    home.gone = true
    refused.resolve({ ok: false, text: 'The lantern is full.' })
    await done
    assert.deepEqual(ear.heard, ['toast:The lantern is full.'])
  } finally {
    ear.stop()
  }
})
