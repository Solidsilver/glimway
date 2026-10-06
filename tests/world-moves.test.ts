import test from 'node:test';
import assert from 'node:assert/strict';
import { MOVE_AREAS, moveBlocks, moveRefusal } from '../src/lib/world-moves.ts';
import { firstWorldCopy, worldCopy } from '../src/content/world-moves.ts';
import { parseWorld, parseWorldChoice, parseWorldMove } from '../src/lib/api/parse.ts';
import { errorFromResponse } from '../src/lib/api/errors.ts';
import { inviteCopy, signInCopy } from '../src/content/connected.ts';
import { parseInviteList } from '../src/lib/api/parse.ts';

test('a move starts only from the village or the Commons, online, with nothing pending or on the road, a day after the last', () => {
  assert.deepEqual(MOVE_AREAS, ['village', 'commons']);
  assert.deepEqual(moveBlocks({ area: 'commons', outgoing: 0, online: true, pending: false }), []);
  assert.deepEqual(moveBlocks({ area: 'village', outgoing: 0, online: true, pending: false }), []);
  for (const area of ['home:0', 'cottage', 'woodland', 'wilds', 'chunk:inner-1:0:0']) {
    assert.deepEqual(moveBlocks({ area, outgoing: 0, online: true, pending: false }), ['area'], area);
  }
  assert.deepEqual(moveBlocks({ area: 'home:2', outgoing: 2, online: false, pending: true }), ['offline', 'pending', 'area', 'mail']);
  // One move a day: blocked while seconds remain (counted on this device from
  // the server's figure), and always after the server refused for it.
  assert.deepEqual(moveBlocks({ area: 'village', outgoing: 0, online: true, pending: false, opensIn: 1 }), ['cooldown']);
  assert.deepEqual(moveBlocks({ area: 'village', outgoing: 0, online: true, pending: false, opensIn: 0 }), []);
  assert.deepEqual(moveBlocks({ area: 'village', outgoing: 0, online: true, pending: false, opensIn: 0, cooled: true }), ['cooldown']);
  assert.deepEqual(moveBlocks({ area: 'village', outgoing: 0, online: true, pending: false }), []);
});

test('server refusals map to what the move screen says', () => {
  assert.equal(moveRefusal('move-cooldown'), 'cooldown');
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
  assert.equal(moveRefusal('still-in-party'), 'denied');
  assert.equal(moveRefusal('internal'), 'failed');
});

test('the server’s world refusals reach the move screen as themselves, not as unknown', () => {
  for (const code of ['mail-in-flight', 'not-at-safe-boundary', 'already-in-world', 'world-access-denied', 'world-not-found', 'no-party', 'move-cooldown', 'invalid-request', 'still-in-party', 'party-closed', 'party-open-denied', 'party-world-invites']) {
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
  assert.equal(worldCopy.prompt(2), 'Your party has a world of its own here. Join them?');
  assert.equal(worldCopy.join(2), 'Join them…');
  assert.equal(worldCopy.join(0), 'Go first…');
  assert.equal(worldCopy.incoming(1), '1 parcel waiting for you will go back to its sender.');
  assert.equal(worldCopy.blockMail(2), '2 parcels you sent are still on the road. Recall them at a mailbox first.');
  // Who lives there, honestly: nobody, the owner alone, someone else, or many.
  assert.equal(worldCopy.travelers(0, 'Olive', false), 'No one lives there just now.');
  assert.equal(worldCopy.travelers(1, 'Olive', true), 'Just Olive so far.');
  assert.equal(worldCopy.travelers(1, 'Olive', false), 'One traveler calls it home.');
  assert.equal(worldCopy.travelers(3, 'Olive', true), '3 travelers call it home.');
  // A party's world is named for the party; a person's for them, never "’s world".
  assert.equal(worldCopy.place({ ownerName: '', party: true }), 'your party’s world');
  assert.equal(worldCopy.place({ ownerName: '', party: true }, false), 'another party’s world');
  assert.equal(worldCopy.name({ ownerName: '', party: true }), 'Your party’s world');
  assert.equal(worldCopy.name({ ownerName: '  ', party: false }), 'A fellow traveler’s world');
  assert.equal(worldCopy.name({ ownerName: 'Olive', party: false }), 'Olive’s world');
  assert.equal(worldCopy.title(worldCopy.place({ ownerName: '', party: true })), 'Move to your party’s world?');
  // When the road opens again, in round words.
  assert.equal(worldCopy.opensIn(30), 'in a minute or so');
  assert.equal(worldCopy.opensIn(20 * 60), 'in about 20 minutes');
  assert.equal(worldCopy.opensIn(70 * 60), 'in about an hour');
  assert.equal(worldCopy.opensIn(23.6 * 3600), 'in about 24 hours');
  assert.equal(worldCopy.blockCooldown('in about 5 hours'), 'Travelers rest a day between worlds. The road opens again in about 5 hours.');
  // Leaving a party: the warning, in round words, and what happens after.
  assert.equal(worldCopy.within(3 * 86400), 'in 3 days');
  assert.equal(worldCopy.within(5 * 3600), 'in about 5 hours');
  assert.equal(worldCopy.within(0), 'when you next sign in');
  assert.equal(worldCopy.leaver(worldCopy.within(3 * 86400)), 'You’ve left your party. Unless you rejoin it, you’ll be moved out of its world in 3 days.');
  assert.match(worldCopy.againNoReturn, /can’t come back without a new invitation/);
  assert.match(worldCopy.aloneThere, /only one/);
  assert.match(worldCopy.aloneThere, /until tomorrow/);
});

test('the sign-in screen tells a party member they can come straight in, in short lines', () => {
  for (const s of Object.values(signInCopy)) {
    if (typeof s === 'string') assert.ok(s.length > 0 && s.length <= 160, `${s.length}: ${s}`);
  }
  assert.match(signInCopy.partyWelcome, /party/i);
  assert.match(signInCopy.partyWelcome, /no invite code/i);
  assert.equal(signInCopy.inviteOnlyBody, 'Your Habitica hero is fine. To come in you need an invite code, or a party that already plays here.');
  assert.ok(inviteCopy.partyWorld.length <= 160 && /party/.test(inviteCopy.partyWorld));
  assert.ok(inviteCopy.partyAdmitted.length <= 160 && /party/.test(inviteCopy.partyAdmitted));
  assert.equal(parseInviteList({ invites: [], partyAdmitted: true }).partyAdmitted, true);
  assert.equal(parseInviteList({ invites: [] }).partyAdmitted, undefined);
  assert.equal(errorFromResponse(403, { error: { code: 'party-admitted-invites' } }).code, 'party-admitted-invites');
});

const view = {
  world: { id: 'w1', ownerId: 'olive', ownerName: 'Olive', members: 3, ownerHere: true, party: false },
  isOwner: false,
  inParty: true,
  partyHome: false,
  partyWorld: { id: 'w2', ownerId: '', ownerName: '', members: 2, ownerHere: false, party: true },
  partyCanOpen: false,
  ownWorld: null,
  prompt: true,
  leaving: { gate: 4, last: true, outgoing: 1, incoming: 2, wardenTools: 1, deedCost: 15 },
  moveOpensAt: 1791402314,
  moveOpensIn: 3600,
  leaver: { leftAt: 1791000000, moveOutAt: 1791259200, moveOutIn: 200000, hasOwn: true },
  movedOutAt: 0,
};

test('world views parse, with unknown or broken fields made safe', () => {
  assert.deepEqual(parseWorld(view), view);
  const odd = parseWorld({ ...view, world: { id: 'w1', ownerId: 'o', ownerName: 'O', members: 1, ownerHere: 'yes' }, partyWorld: undefined, prompt: 'yes', leaving: { gate: -3, last: true, outgoing: -1, incoming: 1.5, wardenTools: -2 }, moveOpensAt: -4, moveOpensIn: 'soon', leaver: undefined, partyCanOpen: 'yes', extra: 1 });
  assert.equal(odd.partyWorld, null);
  assert.equal(odd.prompt, false);
  assert.equal(odd.world.ownerHere, false);
  assert.equal(odd.world.party, false);
  assert.equal(odd.moveOpensAt, 0);
  assert.equal(odd.moveOpensIn, 0);
  assert.equal(odd.leaver, null);
  assert.equal(odd.partyCanOpen, false);
  assert.deepEqual(parseWorld({ ...view, leaver: { leftAt: 'x', hasOwn: 1 } }).leaver, { leftAt: 0, moveOutAt: 0, moveOutIn: 0, hasOwn: false });
  // The invite list says when you live in a party's world.
  assert.equal(parseInviteList({ invites: [], partyWorld: true }).partyWorld, true);
  assert.equal(parseInviteList({ invites: [], partyWorld: 'yes' }).partyWorld, undefined);
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

test('the first sign-in’s world question: parsed apart from a snapshot, its copy short and in voice', () => {
  const q = parseWorldChoice({ worldChoice: { habiticaId: 'rue', displayName: 'Rue', partyWorld: { id: 'w1', ownerId: '', ownerName: '', members: 3, ownerHere: false, party: true }, partyCanOpen: false } });
  assert.deepEqual(q, { habiticaId: 'rue', displayName: 'Rue', partyWorld: { id: 'w1', ownerId: '', ownerName: '', members: 3, ownerHere: false, party: true }, partyCanOpen: false, partyAdmitted: false });
  assert.equal(parseWorldChoice({ worldChoice: { habiticaId: 'rue', displayName: 'Rue', partyWorld: null, partyCanOpen: true, partyAdmitted: true } })?.partyAdmitted, true);
  assert.equal(parseWorldChoice({ worldChoice: { habiticaId: 'olive', displayName: 'Olive', partyWorld: null, partyCanOpen: true } })?.partyCanOpen, true);
  // A snapshot is not a question.
  assert.equal(parseWorldChoice({ habiticaId: 'rue', state: {} }), null);
  assert.equal(errorFromResponse(409, { error: { code: 'world-choice-required' } }).code, 'world-choice-required');
  assert.equal(errorFromResponse(409, { error: { code: 'world-chosen' } }).code, 'world-chosen');
  const samples: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') samples.push(v);
    else if (typeof v === 'function') for (const arg of ['Bartholomew-the-Extraordinarily-Long-Named-Keeper', '', 0, 1, 7, true, false] as never[]) samples.push((v as (a: never) => string)(arg));
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(firstWorldCopy);
  for (const s of samples) {
    assert.ok(s.length > 0 && s.length <= 160, `${s.length}: ${s}`);
    assert.doesNotMatch(s, /undefined|NaN|habitica|app\b|task|todo|daily|dailies|habit\b/i, s);
  }
  assert.equal(firstWorldCopy.party.who(3), '3 travelers call it home.');
  assert.equal(firstWorldCopy.party.label(false), 'Join your party’s world');
  assert.equal(firstWorldCopy.party.label(true), 'Open your party’s world');
});
