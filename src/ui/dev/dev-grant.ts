/**
 * Dev mode (local playtesting only): ask the dev server to give this account
 * some of Glimway's own things (POST /api/dev/grant, a `-tags dev` server's
 * route; server/internal/api/dev_grant.go). The answer carries the new
 * player state: the link adopts it as it does any read's, and the stores the
 * bag and the HUD read from are read again. Imported only by the dev panel,
 * which only Vite dev mode loads.
 */
import { CONTRACT_NUMBER } from '../../lib/contract.ts';
import { decodePlayerState } from '../../lib/api/state-contract.ts';
import type { Session } from '../../game/session.ts';
import { itemsFor } from '../../game/items.ts';
import { homesteadsFor } from '../../game/homestead.ts';
import { villageFor } from '../../game/village.ts';

export interface GrantRequest {
  id: string;
  qty: number;
}

export type GrantOutcome = { ok: true; granted: GrantRequest[] } | { ok: false; text: string };

/** Not an ApiError: a refused dev call must never look like the server being unreachable. */
class DevGrantError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`dev grant: ${status} ${code}`);
  }
}

export async function devGrant(session: Session, grants: GrantRequest[]): Promise<GrantOutcome> {
  const link = session.link;
  if (!link) return { ok: false, text: 'Sign in to a world first.' };
  let failed: DevGrantError | null = null;
  const r = await link.readWith(async () => {
    const res = await fetch('/api/dev/grant', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Glimway-Contract': String(CONTRACT_NUMBER) },
      body: JSON.stringify({ grants }),
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const code = (body as { error?: { code?: string } } | undefined)?.error?.code ?? '';
      failed = new DevGrantError(res.status, code);
      throw failed;
    }
    const raw = body as { state: unknown; result: { granted: GrantRequest[] } };
    return { player: decodePlayerState(raw.state), granted: raw.result.granted };
  });
  if (!r.ok) {
    const f = failed as DevGrantError | null;
    if (f?.status === 404) return { ok: false, text: 'This server has no dev mode. Run it with npm run server (a -tags dev build), on this machine.' };
    if (f?.code === 'invalid-asset') return { ok: false, text: 'The server won’t give that: only Glimway’s own things.' };
    if (f?.code === 'invalid-quantity') return { ok: false, text: 'Too many at once for that.' };
    return { ok: false, text: `The grant didn’t go through (${f ? `${f.status} ${f.code}` : r.code}).` };
  }
  // The bag, the home goods (and the materials mirror they carry), the chests.
  void itemsFor(session).load();
  void homesteadsFor(session).load();
  void villageFor(session).loadStorage();
  return { ok: true, granted: r.value.granted };
}
