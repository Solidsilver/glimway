import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_PET, companionName, followerKey, groupBySpecies, matchesSearch, speciesOf } from '../src/lib/companions.ts';

test('companions: Habitica keys read as names, potion first', () => {
  assert.equal(companionName('Fox-Golden'), 'Golden Fox');
  assert.equal(companionName('BearCub-CottonCandyBlue'), 'Cotton Candy Blue Bear Cub');
  assert.equal(companionName('Wolf'), 'Wolf');
  assert.equal(speciesOf('Fox-Golden'), 'Fox');
  assert.equal(speciesOf('BearCub-Base'), 'Bear Cub');
});

test('companions: owned keys group by species, in name order', () => {
  const groups = groupBySpecies(['Wolf-Shade', 'Fox-Golden', 'Fox-Base', 'Wolf-Shade']);
  assert.deepEqual(groups, [
    { species: 'Fox', keys: ['Fox-Base', 'Fox-Golden'] },
    { species: 'Wolf', keys: ['Wolf-Shade'] },
  ]);
});

test('companions: the search matches names and keys', () => {
  assert.ok(matchesSearch('Fox-Golden', 'golden fox'));
  assert.ok(matchesSearch('Fox-Golden', 'fox-g'));
  assert.ok(matchesSearch('Fox-Golden', '  '));
  assert.ok(!matchesSearch('Fox-Golden', 'wolf'));
});

test('companions: the follower is the chosen pet, else Habitica\'s current one, else none', () => {
  assert.equal(followerKey({ selectedPet: 'Wolf-Base' }, { followPet: 'Fox-Golden' }), 'Fox-Golden');
  assert.equal(followerKey({ selectedPet: 'Wolf-Base' }, { followPet: '' }), 'Wolf-Base');
  assert.equal(followerKey({ selectedPet: 'Wolf-Base' }, null), 'Wolf-Base');
  assert.equal(followerKey({ selectedPet: null }, null), null);
  assert.equal(followerKey(null, undefined), null);
});

test('companions: No pet is its own choice, never Habitica\'s current pet', () => {
  assert.equal(NO_PET, 'none');
  assert.equal(followerKey({ selectedPet: 'Wolf-Base' }, { followPet: NO_PET }), null);
  assert.equal(followerKey({ selectedPet: null }, { followPet: NO_PET }), null);
});
