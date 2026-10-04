/**
 * The Hearthwick Library: one shared shelf per world.
 *
 * - The starting shelf (papers with source `library-start`) is content: every
 *   player, guest or connected, can read those from day one.
 * - Donations are the players' own. Guests (and connected players whose
 *   server has no library yet) keep theirs in the save as story flags
 *   `donated:<paperId>@<YYYY-MM-DD>`. Connected players share one shelf per
 *   world through the server (contract below), with a local fallback when
 *   the endpoint answers 404.
 *
 * Server contract (not built yet — see .agent/REPORT.md):
 *   GET  /api/library        → 200 { shelves: [{ paperId, donatedBy, donatedAt }] }
 *   POST /api/library/donate   { paperId, key }
 *                            → 200 { entry: { paperId, donatedBy, donatedAt } }
 *                            → 409 { error: { code: 'already-shelved' }, entry }
 *                            → 403 { error: { code: 'not-held' } }
 *                            → 422 { error: { code: 'unknown-paper' } }
 *   A 404 means "no library on this server": the client falls back to local.
 */
import { PAPERS, paperById } from '../../content/papers.ts';

export interface ShelfEntry {
  paperId: string;
  /** Null for the starting shelf (the Keepers' own books). */
  donatedBy: string | null;
  /** ISO date (YYYY-MM-DD or a full timestamp); null for the starting shelf. */
  donatedAt: string | null;
}

export const DONATED_PREFIX = 'donated:';

/** Papers that are on the shelves before anyone donates anything. */
export function startingShelf(): ShelfEntry[] {
  return PAPERS.filter((p) => p.source.kind === 'library-start').map((p) => ({ paperId: p.id, donatedBy: null, donatedAt: null }));
}

export function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The save flag recording a local donation. */
export function donationFlag(paperId: string, when: Date): string {
  return `${DONATED_PREFIX}${paperId}@${isoDay(when)}`;
}

/** Local donations recorded in a save's flags (first per paper wins). */
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
  const r = row as Record<string, unknown>;
  if (typeof r.paperId !== 'string' || !paperById(r.paperId)) return null;
  const by = typeof r.donatedBy === 'string' && r.donatedBy.trim() ? r.donatedBy.trim().slice(0, 60) : null;
  const at = typeof r.donatedAt === 'string' && !Number.isNaN(Date.parse(r.donatedAt)) ? r.donatedAt : null;
  return { paperId: r.paperId, donatedBy: by, donatedAt: at };
}

// ------------------------------------------------------------ remote adapter

export type RemoteLoad = { ok: true; shelves: ShelfEntry[] } | { ok: false; reason: 'unsupported' | 'offline' | 'error' };

export type DonateOutcome =
  | { ok: true; entry: ShelfEntry }
  | { ok: false; reason: 'already-shelved'; entry: ShelfEntry | null }
  | { ok: false; reason: 'unsupported' | 'offline' | 'not-held' | 'unknown-paper' | 'signed-out' | 'error' };

export interface RemoteLibrary {
  load(): Promise<RemoteLoad>;
  donate(paperId: string, key: string): Promise<DonateOutcome>;
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
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
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

  const code = (json: unknown): string => {
    const e = (json as { error?: { code?: unknown } } | undefined)?.error;
    return typeof e?.code === 'string' ? e.code : '';
  };

  /** No library here: a 404/405/501, or an answer that is not JSON (an HTML fallback page). */
  const unsupported = (r: { status: number; json: unknown }) => r.status === 404 || r.status === 405 || r.status === 501 || (r.status < 300 && r.json === undefined);

  return {
    async load() {
      const r = await call('GET', '/api/library');
      if (r === 'offline') return { ok: false, reason: 'offline' };
      if (unsupported(r)) return { ok: false, reason: 'unsupported' };
      if (r.status >= 300) return { ok: false, reason: r.status >= 500 ? 'offline' : 'error' };
      const shelves = parseShelves(r.json);
      return shelves ? { ok: true, shelves } : { ok: false, reason: 'error' };
    },
    async donate(paperId, key) {
      const r = await call('POST', '/api/library/donate', { paperId, key });
      if (r === 'offline') return { ok: false, reason: 'offline' };
      if (unsupported(r)) return { ok: false, reason: 'unsupported' };
      if (r.status === 200 || r.status === 201) {
        const entry = parseEntry((r.json as { entry?: unknown } | undefined)?.entry);
        return entry ? { ok: true, entry } : { ok: false, reason: 'error' };
      }
      const c = code(r.json);
      if (r.status === 409 || c === 'already-shelved') {
        return { ok: false, reason: 'already-shelved', entry: parseEntry((r.json as { entry?: unknown } | undefined)?.entry) };
      }
      if (r.status === 401) return { ok: false, reason: 'signed-out' };
      if (c === 'not-held' || r.status === 403) return { ok: false, reason: 'not-held' };
      if (c === 'unknown-paper' || r.status === 422) return { ok: false, reason: 'unknown-paper' };
      if (r.status >= 500) return { ok: false, reason: 'offline' };
      return { ok: false, reason: 'error' };
    },
  };
}
