import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNewGame,
  recoverFromDefeat,
  validateSave,
  InvalidSaveError,
  type GameState,
} from '../src/lib/state.ts';
import { road } from './helpers/quests.ts';

test('createNewGame returns a valid fresh demo state', () => {
  const state = createNewGame();
  assert.equal(state.version, 1);
  assert.equal(state.area, 'village');
  assert.deepEqual(state.quests, {});
  assert.equal(state.hp, state.maxHp);
  assert.equal(state.mana, state.maxMana);
  assert.ok(state.maxHp > 0);
  assert.ok(Number.isFinite(state.position.x) && Number.isFinite(state.position.y));
  assert.ok(state.inventory.length > 0);
  assert.deepEqual(state.discoveries, []);
  assert.deepEqual(state.defeatedEnemies, []);
  assert.equal(state.playSeconds, 0);
  assert.deepEqual(validateSave(state), state);
});

test('createNewGame is fresh per call (no shared mutable arrays)', () => {
  const a = createNewGame();
  const b = createNewGame();
  a.inventory.push('mutated');
  assert.notDeepEqual(a.inventory, b.inventory);
});

test('validateSave accepts a well-formed state and strips foreign fields', () => {
  const dirty = {
    ...createNewGame(),
    token: 'habitica-api-token-should-never-survive',
    apiKey: 'x',
    nested: { secret: true },
  };
  const clean = validateSave(dirty);
  assert.deepEqual(Object.keys(clean).sort(), [
    'area',
    'defeatedEnemies',
    'discoveries',
    'emberXp',
    'embers',
    'flags',
    'hp',
    'inventory',
    'mana',
    'maxHp',
    'maxMana',
    'playSeconds',
    'position',
    'quests',
    'version',
    'xpEmbers',
  ]);
  assert.ok(!JSON.stringify(clean).includes('habitica-api-token'));
});

test('saves from before Embers load with an empty balance and no flags', () => {
  const { embers: _e, flags: _f, ...legacy } = createNewGame();
  const loaded = validateSave(legacy);
  assert.equal(loaded.embers, 0);
  assert.deepEqual(loaded.flags, []);
  assert.throws(() => validateSave({ ...createNewGame(), embers: -1 }), /embers/);
  assert.throws(() => validateSave({ ...createNewGame(), flags: [3] }), /flags/);
});

test('validateSave rejects malformed data with descriptive errors', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['null', null, /must be an object/],
    ['array', [], /must be an object/],
    ['string', 'save', /must be an object/],
    ['bad version', { ...createNewGame(), version: 2 }, /unsupported save version/],
    ['missing version', { ...createNewGame(), version: undefined }, /unsupported save version/],
    ['bad area', { ...createNewGame(), area: 'castle' }, /area/],
    ['missing position', { ...createNewGame(), position: 7 }, /position/],
    ['nan x', { ...createNewGame(), position: { x: NaN, y: 1 } }, /position\.x/],
    ['string y', { ...createNewGame(), position: { x: 1, y: '2' } }, /position\.y/],
    ['bad legacy quest', { ...createNewGame(), quests: undefined, quest: 'done' }, /quest/],
    ['quests not an object', { ...createNewGame(), quests: 'lantern-road' }, /quests/],
    ['bad quest step', { ...createNewGame(), quests: { 'lantern-road': 'Not A Step' } }, /quests\.lantern-road/],
    ['hp above max', { ...createNewGame(), hp: 99 }, /hp/],
    ['negative hp', { ...createNewGame(), hp: -1 }, /hp/],
    ['maxHp zero', { ...createNewGame(), maxHp: 0 }, /maxHp/],
    ['mana above max', { ...createNewGame(), mana: 5, maxMana: 2 }, /mana/],
    ['negative playSeconds', { ...createNewGame(), playSeconds: -3 }, /playSeconds/],
    ['inventory not array', { ...createNewGame(), inventory: 'sword' }, /inventory/],
    ['inventory number item', { ...createNewGame(), inventory: [4] }, /inventory\[0\]/],
    ['discoveries bad item', { ...createNewGame(), discoveries: [''] }, /discoveries\[0\]/],
    ['defeatedEnemies bad', { ...createNewGame(), defeatedEnemies: [{}] }, /defeatedEnemies\[0\]/],
  ];
  for (const [label, data, pattern] of cases) {
    assert.throws(
      () => validateSave(data),
      (err: unknown) => {
        assert.ok(err instanceof InvalidSaveError, `${label}: wrong error type`);
        assert.match(err.message, pattern, `${label}: message was ${err.message}`);
        return true;
      },
      `expected ${label} to be rejected`,
    );
  }
});

test('validateSave rejects missing required fields', () => {
  const partial = { version: 1, area: 'village' };
  assert.throws(() => validateSave(partial), InvalidSaveError);
});

test('recoverFromDefeat: demo rule returns to village with full resources and keeps story', () => {
  let state = createNewGame();
  state = road(state, 'accept', 'find-clue');
  const hurt: GameState = {
    ...state,
    area: 'ruin',
    position: { x: 12, y: 34 },
    hp: 1,
    mana: 0,
    playSeconds: 120,
  };
  const recovered = recoverFromDefeat(hurt);
  assert.equal(recovered.area, 'village');
  assert.equal(recovered.hp, recovered.maxHp);
  assert.equal(recovered.mana, recovered.maxMana);
  assert.equal(recovered.quests['lantern-road'], 'clue-found');
  assert.deepEqual(recovered.inventory, hurt.inventory);
  assert.deepEqual(recovered.discoveries, hurt.discoveries);
  assert.deepEqual(recovered.defeatedEnemies, hurt.defeatedEnemies);
  assert.equal(recovered.playSeconds, 120);
  assert.deepEqual(hurt, { ...state, area: 'ruin', position: { x: 12, y: 34 }, hp: 1, mana: 0, playSeconds: 120 });
});

test('a save from before the quest tree loads its lantern road, with the opening counted done', () => {
  const { quests: _q, ...base } = createNewGame();
  assert.deepEqual(validateSave({ ...base, quest: 'new' }).quests, {});
  assert.deepEqual(validateSave({ ...base, quest: 'clue-found' }).quests, { 'lantern-road': 'clue-found', signpost: 'light-first-lamp' });
});
