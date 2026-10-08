/**
 * Typed failures from server/internal/api and forwarded Habitica/rules errors.
 * Every server failure has the shape `{ "error": { "code": "…" } }`.
 * Messages here are static text: response bodies are never echoed, logged, or
 * shown, so nothing the server or a proxy sends can leak into the interface.
 */

/** Server codes checked against Go sources by error_codes_test.go. */
import { ErrorCode, ErrorCodeSchema } from '../gen/glimway/v1/errors_pb.js';

type Hyphens<S extends string> = S extends `${infer A}_${infer B}` ? `${Lowercase<A>}-${Hyphens<B>}` : Lowercase<S>;
export type ServerErrorCode = Hyphens<Exclude<keyof typeof ErrorCode, 'UNSPECIFIED'>>;
export const SERVER_ERROR_CODES: readonly ServerErrorCode[] = ErrorCodeSchema.values
  .filter(value => value.number !== 0)
  .map(value => value.name.slice('ERROR_CODE_'.length).toLowerCase().replaceAll('_', '-') as ServerErrorCode);

/**
 * Client-side kinds:
 * - `network`: the request never got an answer (offline, timeout, aborted).
 * - `unavailable`: something answered, but not the Glimway server (a static
 *   host's 404 page, an HTML fallback, a proxy error). Guest-only deployments
 *   look like this.
 * - `bad-response`: the server answered 200 with a body that fails validation.
 * - `unknown`: a well-formed server error with a code this build doesn't know.
 */
export type ClientErrorCode = 'network' | 'unavailable' | 'bad-response' | 'unknown';

export type ApiErrorCode = ServerErrorCode | ClientErrorCode;

/** A refusal the player is told about: its code and the words for it (src/content/errors.ts). */
export type Refusal = { ok: false; code: string; text: string };

/** What a game model's action gives the interface: its value, or a refusal to show. */
export type Result<T = undefined> = { ok: true; value: T } | Refusal;

const KNOWN = new Set<string>(SERVER_ERROR_CODES);

export function isServerErrorCode(code: string): code is ServerErrorCode {
  return KNOWN.has(code);
}

const MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  network: 'The Glimway server did not answer.',
  unavailable: 'No Glimway server here.',
  'bad-response': 'The Glimway server sent something unexpected.',
  unauthorized: 'Not signed in.',
  'access-denied': 'This world is invite-only, unless your party already plays here.',
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
    super(MESSAGES[code] ?? `Glimway server error: ${code}.`);
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
