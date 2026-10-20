import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryOutboxStore } from '../src/lib/api/outbox.ts';
import { online, rig, tick } from './helpers/link-rig.ts';

/**
 * A link stopped while a save is still out (a world move, a logout, the
 * session swap): the save lands after the tab's BroadcastChannel closed. A
 * closed channel throws on every post, and the throw used to escape the
 * report drain as an uncaught page error (CI run 39203213978,
 * touches.spec.ts). The record is stored all the same; nothing is posted.
 */

/** A BroadcastChannel as browsers have it: posting after close throws. */
function channel() {
  const ch = {
    posts: 0,
    closed: false,
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(_m: unknown) {
      if (ch.closed) throw new Error("InvalidStateError: Failed to execute 'postMessage' on 'BroadcastChannel': Channel is closed");
      ch.posts += 1;
    },
    close() {
      ch.closed = true;
    }
  };
  return ch;
}

test('a report whose record save lands after the link stopped throws nothing, and its record is stored', async (t) => {
  const store = memoryOutboxStore();
  const ch = channel();
  const r = await rig(t, { store, channel: ch });
  await online(r);
  const posted = ch.posts;
  assert.ok(posted > 0, 'a live link tells the other tabs');

  // Hold the next record write.
  const save = store.save.bind(store);
  let release!: () => void;
  const held = new Promise<void>((res) => (release = res));
  let holding = 0;
  const results: string[] = [];
  store.save = async (record) => {
    holding += 1;
    await held;
    const r = await save(record);
    results.push(r);
    return r;
  };
  r.session.state.hp = Math.max(1, r.session.state.hp - 3);
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const drained = r.link.flush();
    for (let i = 0; i < 20 && holding === 0; i++) await tick();
    assert.ok(holding > 0, 'a record save is out');
    r.link.stop();
    release();
    await assert.doesNotReject(drained);
    for (let i = 0; i < 5; i++) await tick();
    assert.deepEqual(unhandled, []);
    assert.equal(ch.posts, posted, 'nothing posted once closed');
    assert.equal(results[0], 'saved', 'the held write is stored');
    assert.ok(await store.load('fixture-account', 'dev'), 'the record is there');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
