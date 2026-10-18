import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { gatedHooks, type FsHooks } from '../src/game/dev-hooks.ts';
import { loadWebSettings, onWebSettings, resetWebSettings, webSettings, type WebSettings } from '../src/lib/web-settings.ts';

/** Hooks in a dev-tools build follow this player's grant (src/game/dev-hooks.ts, docs/design/server-settings.md). */

const scene = () => ({ events: new EventEmitter() });

test('hooks go on with the grant and come off when it goes, and come back with it', () => {
  const w: Partial<FsHooks> = {};
  const gate = gatedHooks(w);
  const held = () => 1;
  gate.expose('__fsHeld', held);
  assert.equal(w.__fsHeld, undefined, 'no grant yet: nothing on window');
  gate.set(true);
  assert.equal(w.__fsHeld, held);
  // Registered while granted: on at once.
  const late = () => 'late';
  gate.expose('__fsNpcs', late as unknown as FsHooks['__fsNpcs']);
  assert.equal(w.__fsNpcs, late);
  gate.set(false);
  assert.equal(w.__fsHeld, undefined, 'revoked: every hook comes off');
  assert.equal(w.__fsNpcs, undefined);
  gate.set(true);
  assert.equal(w.__fsHeld, held, 'granted again: still registered, so back on');
});

test('a disposed or ended registration never comes back, and the newest of a name wins', () => {
  const w: Partial<FsHooks> = {};
  const gate = gatedHooks(w);
  const s = scene();
  const older = () => 1;
  const newer = () => 2;
  gate.expose('__fsHeld', older, s);
  const disposeNewer = gate.expose('__fsHeld', newer);
  gate.set(true);
  assert.equal(w.__fsHeld, newer);
  s.events.emit('shutdown');
  assert.equal(w.__fsHeld, newer, "the older one's scene ending leaves the newer one");
  disposeNewer();
  assert.equal(w.__fsHeld, undefined);
  gate.set(false);
  gate.set(true);
  assert.equal(w.__fsHeld, undefined, 'neither comes back');
});

// The review's case: the next account's scene must never install hooks on
// the last account's grant, and a slow answer for the last account must not
// grant them afterwards.
test('an account switch clears the grant at once, and a stale answer is dropped', async () => {
  const w: Partial<FsHooks> = {};
  const gate = gatedHooks(w);
  const off = onWebSettings((s) => gate.set(!!s.dev?.hooks));
  const grant: WebSettings = { dev: { grant: true, hooks: true, clock: false, fight_fall: false } };
  const answer = (body: WebSettings) => (async () => new Response(JSON.stringify(body))) as typeof fetch;
  await loadWebSettings(answer(grant));
  gate.expose('__fsHeld', () => 1);
  assert.ok(w.__fsHeld, 'the first account has its hooks');

  // A load for the first account is still on its way when the account changes.
  let release!: () => void;
  const slow = (async () => {
    await new Promise<void>((done) => (release = done));
    return new Response(JSON.stringify(grant));
  }) as typeof fetch;
  const stale = loadWebSettings(slow);
  resetWebSettings();
  assert.equal(webSettings().dev, null);
  assert.equal(w.__fsHeld, undefined, 'the switch takes the hooks off before any answer');
  // The new scene registers its hooks: none go on.
  gate.expose('__fsNpcs', (() => []) as unknown as FsHooks['__fsNpcs']);
  assert.equal(w.__fsNpcs, undefined);

  // The new account's answer: no dev tools. Then the stale one arrives.
  await loadWebSettings(answer({ dev: null }));
  release();
  await stale;
  assert.equal(webSettings().dev, null, "the old account's answer changed nothing");
  assert.equal(w.__fsHeld, undefined);
  assert.equal(w.__fsNpcs, undefined);
  off();
});
