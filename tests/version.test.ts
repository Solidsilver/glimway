import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateCheck, isNewBuild, parseVersionInfo, RUNNING, type VersionInfo } from '../src/lib/version.ts';

const MIN = 60_000;

// ---------------------------------------------------------------- comparison

test('version.json bodies: only a real { version, build } counts', () => {
  assert.deepEqual(parseVersionInfo({ version: '0.2.0', build: 'abc1234' }), { version: '0.2.0', build: 'abc1234' });
  assert.deepEqual(parseVersionInfo({ version: '0.2.0', build: '35a80b62d321', extra: 1 }), { version: '0.2.0', build: '35a80b62d321' });
  assert.deepEqual(parseVersionInfo({ version: '0.3.0-alpha.1', build: 'abc1234' }), { version: '0.3.0-alpha.1', build: 'abc1234' });
  for (const odd of [null, undefined, 'abc1234', 42, [], {}, { version: '0.2.0' }, { build: 'abc1234' }, { version: 'v0.2.0', build: 'abc1234' }, { version: '0.2', build: 'abc1234' }, { version: '0.2.0', build: '' }, { version: '0.2.0', build: '<html>' }, { version: '0.2.0', build: 7 }]) {
    assert.equal(parseVersionInfo(odd), null, JSON.stringify(odd));
  }
});

test('a new build is any build id other than the running one', () => {
  assert.equal(isNewBuild('abc1234', { version: '0.2.0', build: 'def5678' }), true);
  // A rollback is still a different build: reloading gets what the server serves.
  assert.equal(isNewBuild('abc1234', { version: '0.1.0', build: 'def5678' }), true);
  // The version alone never counts: the same build is the same build.
  assert.equal(isNewBuild('abc1234', { version: '0.2.0', build: 'abc1234' }), false);
  assert.equal(isNewBuild('abc1234', null), false);
});

test('outside Vite the running build reads as dev', () => {
  assert.deepEqual(RUNNING, { version: '0.0.0', build: 'dev' });
});

// ---------------------------------------------------------------- the check

function rig(answers: Array<unknown | Error>, over: { running?: string } = {}) {
  let t = 1_000_000;
  const fetched: number[] = [];
  const shown: VersionInfo[] = [];
  const check = createUpdateCheck({
    running: over.running ?? 'abc1234',
    now: () => t,
    fetchInfo: async () => {
      fetched.push(t);
      const a = answers.length > 1 ? answers.shift() : answers[0];
      if (a instanceof Error) throw a;
      return a;
    },
    onNew: (info) => shown.push(info),
  });
  return {
    check,
    fetched,
    shown,
    advance(ms: number) {
      t += ms;
    },
  };
}

const same = { version: '0.1.0', build: 'abc1234' };
const next = { version: '0.2.0', build: 'def5678' };

test('the page load counts as a check: a quick return to the tab does not fetch', async () => {
  const r = rig([same]);
  await r.check.onVisible();
  r.advance(30_000);
  await r.check.onVisible();
  assert.equal(r.fetched.length, 0);
  r.advance(MIN);
  await r.check.onVisible();
  assert.equal(r.fetched.length, 1);
});

test('while visible, ticks check every ten minutes; visibility at most once a minute', async () => {
  const r = rig([same]);
  r.advance(9 * MIN);
  await r.check.onTick();
  assert.equal(r.fetched.length, 0);
  r.advance(MIN);
  await r.check.onTick();
  assert.equal(r.fetched.length, 1);
  r.advance(MIN / 2);
  await r.check.onVisible();
  assert.equal(r.fetched.length, 1);
  r.advance(MIN / 2);
  await r.check.onVisible();
  assert.equal(r.fetched.length, 2);
  assert.deepEqual(r.shown, []);
});

test('a new build is announced once, and not again once dismissed', async () => {
  const r = rig([next]);
  r.advance(10 * MIN);
  await r.check.onTick();
  assert.deepEqual(r.shown, [next]);
  r.advance(10 * MIN);
  await r.check.onTick();
  assert.equal(r.fetched.length, 2);
  assert.deepEqual(r.shown, [next]);
  r.check.dismiss(next.build);
  r.advance(10 * MIN);
  await r.check.onTick();
  assert.deepEqual(r.shown, [next]);
});

test('a dismissed build does not hide a later one', async () => {
  const later = { version: '0.2.1', build: 'fed9876' };
  const r = rig([next, next, later]);
  await r.check.checkNow();
  r.check.dismiss(next.build);
  await r.check.checkNow();
  await r.check.checkNow();
  assert.deepEqual(r.shown, [next, later]);
});

test('failures and odd answers stay quiet and back off: 20, 40, then 60 minutes at most', async () => {
  const r = rig([new Error('offline'), '<!doctype html>', { status: 'ok' }, new Error('502'), same]);
  r.advance(10 * MIN);
  await r.check.onTick(); // fails: next not before 20 min
  for (const [wait, expectFetches] of [
    [19 * MIN, 1],
    [MIN, 2], // fails again (HTML): 40 min
    [39 * MIN, 2],
    [MIN, 3], // odd JSON: 60 min (the cap, not 80)
    [59 * MIN, 3],
    [MIN, 4], // fails: still capped at 60
    [60 * MIN, 5], // succeeds: back to the ten-minute rhythm
    [10 * MIN, 6],
  ] as const) {
    r.advance(wait);
    await r.check.onTick();
    await r.check.onVisible(); // coming back to the tab doesn't skip the back-off
    assert.equal(r.fetched.length, expectFetches, `after ${r.fetched.length} fetches`);
  }
  assert.deepEqual(r.shown, []);
});

test('checks never overlap', async () => {
  let release!: (v: unknown) => void;
  let calls = 0;
  const check = createUpdateCheck({
    running: 'abc1234',
    fetchInfo: () => {
      calls += 1;
      return new Promise((r) => (release = r));
    },
    onNew: () => {},
  });
  const a = check.checkNow();
  const b = check.checkNow();
  release(same);
  await Promise.all([a, b]);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------- the build id

test('the build id: a given one (a full commit shortened), else git or a content hash', async () => {
  const { buildInfo, contentHash, readVersion } = await import('../scripts/build-version.mjs');
  const root = new URL('..', import.meta.url).pathname;
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(`${root}package.json`, 'utf8'));
  assert.equal(readVersion(root), pkg.version);
  const sha = '0123456789abcdef0123456789abcdef01234567';
  assert.deepEqual(buildInfo(root, { GLIMWAY_BUILD: sha }), { version: pkg.version, build: '0123456' });
  assert.equal(buildInfo(root, { GLIMWAY_BUILD: 'nix-abc' }).build, 'nix-abc');
  // Nothing usable given: the checkout's commit or the inputs' hash.
  for (const env of [{}, { GLIMWAY_BUILD: '' }, { GLIMWAY_BUILD: 'not a build id' }]) {
    assert.match(buildInfo(root, env).build, /^[0-9a-f]{7,12}$/);
  }
  assert.equal(contentHash(root), contentHash(root));
});
