/**
 * Typed failures from the Fingersnap server (.agent/BACKEND-REPORT.md, "Error
 * codes"). Every server failure has the shape `{ "error": { "code": "…" } }`.
 * Messages here are static text: response bodies are never echoed, logged, or
 * shown, so nothing the server or a proxy sends can leak into the interface.
 */

/** Every code the backend contract documents. */
export const SERVER_ERROR_CODES = [
  // 400
  'invalid-json',
  'invalid-credentials',
  'invalid-client',
  'invalid-progress',
  'invalid-choice',
  'invalid-save',
  'invalid-spend',
  'key-required',
  // 401
  'unauthorized',
  'habitica-auth',
  // 403
  'access-denied',
  'cross-origin',
  'world-required',
  'player-flagged',
  // 404
  'not-found',
  'invite-not-found',
  // 409
  'playing-elsewhere',
  'superseded',
  'origin-required',
  'invalid-revision',
  'stale-revision',
  'account-switch',
  'not-at-safe-boundary',
  'already-set',
  'idempotency-mismatch',
  'not-defeated',
  'short',
  'done',
  'full',
  'needs-earned',
  'invite-limit',
  'invite-budget',
  'invite-used',
  // 415
  'json-required',
  // 422
  'implausible-profile',
  // 429
  'habitica-rate-limited',
  'login-rate-limited',
  'login-global-rate-limited',
  'login-busy',
  // Phase 3/4: homesteads and the Wilds (.agent/BACKEND-REPORT.md, "Errors")
  'invalid-claim',
  'invalid-position',
  'lantern-id-required',
  'world-access-denied',
  'item-not-owned',
  'region-not-found',
  'epoch-not-found',
  'entity-not-found',
  'lantern-not-found',
  'tier-required',
  'tier-unavailable',
  'insufficient-embers',
  'insufficient-materials',
  'already-placed',
  'not-placed',
  'out-of-bounds',
  'placement-overlap',
  'not-at-own-plot',
  'old-cycle',
  'entity-unavailable',
  'already-claimed',
  'epoch-ended',
  'not-defeated-in-wilds',
  'already-lit',
  'claim-rate-limited',
  'lantern-creation-limited',
  'not-in-wilds',
  'too-far-away',
  'generator-unavailable',
  // 500
  'internal',
  // 502
  'habitica-unavailable',
  'habitica-invalid-response',
] as const;

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

/**
 * Client-side kinds:
 * - `network`: the request never got an answer (offline, timeout, aborted).
 * - `unavailable`: something answered, but not the Fingersnap server (a static
 *   host's 404 page, an HTML fallback, a proxy error). Guest-only deployments
 *   look like this.
 * - `bad-response`: the server answered 200 with a body that fails validation.
 * - `unknown`: a well-formed server error with a code this build doesn't know.
 */
export type ClientErrorCode = 'network' | 'unavailable' | 'bad-response' | 'unknown';

export type ApiErrorCode = ServerErrorCode | ClientErrorCode;

const KNOWN = new Set<string>(SERVER_ERROR_CODES);

export function isServerErrorCode(code: string): code is ServerErrorCode {
  return KNOWN.has(code);
}

const MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  network: 'The Fingersnap server did not answer.',
  unavailable: 'No Fingersnap server here.',
  'bad-response': 'The Fingersnap server sent something unexpected.',
  unauthorized: 'Not signed in.',
  'access-denied': 'This world is invite-only.',
  'habitica-auth': 'Habitica did not recognise those details.',
  'playing-elsewhere': 'Playing on another device.',
  superseded: 'Another device took over.',
  'stale-revision': 'The save moved on.',
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** HTTP status, when there was a response. */
  readonly status?: number;
  /** Retry-After in milliseconds (429s), capped at a minute. */
  readonly retryAfterMs?: number;

  constructor(code: ApiErrorCode, extra: { status?: number; retryAfterMs?: number } = {}) {
    super(MESSAGES[code] ?? `Fingersnap server error: ${code}.`);
    this.name = 'ApiError';
    this.code = code;
    this.status = extra.status;
    this.retryAfterMs = extra.retryAfterMs;
  }
}

/** Seconds (or an HTTP date) to milliseconds, capped at 60 s. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.min(Math.max(0, at - now), 60_000);
  return undefined;
}

/**
 * Map a non-2xx response to a typed error. `body` is the parsed JSON or
 * undefined when the body was not JSON. Only the `error.code` string is read.
 */
export function errorFromResponse(status: number, body: unknown, retryAfter: string | null = null): ApiError {
  const code =
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'object' &&
    (body as { error: unknown }).error !== null
      ? (body as { error: { code?: unknown } }).error.code
      : undefined;
  if (typeof code !== 'string') return new ApiError('unavailable', { status });
  const retryAfterMs = status === 429 ? (parseRetryAfter(retryAfter) ?? 1000) : undefined;
  return new ApiError(isServerErrorCode(code) ? code : 'unknown', { status, retryAfterMs });
}

/** The server can't be reached right now (or isn't there at all). */
export function isUnreachable(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'network' || err.code === 'unavailable');
}

export function errorCode(err: unknown): ApiErrorCode {
  return err instanceof ApiError ? err.code : 'unknown';
}
