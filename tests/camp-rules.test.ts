import test from 'node:test';
import assert from 'node:assert/strict';
import { create } from '@bufbuild/protobuf';
import { CampMemberSchema, CampViewSchema } from '../src/lib/gen/glimway/v1/camps_pb.js';
import { CAMP_RULES, CAMP_RULE_WORDS, crateLines, campNameable, campRefusal, campRule, campRuleLines, moveOffLines, movedOffLine, ownerName, personName, ruleNames, withMember, withoutMember } from '../src/lib/camps.ts';
import { HOME_ERRORS, ITEM_ERRORS } from '../src/content/errors.ts';

const person = (accountId: string, name: string) => create(CampMemberSchema, { accountId, name });
const bob = person('bob', 'Bob');
const dave = person('dave', 'Dave');
const carol = person('carol', 'Carol');
const camp = (rule: string, members = [bob]) => create(CampViewSchema, { id: 'lamp', setterId: 'alice', setterName: 'Alice', rule, members });

test('four rules, household when unset or unknown; only listed and except read the list', () => {
  assert.deepEqual(CAMP_RULES, ['household', 'listed', 'except', 'everyone']);
  assert.equal(campRule(camp('')), 'household');
  assert.equal(campRule(camp('friends')), 'household');
  assert.equal(campRule(camp('except')), 'except');
  assert.deepEqual(CAMP_RULES.filter(ruleNames), ['listed', 'except']);
  for (const r of CAMP_RULES) assert.ok(CAMP_RULE_WORDS.rules[r].pick && CAMP_RULE_WORDS.rules[r].line);
});

test('the panel says the rule, who is named when it counts, and that walking and oil stay open', () => {
  const [line] = campRuleLines(camp('listed', [bob, dave]));
  assert.match(line!, /people you name build here/);
  assert.match(line!, /Named: Bob and Dave\./);
  assert.match(line!, /walk here and add oil/);
  assert.match(campRuleLines(camp('except', []))[0]!, /No one named yet/);
  assert.doesNotMatch(campRuleLines(camp('everyone', [bob]))[0]!, /Bob/, 'a list the rule ignores is not shown');
});

test('naming: the world’s members not listed yet and never the keeper; adding twice keeps one', () => {
  const people = [person('alice', 'Alice'), bob, carol, dave];
  assert.deepEqual(campNameable(camp('listed', [bob]), people).map((p) => p.accountId), ['carol', 'dave']);
  assert.deepEqual(withMember(camp('listed', [bob]), 'dave'), ['bob', 'dave']);
  assert.deepEqual(withMember(camp('listed', [bob]), 'bob'), ['bob']);
  assert.deepEqual(withoutMember(camp('listed', [bob, dave]), 'bob'), ['dave']);
  assert.equal(personName(people, 'carol'), 'Carol');
  assert.equal(personName(people, 'zed'), 'someone');
});

test('the refusal says whose camp it is and that you can still walk and tend', () => {
  const said = campRefusal(camp('household'));
  assert.match(said, /Alice’s camp/);
  assert.match(said, /walk through and tend the lamp/);
  assert.match(campRefusal(null), /walk through and tend the lamp/);
  assert.ok(HOME_ERRORS['not-your-camp'] && HOME_ERRORS['not-in-world'] && ITEM_ERRORS['not-your-camp'], 'camps, and felling or breaking there');
});

test('moving someone’s piece off: it waits at Pell’s, still theirs', () => {
  assert.match(moveOffLines('Bob', 'Wooden stool')[0]!, /Bob’s wooden stool.*Pell keeps it in a crate for Bob/);
  assert.equal(movedOffLine('Bob', 'Wooden stool'), 'Bob’s wooden stool is waiting at Pell’s for Bob.');
});

test('Pell: what a lapse packed says the woods turned; what a keeper moved off says whose camp', () => {
  const lines = crateLines([
    { itemDef: 'wooden-stool', qty: 1, movedBy: 'Alice' },
    { itemDef: 'way-lamp', qty: 1, movedBy: '' },
    { itemDef: 'raised-bed', qty: 1, movedBy: 'Alice' }
  ]);
  assert.equal(lines[0], 'The woods turned. I have your things.');
  assert.match(lines[1]!, /In the crate: a way-lamp\./);
  assert.match(lines[2]!, /^Moved off Alice’s camp: a wooden stool and a raised bed\. I kept it safe for you\.$/i);
  assert.deepEqual(crateLines([{ itemDef: 'wooden-stool', qty: 1, movedBy: 'Bo' }]).length, 1, 'no lapse line without a lapse');
});

test('Pell: old paths refunded say the land changed; a lost deed says so; lapses and keepers unchanged', () => {
  const lines = crateLines([
    { itemDef: 'stone', qty: 3, reason: 'land-changed' },
    { itemDef: 'wooden-stool', qty: 1, reason: 'deed-lost' },
    { itemDef: 'way-lamp', qty: 1 }
  ]);
  assert.equal(lines[0], 'The woods turned. I have your things.');
  assert.match(lines[2]!, /^The land changed/);
  assert.match(lines[3]!, /In the crate: 3 stones\./i);
  assert.match(lines[4]!, /deeds book/);
  assert.match(lines[5]!, /In the crate: a wooden stool\./);
  assert.equal(lines.length, 6);
});

test('Pell: a keeper’s own pack-up says they packed it; others’ things still name the keeper', () => {
  const lines = crateLines([
    { itemDef: 'way-lamp', qty: 1, reason: 'packed-up' },
    { itemDef: 'wooden-stool', qty: 1, reason: 'packed-up', movedBy: 'Alice' }
  ]);
  assert.match(lines[0]!, /^You packed up your camp/);
  assert.match(lines[1]!, /In the crate: a way-lamp\./);
  assert.match(lines[2]!, /^Moved off Alice’s camp: a wooden stool/);
  assert.equal(lines.length, 3);
});

test('a camp piece or plant is named by the camp read for every viewer, the world list as a fallback', () => {
  assert.equal(ownerName([], { ownerId: 'bob', ownerName: 'Bob' }), 'Bob');
  assert.equal(ownerName([bob], { ownerId: 'bob', ownerName: '' }), 'Bob');
  assert.equal(ownerName([], { ownerId: 'bob' }), 'someone');
});
