import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceQuest,
  createNewGame,
  questObjective,
  recoverFromDefeat,
  validateSave,
  InvalidSaveError,
  QUEST_EVENTS,
  QUEST_STAGES,
  type GameState,
  type QuestStage,
} from '../src/lib/state.ts';

test('createNewGame returns a valid fresh demo state', () => {
  const state = createNewGame();
  assert.equal(state.version, 1);
  assert.equal(state.area, 'village');
  assert.equal(state.quest, 'new');
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

test('advanceQuest walks the full legal chain', () => {
  const chain: Array<[QuestStage, Parameters<typeof advanceQuest>[1], QuestStage]> = [
    ['new', 'accept', 'accepted'],
    ['accepted', 'find-clue', 'clue-found'],
    ['clue-found', 'defeat-guardian', 'guardian-defeated'],
    ['guardian-defeated', 'light-lantern', 'lantern-lit'],
    ['lantern-lit', 'return-village', 'complete'],
  ];
  let state = createNewGame();
  for (const [from, event, to] of chain) {
    assert.equal(state.quest, from);
    state = advanceQuest(state, event);
    assert.equal(state.quest, to);
    assert.deepEqual(validateSave(state), state);
  }
  assert.equal(state.quest, 'complete');
});

test('advanceQuest is immutable', () => {
  const before = createNewGame();
  const snapshot = structuredClone(before);
  const after = advanceQuest(before, 'accept');
  assert.deepEqual(before, snapshot);
  assert.notEqual(after, before);
  assert.notEqual(after.position, before.position);
});

test('advanceQuest records quest side effects', () => {
  const s1 = advanceQuest(createNewGame(), 'accept');
  assert.deepEqual(s1.inventory, createNewGame().inventory);

  const s2 = advanceQuest(s1, 'find-clue');
  assert.ok(s2.inventory.includes('lantern-route-rubbing'));
  assert.ok(s2.discoveries.includes('old-route-marker'));

  const s3 = advanceQuest(s2, 'defeat-guardian');
  assert.ok(s3.inventory.includes('warden-seal'));
  assert.ok(s3.defeatedEnemies.includes('stone-warden'));

  const s4 = advanceQuest(s3, 'light-lantern');
  assert.ok(s4.discoveries.includes('hilltop-lantern'));

  const s5 = advanceQuest(s4, 'return-village');
  assert.ok(s5.discoveries.includes('lantern-road-restored'));
});

test('advanceQuest rejects illegal and out-of-order transitions', () => {
  const fresh = createNewGame();
  assert.throws(() => advanceQuest(fresh, 'find-clue'), InvalidSaveError);
  assert.throws(() => advanceQuest(fresh, 'defeat-guardian'), InvalidSaveError);
  assert.throws(() => advanceQuest(fresh, 'light-lantern'), InvalidSaveError);
  assert.throws(() => advanceQuest(fresh, 'return-village'), InvalidSaveError);

  const accepted = advanceQuest(fresh, 'accept');
  assert.throws(() => advanceQuest(accepted, 'accept'), InvalidSaveError);
  assert.throws(() => advanceQuest(accepted, 'defeat-guardian'), InvalidSaveError);

  const complete = advanceQuest(
    advanceQuest(
      advanceQuest(advanceQuest(accepted, 'find-clue'), 'defeat-guardian'),
      'light-lantern',
    ),
    'return-village',
  );
  for (const event of QUEST_EVENTS) {
    assert.throws(() => advanceQuest(complete, event), InvalidSaveError);
  }

  assert.throws(
    () => advanceQuest(fresh, 'not-an-event' as never),
    InvalidSaveError,
  );
  assert.throws(
    () => advanceQuest(null as never, 'accept'),
    InvalidSaveError,
  );
});

test('questObjective returns a concrete objective for every stage', () => {
  for (const stage of QUEST_STAGES) {
    const objective = questObjective(stage);
    assert.equal(typeof objective, 'string');
    assert.ok(objective.length > 10, `objective for ${stage} too short`);
  }
  assert.throws(() => questObjective('nope' as never), InvalidSaveError);
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
    'embers',
    'flags',
    'hp',
    'inventory',
    'mana',
    'maxHp',
    'maxMana',
    'playSeconds',
    'position',
    'quest',
    'version',
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
    ['bad quest', { ...createNewGame(), quest: 'done' }, /quest/],
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
  state = advanceQuest(state, 'accept');
  state = advanceQuest(state, 'find-clue');
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
  assert.equal(recovered.quest, 'clue-found');
  assert.deepEqual(recovered.inventory, hurt.inventory);
  assert.deepEqual(recovered.discoveries, hurt.discoveries);
  assert.deepEqual(recovered.defeatedEnemies, hurt.defeatedEnemies);
  assert.equal(recovered.playSeconds, 120);
  assert.deepEqual(hurt, { ...state, area: 'ruin', position: { x: 12, y: 34 }, hp: 1, mana: 0, playSeconds: 120 });
});
