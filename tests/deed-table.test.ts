import test from 'node:test';
import assert from 'node:assert/strict';
import { deedOffers, deedPlaceName, deedTable, peersAtTable, shareCandidates, standsAtTable } from '../src/game/deed-table.ts';
import { bus, EV } from '../src/game/events.ts';
import { openDeedPanel, openYard } from '../src/game/yard-open.ts';
import type { DeedInvite } from '../src/lib/api/types.ts';

/** The deed table (silas-yard.md 2.6): who is at it, who could share, which signatures wait on you. */

const t = { area: 'commons', x: 100, y: 100, radius: 40 };
const inv = (to: string, from: string, homeId: string, fromAt: number | null, toAt: number | null, expiresAt = 13_600): DeedInvite => ({ homeId, gate: 4, from: { id: from, name: from }, to: { id: to, name: to }, expiresAt, fromConfirmedAt: fromAt, toConfirmedAt: toAt });

test('the table is one place: an area, a spot and a radius', () => {
  const real = deedTable();
  assert.ok(real.area && real.radius > 0);
  assert.equal(standsAtTable(real.area, { x: real.x, y: real.y }), true);
  assert.equal(standsAtTable('commons', { x: 130, y: 100 }, t), true);
  assert.equal(standsAtTable('commons', { x: 141, y: 100 }, t), false);
  assert.equal(standsAtTable('village', { x: 100, y: 100 }, t), false);
});

test('at the table: peers in reach who haven’t left, by account id', () => {
  const peer = (accountId: string, displayName: string, x: number, leftAt: number | null = null) => ({ accountId, displayName, leftAt, track: { at: () => ({ x, y: 100 }) } }) as never;
  const here = peersAtTable([peer('ivy', 'Ivy', 110), peer('far', 'Far', 200), peer('gone', 'Gone', 100, 5), peer('anon', '', 90)], 0, t);
  assert.deepEqual(here, [{ id: 'ivy', name: 'Ivy' }, { id: 'anon', name: 'A neighbour' }]);
  // Sharing leaves out whoever is on the deed already.
  assert.deepEqual(shareCandidates(here, [{ id: 'anon' }]), [{ id: 'ivy', name: 'Ivy' }]);
});

test('a place’s name: one name, two, or the lot', () => {
  const m = (displayName: string) => ({ id: displayName, displayName });
  assert.equal(deedPlaceName({ members: [m('Tansy')] }, 2), 'Tansy’s Place');
  assert.equal(deedPlaceName({ members: [m('Tansy'), m('Bram')] }, 2), 'Tansy & Bram’s Place');
  assert.equal(deedPlaceName(null, 2), 'Lot 3');
});

test('offers: yours waiting on them, theirs signed while yours lapsed, and deeds offered to you', () => {
  const now = 10_000;
  const o = deedOffers(
    [
      inv('ivy', 'me', 'h1', now - 10, null), // just offered: waiting on Ivy
      inv('rowan', 'me', 'h1', now - 500, now - 5), // Rowan signed; mine lapsed
      inv('ash', 'me', 'h1', now - 500, null), // both lapsed: offer again
      inv('me', 'oak', 'h9', null, null), // Oak's deed, offered to me
      inv('pip', 'me', 'h1', now - 10, null, now - 1), // expired
      inv('zed', 'other', 'h7', now - 10, null) // not mine at all
    ],
    'me',
    'h1',
    now,
    60
  );
  assert.deepEqual([...o.offered.keys()], ['ivy']);
  assert.deepEqual(o.signBack.map((i) => i.to.id), ['rowan']);
  assert.deepEqual(o.toMe.map((i) => i.from.id), ['oak']);
  assert.deepEqual([...o.theirs.keys()], []);
});

test('offers: a co-owner’s invites are theirs, never yours to sign or to offer over', () => {
  const now = 10_000;
  // Tansy and I share h1. She offered Ivy (hers lapsed, Ivy signed) and Wren (just now); an old offer to Moss lapsed both ways.
  const o = deedOffers([inv('ivy', 'tansy', 'h1', now - 500, now - 5), inv('wren', 'tansy', 'h1', now - 10, null), inv('moss', 'tansy', 'h1', now - 900, now - 800)], 'me', 'h1', now, 60);
  assert.deepEqual(o.signBack, []);
  assert.deepEqual([...o.offered.keys()], []);
  assert.deepEqual([...o.theirs.keys()], ['ivy', 'wren']);
  assert.equal(o.theirs.get('ivy')?.from.id, 'tansy');
  // Without a home of your own, the lane's invites on it are nobody's offers.
  const none = deedOffers([inv('ivy', 'me', 'h1', now - 10, null)], 'me', null, now, 60);
  assert.equal(none.offered.size + none.signBack.length + none.theirs.size, 0);
});

test('the entry points: the Yard panel on a tab or its default, and the deed panel', () => {
  const shop: unknown[] = [];
  let deed = 0;
  const onShop = (p: unknown) => shop.push(p);
  const onDeed = () => (deed += 1);
  bus.on(EV.homeShop, onShop);
  bus.on(EV.homeDeed, onDeed);
  openYard('mend');
  openYard();
  openDeedPanel();
  bus.off(EV.homeShop, onShop);
  bus.off(EV.homeDeed, onDeed);
  assert.deepEqual(shop, [{ tab: 'mend' }, {}]);
  assert.equal(deed, 1);
});
