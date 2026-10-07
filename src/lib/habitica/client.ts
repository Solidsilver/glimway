import { InvalidHabiticaUserError, toHabiticaProfile } from './mapping.ts';
import { gearStatsFor } from './gear.ts';
import type {
  GearStatsLookup,
  HabiticaClient,
  HabiticaCredentials,
  HabiticaProfile,
} from './types.ts';

const HABITICA_BASE_URL = 'https://habitica.com';

/**
 * Minimal field projection for the character mapping (docs/habitica-foundations.md:
 * `?userFields=` returns a projection instead of the full document). Includes
 * costume gear and selected companions so imported profiles carry them, and
 * the party id, which signing in to a world tells the server to expect.
 */
export const USER_FIELDS =
  'stats,items.gear.equipped,items.gear.costume,items.pets,items.mounts,items.currentPet,items.currentMount,preferences,profile.name,flags.classSelected,party._id';

export type HabiticaErrorKind =
  | 'auth'
  | 'rate-limited'
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid-response';

/**
 * Typed failure from the read-only client. Messages are static text plus
 * status codes — never credentials, never response bodies.
 */
export class HabiticaApiError extends Error {
  readonly kind: HabiticaErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: HabiticaErrorKind,
    message: string,
    extra: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'HabiticaApiError';
    this.kind = kind;
    this.status = extra.status;
    this.retryAfterMs = extra.retryAfterMs;
  }
}

export interface HabiticaClientOptions {
  credentials: HabiticaCredentials;
  /** Gear stat values for the effective-stat formula (fixtures now). */
  gearStats?: GearStatsLookup;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxRateLimitRetries?: number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RATE_LIMIT_RETRIES = 3;
const DEFAULT_RETRY_AFTER_MS = 1000;
const MAX_RETRY_AFTER_MS = 60000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerValue: string | null): number {
  if (!headerValue) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  return DEFAULT_RETRY_AFTER_MS;
}

/**
 * Read-only Habitica client. Exactly one operation: fetch and map the
 * authenticated user's profile. There are no write methods by design —
 * Fingersnap never changes a Habitica account.
 */
export function createHabiticaClient(options: HabiticaClientOptions): HabiticaClient {
  const {
    credentials,
    gearStats = gearStatsFor,
    fetchImpl,
    baseUrl = HABITICA_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRateLimitRetries = DEFAULT_RATE_LIMIT_RETRIES,
    sleep = defaultSleep,
  } = options;

  const doFetch: typeof fetch =
    fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  const url = `${baseUrl.replace(/\/$/, '')}/api/v3/user?userFields=${encodeURIComponent(USER_FIELDS)}`;

  async function requestOnce(): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const abortRejection = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(
          new HabiticaApiError('timeout', `Habitica request timed out after ${timeoutMs}ms.`),
        );
      });
    });

    try {
      const response = await Promise.race([
        doFetch(url, {
          method: 'GET',
          headers: {
            'x-api-user': credentials.userId,
            'x-api-key': credentials.apiToken,
            'x-client': credentials.clientTag,
            Accept: 'application/json',
          },
          signal: controller.signal,
        }),
        abortRejection,
      ]);

      if (response.status === 401 || response.status === 403) {
        throw new HabiticaApiError(
          'auth',
          `Habitica rejected the credentials (HTTP ${response.status}). Check the user id and API token.`,
          { status: response.status },
        );
      }
      if (response.status === 429) {
        throw new HabiticaApiError(
          'rate-limited',
          'Habitica rate limit reached (HTTP 429).',
          {
            status: 429,
            retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
          },
        );
      }
      if (!response.ok) {
        throw new HabiticaApiError('http', `Habitica request failed (HTTP ${response.status}).`, {
          status: response.status,
        });
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new HabiticaApiError('invalid-response', 'Habitica returned an unreadable response.');
      }
      return body;
    } catch (err) {
      if (err instanceof HabiticaApiError) throw err;
      if (timedOut) {
        throw new HabiticaApiError('timeout', `Habitica request timed out after ${timeoutMs}ms.`);
      }
      throw new HabiticaApiError('network', 'Could not reach Habitica. Check the connection.');
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchProfile(): Promise<HabiticaProfile> {
    let attemptsLeft = maxRateLimitRetries;
    for (;;) {
      try {
        const body = await requestOnce();
        const data =
          typeof body === 'object' && body !== null && 'data' in body
            ? (body as { data: unknown }).data
            : undefined;
        if (data === undefined) {
          throw new HabiticaApiError('invalid-response', 'Habitica response had no user data.');
        }
        try {
          return toHabiticaProfile(data, gearStats);
        } catch (err) {
          if (err instanceof InvalidHabiticaUserError) {
            throw new HabiticaApiError(
              'invalid-response',
              'Habitica returned an unexpected user payload.',
            );
          }
          throw err;
        }
      } catch (err) {
        if (err instanceof HabiticaApiError && err.kind === 'rate-limited' && attemptsLeft > 0) {
          attemptsLeft -= 1;
          await sleep(err.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS);
          continue;
        }
        throw err;
      }
    }
  }

  return { fetchProfile };
}
