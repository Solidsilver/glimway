/**
 * Dev mode: move the server's clock forward (POST /api/dev/clock, a dev
 * build's route; server/cmd/glimway-server/dev_clock.go). World-wide and
 * forward-only: every player on that server lives at the new time, and it
 * never goes back. Imported only by the dev panel.
 */
import { CONTRACT_NUMBER } from '../../lib/contract.ts';

export type ClockOutcome = { ok: true; unix: number } | { ok: false; text: string };

/** The panel's steps forward. */
export const CLOCK_STEPS = [
  { id: 'hour', label: '1 hour', seconds: 3600 },
  { id: 'day', label: '1 day', seconds: 86_400 },
  { id: 'week', label: '1 week', seconds: 7 * 86_400 },
] as const;

export async function devClockAdvance(seconds: number, fetcher: typeof fetch = fetch): Promise<ClockOutcome> {
  let res: Response;
  try {
    res = await fetcher('/api/dev/clock', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Glimway-Contract': String(CONTRACT_NUMBER) },
      body: JSON.stringify({ advance_seconds: seconds }),
    });
  } catch {
    return { ok: false, text: 'The server didn’t answer.' };
  }
  if (res.status === 404) return { ok: false, text: 'This server won’t move its clock for you (dev mode’s clock is off, or not yours).' };
  let body: { unix?: number; moved?: boolean } | undefined;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok || !body?.moved || typeof body.unix !== 'number') return { ok: false, text: `The clock didn’t move (${res.status}).` };
  return { ok: true, unix: body.unix };
}
