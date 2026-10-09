import { CONTRACT_NUMBER } from '../contract.ts';
/**
 * The Hearthwick Library: one shared shelf per world.
 *
 * - The starting shelf (papers with source `library-start`) is content: every
 *   player can read those from day one.
 * - Donations are the players' own. Connected players share one shelf per
 *   world through the server (contract below), with a local fallback when
 *   the server has no library.
 * - The local half (donation flags in the save) is kept only because
 *   game/papers.ts still calls it: TODO(C2), donations go through the
 *   operation queue and the local half goes with it.
 *
 * Server contract (server/internal/api/library.go, village.proto):
 *   GET  /api/library        → 200 { state, result: { shelves: [{ paperId, donatedBy, donatedAt }] } }
 *                              (the adapter flattens the mixed envelope before parsing)
 *   POST /api/library/donate   { paperId, op, where }
 *                            → 200 { state, libraryDonate: { entry: { paperId, donatedBy, donatedAt } } }
 *                            → 409 { error: { code: 'already-shelved' } }
 *                                  (no entry for a starting-shelf paper)
 *                            → 403 { error: { code: 'not-held' } }
 *                            → 422 { error: { code: 'unknown-paper' } }
 *   Other refusals keep their own codes (a 409 can also be
 *   `idempotency-mismatch` or `world-choice-required`); they count as errors.
 *   A 404/405/501, or an answer that is not JSON, means "no library on this
 *   server": the client falls back to local.
 */
import { fromJson } from '@bufbuild/protobuf';
import { LibraryEntrySchema } from '../gen/glimway/v1/village_pb.js';
import { PAPERS, paperById } from '../../content/papers.ts';

export interface ShelfEntry {
  paperId: string;
  /** Null for the starting shelf (the Keepers' own books). */
  donatedBy: string | null;
  /** ISO date (YYYY-MM-DD or a full timestamp); null for the starting shelf. */
  donatedAt: string | null;
}

const DONATED_PREFIX = 'donated:';

/** Papers that are on the shelves before anyone donates anything. */
export function startingShelf(): ShelfEntry[] {
  return PAPERS.filter((p) => p.source.kind === 'library-start').map((p) => ({ paperId: p.id, donatedBy: null, donatedAt: null }));
}

function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The save flag recording a local donation. TODO(C2): goes with game/papers.ts. */
export function donationFlag(paperId: string, when: Date): string {
  return `${DONATED_PREFIX}${paperId}@${isoDay(when)}`;
}

/** Local donations recorded in a save's flags (first per paper wins). TODO(C2): goes with game/papers.ts. */
export function localDonations(flags: readonly string[], donor: string): ShelfEntry[] {
  const out: ShelfEntry[] = [];
  for (const f of flags) {
    if (!f.startsWith(DONATED_PREFIX)) continue;
    const rest = f.slice(DONATED_PREFIX.length);
    const at = rest.lastIndexOf('@');
    const paperId = at > 0 ? rest.slice(0, at) : rest;
    const day = at > 0 ? rest.slice(at + 1) : '';
    if (!paperById(paperId) || out.some((e) => e.paperId === paperId)) continue;
    out.push({ paperId, donatedBy: donor, donatedAt: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null });
  }
  return out;
}

/**
 * The shelf as everyone sees it: the starting shelf, then donations. A
 * paper is shelved once; the earliest donation is its "first donated by".
 */
export function mergeShelf(...sources: ShelfEntry[][]): Map<string, ShelfEntry> {
  const shelf = new Map<string, ShelfEntry>();
  for (const e of startingShelf()) shelf.set(e.paperId, e);
  const donations = sources.flat().filter((e) => paperById(e.paperId));
  donations.sort((a, b) => (a.donatedAt ?? '9999').localeCompare(b.donatedAt ?? '9999'));
  for (const e of donations) if (!shelf.has(e.paperId)) shelf.set(e.paperId, e);
  return shelf;
}

/** Validate a server shelf list (unknown papers and malformed rows dropped). */
export function parseShelves(data: unknown): ShelfEntry[] | null {
  if (!data || typeof data !== 'object' || !Array.isArray((data as { shelves?: unknown }).shelves)) return null;
  const out: ShelfEntry[] = [];
  for (const row of (data as { shelves: unknown[] }).shelves) {
    const e = parseEntry(row);
    if (e) out.push(e);
  }
  return out;
}

export function parseEntry(row: unknown): ShelfEntry | null {
  if (!row || typeof row !== 'object') return null;
  // Decode the wire's generated entry; a malformed row is dropped (the
  // remote read stays tolerant: an older server without the library falls
  // back to local).
  let paperId: string;
  let donatedBy: string;
  let donatedAt: string;
  try {
    const e = fromJson(LibraryEntrySchema, row as never, { ignoreUnknownFields: true });
    paperId = e.paperId;
    donatedBy = e.donatedBy;
    donatedAt = e.donatedAt;
  } catch {
    return null;
  }
  if (!paperById(paperId)) return null;
  const by = donatedBy.trim() ? donatedBy.trim().slice(0, 60) : null;
  const at = !Number.isNaN(Date.parse(donatedAt)) ? donatedAt : null;
  return { paperId, donatedBy: by, donatedAt: at };
}

// ------------------------------------------------------------ remote adapter

type RemoteLoad = { ok: true; shelves: ShelfEntry[] } | { ok: false; reason: 'unsupported' | 'offline' | 'error' };

/** The shelf read. Donations are keyed operations through the link's outbox (game/papers.ts). */
export interface RemoteLibrary {
  load(): Promise<RemoteLoad>;
}

export interface RemoteLibraryOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Same-origin JSON with the session cookie, like src/lib/api/client.ts. */
export function createRemoteLibrary(options: RemoteLibraryOptions = {}): RemoteLibrary {
  const { baseUrl = '', timeoutMs = 10_000 } = options;
  const doFetch: typeof fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown } | 'offline'> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: body === undefined ? { Accept: 'application/json', 'X-Glimway-Contract': String(CONTRACT_NUMBER) } : { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Glimway-Contract': String(CONTRACT_NUMBER) },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
      const type = res.headers.get('content-type') ?? '';
      let json: unknown;
      if (type.toLowerCase().includes('application/json')) {
        try {
          json = await res.json();
        } catch {
          json = undefined;
        }
      }
      return { status: res.status, json };
    } catch {
      return 'offline';
    } finally {
      clearTimeout(timer);
    }
  }

  /** No library here: a 404/405/501, or an answer that is not JSON (an HTML fallback page). */
  const unsupported = (r: { status: number; json: unknown }) => r.status === 404 || r.status === 405 || r.status === 501 || (r.status < 300 && r.json === undefined);

  return {
    async load() {
      const r = await call('GET', '/api/library');
      if (r === 'offline') return { ok: false, reason: 'offline' };
      if (unsupported(r)) return { ok: false, reason: 'unsupported' };
      if (r.status >= 300) return { ok: false, reason: r.status >= 500 ? 'offline' : 'error' };
      // `{ state, result: { shelves } }` from the mixed envelope; the bare shape too.
      const json = r.json as { result?: unknown } | undefined;
      const shelves = parseShelves(json && typeof json.result === 'object' && json.result !== null ? json.result : r.json);
      return shelves ? { ok: true, shelves } : { ok: false, reason: 'error' };
    },
  };
}
