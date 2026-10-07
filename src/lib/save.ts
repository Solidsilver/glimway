import { InvalidSaveError, SAVE_VERSION, validateSave, type GameState } from './state.ts';
import { validateHabiticaProfile } from './habitica/mapping.ts';
import type {
  HabiticaProfile,
  LoadedSave,
  SaveDocumentV2,
  SaveExtras,
  VitalsSource,
} from './habitica/types.ts';

export type { SaveGameOptions } from './habitica/types.ts';
import type { SaveGameOptions } from './habitica/types.ts';

/**
 * Thrown when stored save data exists but cannot be validated. Carries the raw
 * stored record so the interface can offer an explicit export/clear choice.
 * Corrupt data is never deleted or silently overwritten by this module.
 */
export class CorruptSaveError extends Error {
  readonly raw: unknown;

  constructor(message: string, raw?: unknown) {
    super(message);
    this.name = 'CorruptSaveError';
    this.raw = raw;
  }
}

// The game's old name, kept so saves load.
const DB_NAME = 'fingersnap';
const DB_VERSION = 1;
const STORE_NAME = 'saves';
const CURRENT_KEY = 'current';

/** Hard cap on import payload size, in UTF-16 code units. */
export const MAX_IMPORT_LENGTH = 200_000;

/**
 * Save wrapper format. Format 1 = `{ id, savedAt, state }` (M2). Format 2
 * adds provenance: `{ saveFormat: 2, state, vitalsSource, importedProfile? }`.
 * `SaveDocumentV2.version` stays GameState's schema version (1).
 */
export const SAVE_FORMAT = 2 as const;

interface StoredSave {
  id: string;
  savedAt: number;
  saveFormat?: number;
  state: unknown;
  vitalsSource?: unknown;
  importedProfile?: unknown;
}

function getIndexedDB(): IDBFactory {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) {
    throw new Error(
      'IndexedDB is not available in this environment; Glimway saves need it (private browsing modes may disable it).',
    );
  }
  return factory;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ??
          new Error('IndexedDB request failed for an unknown reason.'),
      );
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = getIndexedDB().open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ??
          new Error(`Could not open the Glimway save database "${DB_NAME}".`),
      );
    request.onblocked = () =>
      reject(
        new Error(
          'The Glimway save database is blocked by another tab or window. Close other Glimway tabs and try again.',
        ),
      );
  });
}

/**
 * All reads and writes are funneled through one promise queue so a slow write
 * can never be clobbered by a later stale one, and a load always observes the
 * most recently queued save.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function toCorruptError(err: unknown, raw: unknown): CorruptSaveError {
  const detail = err instanceof Error ? err.message : String(err);
  return new CorruptSaveError(
    `The stored Glimway save is corrupt and will not be used or overwritten: ${detail}. Export it for recovery or explicitly clear it before starting a new game.`,
    raw,
  );
}

function normalizeVitalsSource(value: unknown): VitalsSource {
  if (value === undefined || value === null) return 'demo';
  if (value === 'demo' || value === 'imported') return value;
  throw new InvalidSaveError(
    `expected "demo" or "imported", got ${JSON.stringify(value)}`,
    'vitalsSource',
  );
}

/**
 * Validates a stored record and migrates save format 1 to format 2 in memory
 * (v1 records carry no provenance: they are demo saves without a profile).
 */
function normalizeStoredSave(stored: StoredSave): LoadedSave {
  const state = validateSave(stored.state);
  const vitalsSource = normalizeVitalsSource(stored.vitalsSource);
  let importedProfile: HabiticaProfile | undefined;
  if (stored.importedProfile !== undefined && stored.importedProfile !== null) {
    importedProfile = validateHabiticaProfile(stored.importedProfile);
  }
  const loaded: LoadedSave = { state, vitalsSource };
  if (importedProfile) loaded.importedProfile = importedProfile;
  return loaded;
}

async function readStoredSave(db: IDBDatabase): Promise<StoredSave | undefined> {
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const raw = await requestResult(store.get(CURRENT_KEY));
  return raw as StoredSave | undefined;
}

function toLoadedOrThrow(stored: StoredSave): LoadedSave {
  try {
    return normalizeStoredSave(stored);
  } catch (err) {
    throw toCorruptError(err, stored);
  }
}

/**
 * Loads the stored game state. Resolves to null when no save exists. Throws
 * CorruptSaveError when a save exists but fails validation, leaving the stored
 * record untouched. v1 saves load and read as demo-provenance.
 */
export function loadGame(): Promise<GameState | null> {
  return enqueue(async () => {
    const db = await openDatabase();
    try {
      const stored = await readStoredSave(db);
      if (!stored) return null;
      return toLoadedOrThrow(stored).state;
    } finally {
      db.close();
    }
  });
}

/**
 * Like loadGame, but returns state plus provenance (vitalsSource,
 * importedProfile) so the UI can label demo vs imported adventures.
 */
export function loadSaveRecord(): Promise<LoadedSave | null> {
  return enqueue(async () => {
    const db = await openDatabase();
    try {
      const stored = await readStoredSave(db);
      if (!stored) return null;
      return toLoadedOrThrow(stored);
    } finally {
      db.close();
    }
  });
}

/**
 * Persists the game state as save format 2. Validates input, strips unknown
 * fields (so credentials can never be stored), and refuses to overwrite an
 * existing corrupt save unless explicitly asked to. When
 * options.vitalsSource / options.importedProfile are omitted, the provenance
 * already stored is preserved — ordinary gameplay saves cannot silently
 * downgrade an imported save back to demo.
 */
export function saveGame(state: GameState, options: SaveGameOptions = {}): Promise<void> {
  return enqueue(async () => {
    const clean = validateSave(state);
    const db = await openDatabase();
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const existing = (await requestResult(store.get(CURRENT_KEY))) as StoredSave | undefined;

      let vitalsSource: VitalsSource = 'demo';
      let importedProfile: HabiticaProfile | undefined;
      if (existing) {
        let existingLoaded: LoadedSave | null = null;
        try {
          existingLoaded = normalizeStoredSave(existing);
        } catch (err) {
          if (options.overwriteCorrupt !== true) {
            throw toCorruptError(err, existing);
          }
        }
        if (existingLoaded) {
          vitalsSource = existingLoaded.vitalsSource;
          importedProfile = existingLoaded.importedProfile;
        }
      }
      if (options.vitalsSource !== undefined) {
        vitalsSource = normalizeVitalsSource(options.vitalsSource);
      }
      if (options.importedProfile === null) {
        // Explicit clear: demo rollback / reset must not leave a stale baseline.
        importedProfile = undefined;
      } else if (options.importedProfile !== undefined) {
        importedProfile = validateHabiticaProfile(options.importedProfile);
      } else if (options.vitalsSource === 'demo') {
        // Reset to demo provenance implies no imported baseline.
        importedProfile = undefined;
      }

      const record: StoredSave = {
        id: CURRENT_KEY,
        savedAt: Date.now(),
        saveFormat: SAVE_FORMAT,
        state: clean,
        vitalsSource,
      };
      if (importedProfile) record.importedProfile = importedProfile;
      await requestResult(store.put(record));
    } finally {
      db.close();
    }
  });
}

/**
 * Removes the stored save. Intended for an explicit "discard save" action in
 * the interface after the player has confirmed it.
 */
export function clearSave(): Promise<void> {
  return enqueue(async () => {
    const db = await openDatabase();
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      await requestResult(tx.objectStore(STORE_NAME).delete(CURRENT_KEY));
    } finally {
      db.close();
    }
  });
}

/**
 * Serializes a portable save document (format 2). Only known GameState fields
 * and a sanitized profile are written; credentials or any foreign fields on
 * the inputs are stripped and can never appear in the output.
 */
export function exportSave(state: GameState, extras?: SaveExtras): string {
  const clean = validateSave(state);
  const document: SaveDocumentV2 = {
    // The game's old name, kept so save codes made before the rename still import.
    kind: 'fingersnap-save',
    version: clean.version,
    saveFormat: SAVE_FORMAT,
    exportedAt: new Date().toISOString(),
    state: clean,
    vitalsSource: normalizeVitalsSource(extras?.vitalsSource ?? 'demo'),
  };
  if (extras?.importedProfile !== undefined) {
    document.importedProfile = validateHabiticaProfile(extras.importedProfile);
  }
  return JSON.stringify(document, null, 2);
}

function isWrapperDocument(
  parsed: unknown,
): parsed is Record<string, unknown> & { state: unknown } {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    'state' in parsed
  );
}

/**
 * Parses a portable save document (format 1 or 2) or a bare GameState.
 * Throws on oversized, malformed, or invalid input. Migrates format 1 to
 * demo provenance.
 */
export function importSaveDocument(json: string): LoadedSave {
  if (typeof json !== 'string') {
    throw new InvalidSaveError(
      `save import must be a JSON string, got ${typeof json}`,
    );
  }
  if (json.length > MAX_IMPORT_LENGTH) {
    throw new InvalidSaveError(
      `save import is too large (${json.length} characters, limit ${MAX_IMPORT_LENGTH})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new InvalidSaveError(`save import is not valid JSON: ${detail}`);
  }

  if (!isWrapperDocument(parsed)) {
    return { state: validateSave(parsed), vitalsSource: 'demo' };
  }

  const doc = parsed as Record<string, unknown>;
  if (doc.kind !== undefined && doc.kind !== 'fingersnap-save') {
    throw new InvalidSaveError(
      `unrecognized save document kind ${JSON.stringify(doc.kind)} (expected "fingersnap-save")`,
    );
  }
  if (doc.version !== undefined && doc.version !== SAVE_VERSION) {
    throw new InvalidSaveError(
      `unsupported save document version ${JSON.stringify(doc.version)} (expected ${SAVE_VERSION})`,
    );
  }
  if (doc.saveFormat !== undefined && doc.saveFormat !== 1 && doc.saveFormat !== SAVE_FORMAT) {
    throw new InvalidSaveError(
      `unsupported save format ${JSON.stringify(doc.saveFormat)} (expected 1 or ${SAVE_FORMAT})`,
    );
  }

  try {
    return normalizeStoredSave({
      id: CURRENT_KEY,
      savedAt: 0,
      saveFormat: doc.saveFormat as number | undefined,
      state: doc.state,
      vitalsSource: doc.vitalsSource,
      importedProfile: doc.importedProfile,
    });
  } catch (err) {
    if (err instanceof InvalidSaveError) throw err;
    throw new InvalidSaveError(
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Parses a portable save document (or bare GameState) and returns just the
 * GameState. See importSaveDocument for the full document.
 */
export function importSave(json: string): GameState {
  return importSaveDocument(json).state;
}
