import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWilds } from '../src/lib/wilds/data.ts';
import { rumourLines, rumourSentence } from '../src/lib/wilds/rumour.ts';
import { ELARA_RUMOUR, elaraRumourChoice } from '../src/content/open-map.ts';
import { normalizeRecord } from '../src/lib/api/outbox.ts';

const parts = { landmark: 'split-oak', compass: 'nw', ring: 2, pastRiver: true };

test('the rumour is built from its parts: a landmark, a compass word from the gate, the river, a distance', () => {
  assert.equal(rumourSentence(parts), "Something's tucked under a split oak, north-west of the gate, past the river. A fair walk.");
  assert.equal(rumourSentence({ ...parts, pastRiver: false, ring: 1, compass: 'e', landmark: 'meadow-outcrop' }), "Something's tucked under a stone outcrop, east of the gate. Not far.");
  assert.equal(rumourSentence({ ...parts, ring: 3, landmark: 'meadow-oak', compass: 'ne' }), "Something's tucked under a lone oak in the grass, north-east of the gate, past the river. Out near the edge of the drift.");
});

test('every rumour reads without a number, for every landmark, direction, ring and river', () => {
  const w = loadWilds().rumour;
  let n = 0;
  for (const l of w.landmarks)
    for (const c of w.compass)
      for (const ring of [0, 1, 2, 3, 4, 9])
        for (const pastRiver of [false, true]) {
          const s = rumourSentence({ landmark: l.decor, compass: c.dir, ring, pastRiver });
          assert.doesNotMatch(s, /[0-9{}]/, s);
          assert.equal(s.includes('past the river'), pastRiver, s);
          assert.ok(s.includes(l.phrase) && s.includes(c.phrase), s);
          n++;
        }
  assert.equal(n, 4 * 8 * 6 * 2);
  // Unknown parts fall back to plain words, never an id.
  assert.doesNotMatch(rumourSentence({ landmark: 'a-new-tree', compass: 'up', ring: 2, pastRiver: false }), /a-new-tree|up of/);
});

test('Elara: the rumour between her lines; her own line once you found it; nothing when there is none', () => {
  const live = elaraRumourChoice({ ...parts, opened: false, epoch: 'wick-1' });
  assert.equal(live.text, ELARA_RUMOUR.ask);
  assert.equal(live.reply.length, 3);
  assert.ok(ELARA_RUMOUR.lead.includes(live.reply[0] as never));
  assert.equal(live.reply[1], rumourSentence(parts));
  assert.equal(live.reply[2], ELARA_RUMOUR.after);
  assert.deepEqual(elaraRumourChoice({ ...parts, opened: false, epoch: 'wick-1' }), live, 'the same within a wick');
  const leads = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((e) => elaraRumourChoice({ ...parts, opened: false, epoch: `wick-${e}` }).reply[0]));
  assert.ok(leads.size > 1, 'her way in changes with the wick');
  assert.deepEqual(elaraRumourChoice({ ...parts, opened: true, epoch: 'wick-1' }).reply, [loadWilds().rumour.opened]);
  assert.deepEqual(elaraRumourChoice(null).reply, [loadWilds().rumour.none]);
  assert.deepEqual(rumourLines(null), { found: false, text: loadWilds().rumour.none });
  for (const line of [...ELARA_RUMOUR.lead, ELARA_RUMOUR.after, ELARA_RUMOUR.ask]) assert.doesNotMatch(line, /[0-9]/);
});

test('a stored outbox record keeps the open map’s four operation kinds (the replay itself: tests/wilds-ops.test.ts)', () => {
  const entry = (kind: string, path: string) => ({ id: 1, kind, path, key: 'k', body: '{"op":{"lease":"","key":"k"}}', contract: 8, createdAt: 1, sent: true, barrier: false, offline: false });
  for (const [kind, path] of [['wilds-clear', '/api/wilds/clear'], ['wilds-lay', '/api/wilds/lay'], ['wilds-lift', '/api/wilds/lift'], ['wilds-discover', '/api/wilds/discover']]) {
    const rec = normalizeRecord({ account: 'a', device: 'd', nextId: 2, entries: [entry(kind, path)], server: null, reports: null, client: '', lease: null, name: '', worldId: '', loggedOut: false, fence: 1, savedAt: 1 });
    assert.equal(rec?.entries.length, 1, kind);
    assert.equal(rec?.entries[0]?.kind, kind);
  }
});
