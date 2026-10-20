import test from 'node:test';
import assert from 'node:assert/strict';
import { Loading, SLOW_MS, STUCK_MS, LOAD_STAGES, type LoadView } from '../src/lib/loading.ts';
import { LoadTimings, artCacheSummary, deviceLine, formatTimings, TIMINGS_KEPT } from '../src/lib/load-timings.ts';
import { loadingLines } from '../src/content/loading.ts';

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0;
  let timers: { at: number; fn: () => void }[] = [];
  return {
    get now() {
      return now;
    },
    after(ms: number, fn: () => void) {
      const t = { at: now + ms, fn };
      timers.push(t);
      return () => (timers = timers.filter((x) => x !== t));
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = end;
    },
  };
}

function rig() {
  const clock = fakeClock();
  const marks: string[] = [];
  const timings = new LoadTimings({ perf: { now: () => clock.now, mark: (n) => marks.push(n), measure: (n) => marks.push(`measure ${n}`) }, wall: () => Date.UTC(2026, 9, 18, 20, 14) });
  const views: (LoadView | null)[] = [];
  const loading = new Loading({ clock, changed: (v) => views.push(v), timings });
  return { clock, loading, timings, views, marks };
}

test('every stage has a line for the lore pass', () => {
  for (const s of LOAD_STAGES) assert.ok(loadingLines[s]?.length, s);
});

test('a load walks its stages and ends when the world is drawn, each stage timed', () => {
  const { clock, loading, timings, marks } = rig();
  loading.begin('enter', 'connect');
  assert.equal(loading.view?.stage, 'connect');
  clock.advance(1200);
  loading.stage('land');
  clock.advance(300);
  loading.stage('fetch');
  loading.progress(0.5);
  assert.equal(loading.view?.progress, 0.5);
  clock.advance(2000);
  loading.stage('build');
  assert.equal(loading.view?.progress, null, 'a new stage starts its own count');
  clock.advance(4000);
  loading.stage('paint');
  clock.advance(500);
  loading.done();
  assert.equal(loading.view, null);
  const r = timings.records[0]!;
  assert.equal(r.outcome, 'shown');
  assert.deepEqual(r.stages, [
    { stage: 'connect', ms: 1200 },
    { stage: 'land', ms: 300 },
    { stage: 'fetch', ms: 2000 },
    { stage: 'build', ms: 4000 },
    { stage: 'paint', ms: 500 },
  ]);
  assert.equal(r.totalMs, 8000);
  assert.ok(marks.includes('glimway:load:mark:fetch') && marks.includes('measure glimway:load:fetch'), 'performance marks and measures for the browser panel');
});

test('8 s on one stage: the gentle line; a new stage clears it', () => {
  const { clock, loading } = rig();
  loading.begin('enter', 'connect');
  clock.advance(SLOW_MS - 1);
  assert.equal(loading.view?.slow, false);
  clock.advance(1);
  assert.equal(loading.view?.slow, true);
  assert.equal(loading.view?.stuck, false);
  loading.stage('land');
  assert.equal(loading.view?.slow, false);
});

test('progress keeps a long stage from being stuck, but not from being slow', () => {
  const { clock, loading } = rig();
  loading.begin('enter', 'build');
  for (let i = 1; i <= 8; i++) {
    clock.advance(STUCK_MS - 1000);
    loading.progress(i / 10);
  }
  assert.equal(loading.view?.slow, true);
  assert.equal(loading.view?.stuck, false, 'still moving');
  clock.advance(STUCK_MS);
  assert.equal(loading.view?.stuck, true, '30 s with nothing moving');
  loading.progress(0.95);
  assert.equal(loading.view?.stuck, false, 'it moved again');
  loading.progress(0.9);
  assert.equal(loading.view?.progress, 0.95, 'progress never goes back');
});

test('30 s on one stage: stuck (Retry and back are offered)', () => {
  const { clock, loading } = rig();
  loading.begin('enter', 'connect');
  clock.advance(STUCK_MS);
  assert.equal(loading.view?.stuck, true);
  assert.equal(loading.view?.failed, false);
});

test('a failure is stuck at once and stays so; Retry ends the load and starts the next', () => {
  const { clock, loading, timings } = rig();
  loading.begin('enter', 'connect');
  clock.advance(500);
  loading.fail();
  assert.equal(loading.view?.failed, true);
  assert.equal(loading.view?.stuck, true);
  loading.progress(0.5);
  assert.equal(loading.view?.stuck, true, 'a failed stage stays failed');
  loading.cancel('retry');
  loading.begin('retry', 'connect');
  clock.advance(100);
  loading.done();
  assert.deepEqual(timings.records.map((r) => r.outcome), ['shown', 'retry']);
  assert.equal(timings.records[1]!.notes['failed at'], 'connect');
});

test('nothing fires after a load ends', () => {
  const { clock, loading, views } = rig();
  loading.begin('enter', 'connect');
  loading.cancel('title');
  const n = views.length;
  clock.advance(STUCK_MS * 2);
  assert.equal(views.length, n);
  loading.stage('land');
  loading.progress(1);
  assert.equal(loading.view, null);
});

test('the ring buffer keeps the last loads, across a reload through storage', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  let t = 0;
  const a = new LoadTimings({ perf: { now: () => t }, storage });
  for (let i = 0; i < TIMINGS_KEPT + 2; i++) {
    a.start(`load${i}`);
    a.stage('connect');
    t += 10;
    a.finish('shown');
  }
  assert.equal(a.records.length, TIMINGS_KEPT);
  assert.equal(a.records[0]!.kind, `load${TIMINGS_KEPT + 1}`);
  const b = new LoadTimings({ perf: { now: () => t }, storage });
  assert.deepEqual(b.records, a.records);
  // A broken stored value reads as nothing, not a crash.
  store.set('glimway:load-timings', '{nope');
  assert.deepEqual(new LoadTimings({ perf: { now: () => 0 }, storage }).records, []);
});

test('the copied text: one line per stage, then the facts and the device', () => {
  const { clock, loading, timings } = rig();
  loading.begin('enter', 'connect');
  clock.advance(1234);
  loading.stage('fetch');
  loading.note('art density', '4');
  clock.advance(15000);
  loading.done();
  const text = formatTimings(timings.records, { device: 'iPhone, iOS 18.1, Safari, installed app', viewport: '390×844 @3x', version: '0.12.0' });
  assert.equal(
    text,
    [
      'Glimway load timings · 0.12.0',
      'device: iPhone, iOS 18.1, Safari, installed app',
      'viewport: 390×844 @3x',
      '',
      '2026-10-18 20:14:00 UTC · enter · 16,234 ms · shown',
      '  connect  1,234 ms',
      '  fetch    15,000 ms',
      '  art density: 4',
    ].join('\n')
  );
});

test('where the art came from, by transfer size', () => {
  assert.equal(artCacheSummary([]), 'no art requests seen');
  assert.match(artCacheSummary([{ name: 'a', startTime: 0 }]), /cache unknown/);
  assert.equal(
    artCacheSummary([
      { name: 'a', startTime: 0, transferSize: 0, encodedBodySize: 1000 },
      { name: 'b', startTime: 0, transferSize: 300, encodedBodySize: 2_000_000 },
      { name: 'c', startTime: 0, transferSize: 2_500_300, encodedBodySize: 2_500_000 },
    ]),
    '3 files: 1 from cache, 1 checked with the server (304), 1 downloaded; 2.5 MB over the wire'
  );
  // iPhone Safari's 304: headers over the wire and no body named (it said "27 downloaded").
  assert.equal(
    artCacheSummary([
      { name: 'a', startTime: 0, transferSize: 412, encodedBodySize: 0 },
      { name: 'b', startTime: 0, transferSize: 388, encodedBodySize: 0 },
    ]),
    '2 files: 0 from cache, 2 checked with the server (304), 0 downloaded; 0.0 MB over the wire'
  );
  // Chrome's 304 of a file smaller than its headers (it said "1 downloaded"), with and without the status.
  assert.equal(
    artCacheSummary([
      { name: 'a', startTime: 0, transferSize: 300, encodedBodySize: 180 },
      { name: 'b', startTime: 0, transferSize: 300, encodedBodySize: 180, responseStatus: 304 },
      { name: 'c', startTime: 0, transferSize: 300, encodedBodySize: 90_000, responseStatus: 304 },
    ]),
    '3 files: 0 from cache, 3 checked with the server (304), 0 downloaded; 0.0 MB over the wire'
  );
  // A small download the browser names as one stays a download.
  assert.match(artCacheSummary([{ name: 'a', startTime: 0, transferSize: 480, encodedBodySize: 180, responseStatus: 200 }]), /0 checked with the server \(304\), 1 downloaded/);
});

test('a device line from the user agent', () => {
  assert.equal(deviceLine('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', true), 'iPhone, iOS 18.1, Safari, installed app');
  assert.equal(deviceLine('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', false), 'Linux, Chrome, browser tab');
});
