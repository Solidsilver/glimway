import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB, resetFakeIndexedDB } from './helpers/fake-indexeddb.ts';
import { loadSaveRecord, saveCurrent, saveGame, type LiveSave } from '../src/lib/save.ts';
import { createNewGame } from '../src/lib/state.ts';
import type { SaveGameOptions } from '../src/lib/habitica/types.ts';
import type { GameState } from '../src/lib/state.ts';

/**
 * A guest's Reload (versioning review, finding 3): the final browser write
 * must hold the live game, even when the game changed while it was being
 * written.
 */

installFakeIndexedDB();
test.afterEach(() => resetFakeIndexedDB());

const liveGame = (): LiveSave => ({ state: { ...createNewGame(), maxHp: 50, hp: 40 }, vitalsSource: 'demo', importedProfile: null });

/** saveGame, slowed: `during` runs while the write is out. */
const slowWrite = (during: (pass: number) => void) => {
  let pass = 0;
  return async (state: GameState, options: SaveGameOptions) => {
    const write = saveGame(state, options);
    await new Promise((r) => setTimeout(r, 10));
    during(++pass);
    await write;
  };
};

test('damage and loot that land during a delayed write are written too', async () => {
  const live = liveGame();
  const write = slowWrite((pass) => {
    if (pass !== 1) return;
    live.state = { ...live.state, hp: 35, inventory: [...live.state.inventory, 'river-glass'] };
  });
  assert.equal(await saveCurrent(() => live, write), true);
  const saved = await loadSaveRecord();
  assert.equal(saved?.state.hp, 35, 'the hit is saved: a reload is never a heal');
  assert.ok(saved?.state.inventory.includes('river-glass'), 'the loot is saved');
});

test('an in-place change during the write counts as a change', async () => {
  const live = liveGame();
  const write = slowWrite((pass) => {
    if (pass === 1) live.state.hp = 33;
  });
  assert.equal(await saveCurrent(() => live, write), true);
  assert.equal((await loadSaveRecord())?.state.hp, 33);
});

test('a game that never holds still, or a failed write, is not saved', async () => {
  const live = liveGame();
  const restless = slowWrite(() => {
    live.state = { ...live.state, hp: live.state.hp - 1 };
  });
  assert.equal(await saveCurrent(() => live, restless), false);
  assert.equal(await saveCurrent(() => liveGame(), async () => Promise.reject(new Error('quota'))), false);
});

test('the play clock alone is no change', async () => {
  const live = liveGame();
  const write = slowWrite(() => {
    live.state.playSeconds += 0.016;
  });
  assert.equal(await saveCurrent(() => live, write), true);
});
