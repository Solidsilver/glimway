import test from 'node:test';
import assert from 'node:assert/strict';
import { baySig, nextHomecoming, stableNext, stallsShown } from '../src/lib/companions.ts';
import type { StallView } from '../src/lib/api/homestead.ts';

// The owner's playtest: a mount that's out leaves its bay empty, and it's
// back once it's home (crafts.md 3.1).
const stalls: StallView[] = [
  { stall: 1, mount: 'Wolf-Shade', ownerId: 'me', ownerName: 'Me', out: false },
  { stall: 2, mount: 'Lion-Golden', ownerId: 'ivy', ownerName: 'Ivy', out: true },
  { stall: 3, mount: '', ownerId: '', ownerName: '', out: false },
];
const none = new Map<string, number>();

test('stalls shown: your mount is out while your companions say so, whatever the homestead last said', () => {
  const out = stallsShown(stalls, 'h1', 'me', { mountOut: 'Wolf-Shade', mountHome: 'h1' }, none, 0);
  assert.equal(out[0].out, true, 'ridden or led: the bay is empty');
  assert.equal(out[1], stalls[1], 'a partner’s stays as the server said');
  assert.equal(out[2], stalls[2]);
  // Sent home (and off the screen): back in its bay, even when the read said out.
  const stale = stalls.map((s) => (s.stall === 1 ? { ...s, out: true } : s));
  assert.equal(stallsShown(stale, 'h1', 'me', { mountOut: '', mountHome: '' }, none, 0)[0].out, false);
  // Out from another homestead (a joint deed left, a world moved) isn't this bay's.
  assert.equal(stallsShown(stalls, 'h1', 'me', { mountOut: 'Wolf-Shade', mountHome: 'h2' }, none, 0)[0].out, false);
  // Nobody signed in: the server's word only.
  assert.deepEqual(stallsShown(stalls, 'h1', null, null, none, 0), stalls);
  // Signed in, companions not read yet: your bay keeps the server's word too (review round 1).
  const outByServer = stalls.map((s) => (s.stall === 1 ? { ...s, out: true } : s));
  assert.equal(stallsShown(outByServer, 'h1', 'me', null, none, 0)[0].out, true);
  assert.equal(stallsShown(stalls, 'h1', 'me', null, none, 0)[0].out, false);
});

test('stalls shown: a mount walking home keeps its bay empty until it is off the screen', () => {
  const homeward = new Map([['Wolf-Shade', 5_000]]);
  const home = { mountOut: '', mountHome: '' };
  assert.equal(stallsShown(stalls, 'h1', 'me', home, homeward, 4_000)[0].out, true, 'still walking');
  assert.equal(stallsShown(stalls, 'h1', 'me', home, homeward, 5_000)[0].out, false, 'home');
  assert.equal(nextHomecoming(stalls, 'me', homeward, 4_000), 5_000, 'the redraw that puts it back');
  assert.equal(nextHomecoming(stalls, 'me', homeward, 5_000), null);
  // A partner's mount of the same kind isn't yours walking home.
  assert.equal(nextHomecoming(stalls, 'ivy', new Map([['Wolf-Shade', 5_000]]), 0), null);
});

test('stalls shown: Go home on your own land fills the bay once the mount is off the screen (review round 1)', () => {
  // On the lead: the bay is drawn empty.
  const leading = { mountOut: 'Wolf-Shade', mountHome: 'h1' };
  const drawn = baySig(stallsShown(stalls, 'h1', 'me', leading, none, 0));
  assert.equal(drawn, ',,');
  // H: it walks off (homeward until 5 s) and the prediction says it's home.
  // Nothing visible changes yet, so no redraw, but a recheck for when it's off the screen.
  const homeward = new Map([['Wolf-Shade', 5_000]]);
  const home = { mountOut: '', mountHome: '' };
  assert.deepEqual(stableNext(stalls, stallsShown(stalls, 'h1', 'me', home, homeward, 1_000), drawn, 'me', homeward, 1_000), { redraw: false, recheckAt: 5_000 });
  // The recheck: the bay fills.
  assert.deepEqual(stableNext(stalls, stallsShown(stalls, 'h1', 'me', home, homeward, 5_020), drawn, 'me', homeward, 5_020), { redraw: true, recheckAt: null });
  // Nothing walking home and nothing changed: nothing to do.
  assert.deepEqual(stableNext(stalls, stallsShown(stalls, 'h1', 'me', leading, none, 0), drawn, 'me', none, 0), { redraw: false, recheckAt: null });
});
