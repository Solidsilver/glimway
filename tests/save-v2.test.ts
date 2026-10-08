import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installFakeIndexedDB,
  resetFakeIndexedDB,
  seedRawRecord,
  readRawRecord,
} from './helpers/fake-indexeddb.ts';
import {
  CorruptSaveError,
  SAVE_FORMAT,
  clearSave,
  exportSave,
  importSave,
  importSaveDocument,
  loadGame,
  loadSaveRecord,
  saveGame,
} from '../src/lib/save.ts';
import { createNewGame, type GameState } from '../src/lib/state.ts';
import { road } from './helpers/quests.ts';
import { toHabiticaProfile } from '../src/lib/habitica/mapping.ts';
import { FIXTURES_BY_KEY, gearLookupFor } from '../src/lib/habitica/fixtures.ts';
import type { HabiticaProfile } from '../src/lib/habitica/types.ts';

const DB_NAME = 'fingersnap';
const STORE_NAME = 'saves';
const CURRENT_KEY = 'current';

function setup() {
  installFakeIndexedDB();
  resetFakeIndexedDB();
}

function profileFrom(key: keyof typeof FIXTURES_BY_KEY): HabiticaProfile {
  const fixture = FIXTURES_BY_KEY[key];
  return toHabiticaProfile(fixture.user, gearLookupFor(fixture.gearStats));
}

test('save format 2 record round-trips state plus provenance', async () => {
  setup();
  const state = road(createNewGame(), 'accept');
  await saveGame(state);
  const loaded = await loadSaveRecord();
  assert.ok(loaded);
  assert.deepEqual(loaded.state, state);
  assert.equal(loaded.vitalsSource, 'demo');
  assert.equal(loaded.importedProfile, undefined);
});

test('a format-1 (v1) record loads and migrates to demo provenance', async () => {
  setup();
  const state = createNewGame();
  seedRawRecord(DB_NAME, STORE_NAME, { id: CURRENT_KEY, savedAt: 123, state });
  const loaded = await loadSaveRecord();
  assert.ok(loaded);
  assert.deepEqual(loaded.state, state);
  assert.equal(loaded.vitalsSource, 'demo');
  assert.equal(loaded.importedProfile, undefined);
  // loadGame keeps its v1 contract
  assert.deepEqual(await loadGame(), state);
});

test('imported profile and provenance persist across save/load', async () => {
  setup();
  const state = createNewGame();
  const profile = profileFrom('lowLevel');
  await saveGame(state, { vitalsSource: 'imported', importedProfile: profile });
  const loaded = await loadSaveRecord();
  assert.ok(loaded);
  assert.equal(loaded.vitalsSource, 'imported');
  assert.deepEqual(loaded.importedProfile, profile);
  assert.deepEqual(await loadGame(), state);
});

test('gameplay saves preserve stored provenance (no silent downgrade)', async () => {
  setup();
  const profile = profileFrom('highLevel');
  await saveGame(createNewGame(), { vitalsSource: 'imported', importedProfile: profile });
  const later: GameState = { ...createNewGame(), playSeconds: 60 };
  await saveGame(later); // ordinary save, no options
  const loaded = await loadSaveRecord();
  assert.ok(loaded);
  assert.equal(loaded.vitalsSource, 'imported');
  assert.deepEqual(loaded.importedProfile, profile);
  assert.equal(loaded.state.playSeconds, 60);
});

test('explicit options override stored provenance', async () => {
  setup();
  const profile = profileFrom('lowLevel');
  await saveGame(createNewGame(), { vitalsSource: 'imported', importedProfile: profile });
  await saveGame(createNewGame(), { vitalsSource: 'demo' });
  const loaded = await loadSaveRecord();
  assert.ok(loaded);
  assert.equal(loaded.vitalsSource, 'demo');
});

test('importedProfile: null explicitly clears the baseline (demo rollback)', async () => {
  setup();
  const profile = profileFrom('lowLevel');
  await saveGame(createNewGame(), {
    vitalsSource: 'imported',
    importedProfile: profile,
  });
  // Rollback to demo: null must clear the stale baseline.
  await saveGame(createNewGame(), { vitalsSource: 'demo', importedProfile: null });
  const cleared = await loadSaveRecord();
  assert.ok(cleared);
  assert.equal(cleared.vitalsSource, 'demo');
  assert.equal(cleared.importedProfile, undefined);

  // A bare null clear also works while keeping provenance as stored.
  await saveGame(createNewGame(), { vitalsSource: 'imported', importedProfile: profile });
  await saveGame(createNewGame(), { importedProfile: null });
  const keptProvenance = await loadSaveRecord();
  assert.ok(keptProvenance);
  assert.equal(keptProvenance.vitalsSource, 'imported');
  assert.equal(keptProvenance.importedProfile, undefined);
});

test('reset to demo clears the baseline even without an explicit null', async () => {
  setup();
  await saveGame(createNewGame(), {
    vitalsSource: 'imported',
    importedProfile: profileFrom('lowLevel'),
  });
  await saveGame(createNewGame(), { vitalsSource: 'demo' });
  const loaded = await loadSaveRecord();
  assert.ok(loaded);
  assert.equal(loaded.vitalsSource, 'demo');
  assert.equal(loaded.importedProfile, undefined);
});

test('undefined importedProfile still preserves the baseline', async () => {
  setup();
  const profile = profileFrom('lowLevel');
  await saveGame(createNewGame(), { vitalsSource: 'imported', importedProfile: profile });
  await saveGame(createNewGame(), { vitalsSource: 'imported' });
  const loaded = await loadSaveRecord();
  assert.ok(loaded);
  assert.deepEqual(loaded.importedProfile, profile);
});

test('credentials and foreign fields never reach the stored record', async () => {
  setup();
  const profile = profileFrom('lowLevel');
  const smuggled = {
    ...profile,
    apiToken: 'habitica-token-should-never-be-stored',
    credentials: { apiToken: 'x' },
  } as unknown as HabiticaProfile;
  const state = { ...createNewGame(), token: 'state-token-leak' } as GameState;
  await saveGame(state, { vitalsSource: 'imported', importedProfile: smuggled });
  const raw = readRawRecord(DB_NAME, STORE_NAME, CURRENT_KEY);
  const json = JSON.stringify(raw);
  assert.ok(!json.includes('habitica-token-should-never-be-stored'));
  assert.ok(!json.includes('state-token-leak'));
  assert.ok(!json.includes('credentials'));
});

test('exportSave/importSaveDocument round-trip carries provenance and profile', () => {
  const state = road(createNewGame(), 'accept');
  const profile = profileFrom('variedEquipment');
  const json = exportSave(state, { vitalsSource: 'imported', importedProfile: profile });
  assert.ok(!json.includes('token'));
  const doc = JSON.parse(json);
  assert.equal(doc.kind, 'fingersnap-save');
  assert.equal(doc.version, 1);
  assert.equal(doc.saveFormat, SAVE_FORMAT);
  assert.equal(doc.vitalsSource, 'imported');
  assert.deepEqual(doc.state, state);

  const imported = importSaveDocument(json);
  assert.deepEqual(imported.state, state);
  assert.equal(imported.vitalsSource, 'imported');
  assert.deepEqual(imported.importedProfile, profile);
});

test('export without extras exports demo provenance; importSave returns state only', () => {
  const state = createNewGame();
  const json = exportSave(state);
  const imported = importSaveDocument(json);
  assert.equal(imported.vitalsSource, 'demo');
  assert.equal(imported.importedProfile, undefined);
  assert.deepEqual(importSave(json), state);
});

test('exported documents strip credential-shaped fields from profiles', () => {
  const profile = profileFrom('lowLevel');
  const dirty = { ...profile, apiToken: 'export-leak' } as unknown as HabiticaProfile;
  const json = exportSave(createNewGame(), { vitalsSource: 'imported', importedProfile: dirty });
  assert.ok(!json.includes('export-leak'));
  const imported = importSaveDocument(json);
  assert.equal(imported.importedProfile?.id, profile.id);
});

test('importSaveDocument accepts format-1 documents and bare states', () => {
  const state = createNewGame();
  const v1Doc = JSON.stringify({
    kind: 'fingersnap-save',
    version: 1,
    exportedAt: new Date().toISOString(),
    state,
  });
  const fromV1 = importSaveDocument(v1Doc);
  assert.deepEqual(fromV1.state, state);
  assert.equal(fromV1.vitalsSource, 'demo');

  const bare = importSaveDocument(JSON.stringify(state));
  assert.deepEqual(bare.state, state);
  assert.equal(bare.vitalsSource, 'demo');
});

test('importSaveDocument rejects unknown save formats and bad provenance', () => {
  const state = createNewGame();
  assert.throws(
    () =>
      importSaveDocument(
        JSON.stringify({ kind: 'fingersnap-save', version: 1, saveFormat: 3, state }),
      ),
    /save format/,
  );
  assert.throws(
    () =>
      importSaveDocument(
        JSON.stringify({ kind: 'fingersnap-save', version: 1, saveFormat: 2, state, vitalsSource: 'cloud' }),
      ),
    /vitalsSource/,
  );
  assert.throws(
    () =>
      importSaveDocument(
        JSON.stringify({
          kind: 'fingersnap-save',
          version: 1,
          saveFormat: 2,
          state,
          vitalsSource: 'imported',
          importedProfile: { id: '', name: '' },
        }),
      ),
    /id/,
  );
});

test('corrupt provenance or profile in storage is a CorruptSaveError and is preserved', async () => {
  setup();
  seedRawRecord(DB_NAME, STORE_NAME, {
    id: CURRENT_KEY,
    savedAt: 1,
    saveFormat: 2,
    state: createNewGame(),
    vitalsSource: 'cloud',
  });
  await assert.rejects(loadSaveRecord(), CorruptSaveError);
  await assert.rejects(loadGame(), CorruptSaveError);

  await assert.rejects(saveGame(createNewGame()), CorruptSaveError);
  const raw = readRawRecord(DB_NAME, STORE_NAME, CURRENT_KEY) as { vitalsSource: string };
  assert.equal(raw.vitalsSource, 'cloud', 'refused overwrite must leave the record intact');

  await saveGame(createNewGame(), { overwriteCorrupt: true });
  const loaded = await loadSaveRecord();
  assert.ok(loaded);
  assert.equal(loaded.vitalsSource, 'demo');
});

test('v1 corrupt state still surfaces CorruptSaveError (migration does not launder it)', async () => {
  setup();
  seedRawRecord(DB_NAME, STORE_NAME, {
    id: CURRENT_KEY,
    savedAt: 1,
    state: { version: 1, area: 'castle' },
  });
  await assert.rejects(loadSaveRecord(), CorruptSaveError);
});

test('clearSave removes format-2 records', async () => {
  setup();
  await saveGame(createNewGame(), {
    vitalsSource: 'imported',
    importedProfile: profileFrom('lowHp'),
  });
  await clearSave();
  assert.equal(await loadSaveRecord(), null);
  assert.equal(await loadGame(), null);
});
