import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installFakeIndexedDB,
  resetFakeIndexedDB,
  seedRawRecord,
  readRawRecord,
} from './helpers/fake-indexeddb.ts';
import {
  clearSave,
  exportSave,
  importSave,
  loadGame,
  saveGame,
  CorruptSaveError,
  MAX_IMPORT_LENGTH,
} from '../src/lib/save.ts';
import {
  advanceQuest,
  createNewGame,
  InvalidSaveError,
  type GameState,
} from '../src/lib/state.ts';

const DB_NAME = 'fingersnap';
const STORE_NAME = 'saves';
const CURRENT_KEY = 'current';

function setup() {
  installFakeIndexedDB();
  resetFakeIndexedDB();
}

test('loadGame returns null when no save exists', async () => {
  setup();
  assert.equal(await loadGame(), null);
});

test('saveGame then loadGame round-trips state', async () => {
  setup();
  const state = advanceQuest(createNewGame(), 'accept');
  await saveGame(state);
  const loaded = await loadGame();
  assert.deepEqual(loaded, state);
});

test('state survives a close and reopen (reload simulation)', async () => {
  setup();
  const state = advanceQuest(createNewGame(), 'accept');
  await saveGame(state);
  assert.deepEqual(await loadGame(), state);
  assert.deepEqual(await loadGame(), state);
});

test('saveGame rejects invalid state and writes nothing', async () => {
  setup();
  await assert.rejects(
    saveGame({ ...createNewGame(), hp: 999 } as GameState),
    InvalidSaveError,
  );
  assert.equal(await loadGame(), null);
});

test('exportSave strips credentials and wraps a portable document', async () => {
  setup();
  const state = advanceQuest(createNewGame(), 'accept');
  const dirty = {
    ...state,
    token: 'habitica-user-token-abc123',
    apiKey: 'nope',
  } as GameState;
  const json = exportSave(dirty);
  assert.ok(!json.includes('habitica-user-token-abc123'));
  assert.ok(!json.includes('nope'));
  assert.ok(!json.includes('token'));
  const doc = JSON.parse(json);
  assert.equal(doc.kind, 'fingersnap-save');
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.state, state);
});

test('importSave accepts exported documents and bare states', () => {
  const state = createNewGame();
  const fromDoc = importSave(exportSave(state));
  assert.deepEqual(fromDoc, state);
  const fromBare = importSave(JSON.stringify(state));
  assert.deepEqual(fromBare, state);
});

test('importSave round-trips through export', () => {
  const state = advanceQuest(createNewGame(), 'accept');
  assert.deepEqual(importSave(exportSave(state)), state);
});

test('importSave rejects oversized, malformed, and invalid payloads', () => {
  assert.throws(() => importSave('x'.repeat(MAX_IMPORT_LENGTH + 1)), InvalidSaveError);
  assert.throws(() => importSave('{not json'), InvalidSaveError);
  assert.throws(() => importSave('42'), InvalidSaveError);
  assert.throws(() => importSave(JSON.stringify({ version: 9, state: createNewGame() })), InvalidSaveError);
  assert.throws(
    () => importSave(JSON.stringify({ kind: 'fingersnap-save', version: 1, state: { version: 1 } })),
    InvalidSaveError,
  );
  assert.throws(() => importSave(null as never), InvalidSaveError);
});

test('importSave strips foreign fields from imported state', () => {
  const smuggled = JSON.stringify({
    kind: 'fingersnap-save',
    version: 1,
    state: { ...createNewGame(), token: 'leaked-credential' },
  });
  const state = importSave(smuggled);
  assert.ok(!JSON.stringify(state).includes('leaked-credential'));
  assert.ok(!('token' in state));
});

test('corrupt stored save surfaces an error and is never silently overwritten', async () => {
  setup();
  seedRawRecord(DB_NAME, STORE_NAME, {
    id: CURRENT_KEY,
    savedAt: 1,
    state: { version: 1, area: 'castle', quest: 'new' },
  });

  await assert.rejects(
    loadGame(),
    (err: unknown) => {
      assert.ok(err instanceof CorruptSaveError);
      assert.match(err.message, /corrupt/i);
      return true;
    },
  );

  const good = createNewGame();
  await assert.rejects(saveGame(good), CorruptSaveError);
  const stillThere = readRawRecord(DB_NAME, STORE_NAME, CURRENT_KEY) as {
    state: { area: string };
  };
  assert.equal(stillThere.state.area, 'castle');

  await assert.rejects(loadGame(), CorruptSaveError);

  await saveGame(good, { overwriteCorrupt: true });
  assert.deepEqual(await loadGame(), good);
});

test('clearSave removes the stored save explicitly', async () => {
  setup();
  await saveGame(createNewGame());
  await clearSave();
  assert.equal(await loadGame(), null);
});

test('queued writes: later save wins over an earlier slow one', async () => {
  setup();
  const older: GameState = { ...createNewGame(), playSeconds: 10 };
  const newer: GameState = { ...createNewGame(), playSeconds: 20 };
  const first = saveGame(older);
  const second = saveGame(newer);
  await Promise.all([first, second]);
  const loaded = await loadGame();
  assert.equal(loaded?.playSeconds, 20);
});

test('queued writes: load issued after save observes the saved data', async () => {
  setup();
  const state = advanceQuest(createNewGame(), 'accept');
  const saving = saveGame(state);
  const loading = loadGame();
  await saving;
  assert.deepEqual(await loading, state);
});

test('concurrent saves of the same state do not corrupt the record', async () => {
  setup();
  const state = createNewGame();
  await Promise.all([saveGame(state), saveGame(state), saveGame(state)]);
  assert.deepEqual(await loadGame(), state);
});
