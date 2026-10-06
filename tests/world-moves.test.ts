import test from 'node:test';
import assert from 'node:assert/strict';
import { MOVE_AREAS, moveBlocks, moveRefusal } from '../src/lib/world-moves.ts';
import { worldCopy } from '../src/content/world-moves.ts';
import { parseWorld, parseWorldMove } from '../src/lib/api/parse.ts';
import { errorFromResponse } from '../src/lib/api/errors.ts';

test('a move starts only from the village or the Commons, online, with nothing pending or on the road', () => {
  assert.deepEqual(MOVE_AREAS, ['village', 'commons']);
  assert.deepEqual(moveBlocks({ area: 'commons', outgoing: 0, online: true, pending: false }), []);
  assert.deepEqual(moveBlocks({ area: 'village', outgoing: 0, online: true, pending: false }), []);
  for (const area of ['home:0', 'cottage', 'woodland', 'wilds', 'chunk:inner-1:0:0']) {
    assert.deepEqual(moveBlocks({ area, outgoing: 0, online: true, pending: false }), ['area'], area);
  }
  assert.deepEqual(moveBlocks({ area: 'home:2', outgoing: 2, online: false, pending: true }), ['offline', 'pending', 'area', 'mail']);
});

test('server refusals map to what the move screen says', () => {
  assert.equal(moveRefusal('not-at-safe-boundary'), 'area');
  assert.equal(moveRefusal('mail-in-flight'), 'mail');
  assert.equal(moveRefusal('offline'), 'offline');
  assert.equal(moveRefusal('pending'), 'pending');
  assert.equal(moveRefusal('stale-revision'), 'retry');
  assert.equal(moveRefusal('busy'), 'retry');
  assert.equal(moveRefusal('superseded'), 'retry');
  assert.equal(moveRefusal('already-in-world'), 'here');
  assert.equal(moveRefusal('world-access-denied'), 'denied');
  assert.equal(moveRefusal('world-not-found'), 'denied');
  assert.equal(moveRefusal('internal'), 'failed');
});

test('the server’s world refusals reach the move screen as themselves, not as unknown', () => {
  for (const code of ['mail-in-flight', 'not-at-safe-boundary', 'already-in-world', 'world-access-denied', 'world-not-found', 'no-party', 'not-world-owner', 'invalid-request']) {
    assert.equal(errorFromResponse(409, { error: { code } }).code, code);
  }
  assert.equal(moveRefusal(errorFromResponse(409, { error: { code: 'mail-in-flight' } }).code), 'mail');
});

test('world copy stays short, in voice, and off real-life apps', () => {
  const samples: string[] = [];
  for (const v of Object.values(worldCopy)) {
    if (typeof v === 'string') samples.push(v);
    else for (const arg of ['Bartholomew-the-Long-Named', '', 1, 2, 9999] as never[]) samples.push((v as (a: never, b: never, c: never) => string)(arg, 'Bartholomew-the-Long-Named' as never, true as never));
  }
  samples.push(worldCopy.livesIn('Olive', false), worldCopy.livesIn('Olive', true));
  for (const s of samples) assert.doesNotMatch(s, /^’|\s’s|undefined|NaN/, s);
  for (const s of samples) {
    assert.ok(s.length > 0 && s.length <= 160, `${s.length}: ${s}`);
    assert.doesNotMatch(s, /habitica|app\b|task|todo|daily|dailies|habit\b/i, s);
  }
  assert.equal(worldCopy.prompt('Olive'), 'Your party plays in Olive’s world. Join them?');
  assert.equal(worldCopy.incoming(1), '1 parcel waiting for you will go back to its sender.');
  assert.equal(worldCopy.blockMail(2), '2 parcels you sent are still on the road. Recall them at a mailbox first.');
  // Who lives there, honestly: nobody, the owner alone, someone else, or many.
  assert.equal(worldCopy.travelers(0, 'Olive', false), 'No one lives there just now.');
  assert.equal(worldCopy.travelers(1, 'Olive', true), 'Just Olive so far.');
  assert.equal(worldCopy.travelers(1, 'Olive', false), 'One traveler calls it home.');
  assert.equal(worldCopy.travelers(3, 'Olive', true), '3 travelers call it home.');
  // No name: never "’s world".
  assert.equal(worldCopy.prompt(''), 'Your party plays in a fellow traveler’s world. Join them?');
  assert.equal(worldCopy.worldOf('  '), 'A fellow traveler’s world');
  assert.equal(worldCopy.worldOf('Olive'), 'Olive’s world');
  assert.equal(worldCopy.noParty, 'When your party gathers, you can link this world to it.');
});

const view = {
  world: { id: 'w1', ownerId: 'olive', ownerName: 'Olive', members: 3, ownerHere: true, linked: true },
  isOwner: false,
  inParty: true,
  linked: true,
  linkedToMine: false,
  partyWorld: { id: 'w2', ownerId: 'pip', ownerName: 'Pip', members: 2, ownerHere: false, linked: true },
  ownWorld: null,
  prompt: true,
  leaving: { gate: 4, last: true, outgoing: 1, incoming: 2, wardenTools: 1, deedCost: 15 },
};

test('world views parse, with unknown or broken fields made safe', () => {
  assert.deepEqual(parseWorld(view), view);
  const odd = parseWorld({ ...view, world: { id: 'w1', ownerId: 'o', ownerName: 'O', members: 1, ownerHere: 'yes' }, partyWorld: undefined, prompt: 'yes', leaving: { gate: -3, last: true, outgoing: -1, incoming: 1.5, wardenTools: -2 }, extra: 1 });
  assert.equal(odd.partyWorld, null);
  assert.equal(odd.prompt, false);
  assert.equal(odd.world.ownerHere, false);
  assert.equal(odd.world.linked, false);
  assert.deepEqual(odd.leaving, { gate: -1, last: false, outgoing: 0, incoming: 0, wardenTools: 0, deedCost: 0 });
  assert.throws(() => parseWorld({ ...view, world: { id: 1 } }));
  assert.throws(() => parseWorld({ ...view, leaving: null }));
});

test('a move answer carries the snapshot and the new world', () => {
  const snapshot = {
    state: { version: 1, area: 'commons', position: { x: 1, y: 2 }, quest: 'new', hp: 10, maxHp: 10, mana: 5, maxMana: 5, embers: 3, xpEmbers: 0, emberXp: 0, inventory: [], discoveries: [], defeatedEnemies: [], flags: [], playSeconds: 0 },
    rev: 7,
    vitalsSource: 'demo',
    habiticaId: 'hal',
    displayName: 'Hal',
    habiticaPartyId: 'p1',
    worldId: 'w2',
    saveOrigin: 'fresh',
    pending: 0,
    verifiedXp: 0,
    flagged: false,
  };
  const res = parseWorldMove({ ...snapshot, result: { world: view, from: 'w1', leftHome: true, returned: 2 } });
  assert.equal(res.worldId, 'w2');
  assert.equal(res.rev, 7);
  assert.deepEqual(res.result, { world: view, from: 'w1', leftHome: true, returned: 2 });
  assert.throws(() => parseWorldMove(snapshot));
});
