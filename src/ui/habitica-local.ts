/**
 * M3 CharacterPanel Habitica wiring — UI-side glue for the shared import
 * foundation (src/lib/habitica/*, contract: docs/import-contract.md).
 *
 * SECURITY CONTRACT: credentials live ONLY in this module's in-memory holder,
 * for the lifetime of a connected session — until Disconnect or page unload.
 * They are never written to GameState, IndexedDB saves, export codes,
 * localStorage, logs, or the event bus. Error copy is static text plus status
 * codes — never raw error bodies or token material.
 */
import { HabiticaApiError, createHabiticaClient, type HabiticaErrorKind } from '../lib/habitica/client.ts'
import { FIXTURES, type HabiticaFixture } from '../lib/habitica/fixtures.ts'
import { toHabiticaProfile } from '../lib/habitica/mapping.ts'
import type { GearStatsLookup, HabiticaClient, HabiticaCredentials, HabiticaProfile } from '../lib/habitica/types.ts'

export type { HabiticaClient, HabiticaCredentials, HabiticaProfile } from '../lib/habitica/types.ts'

// ---------------------------------------------------------------------------
// Creator identity (X-Client): fixed, PUBLIC app config. The player's own id
// is never used here. Override for local dev via VITE_HABITICA_CREATOR_ID
// (see .env.example); it is a public id, not a secret.
// ---------------------------------------------------------------------------

const DEFAULT_CREATOR_ID = '5abfd539-22eb-457f-8e2a-9fb3d66731f1'

export function creatorId(): string | null {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env
  const override = env?.VITE_HABITICA_CREATOR_ID?.trim()
  const id = (override && override.length > 0 ? override : DEFAULT_CREATOR_ID).trim()
  return id.length > 0 ? id : null
}

// ---------------------------------------------------------------------------
// Connection session (module singleton — survives panel remounts; the panel
// reads it on mount so the UI always reflects existing memory).
// ---------------------------------------------------------------------------

interface ConnectionSession {
  credentials: HabiticaCredentials | null
  client: HabiticaClient | null
}

const connectionSession: ConnectionSession = { credentials: null, client: null }

export function connectSession(userId: string, apiToken: string): HabiticaCredentials {
  const creator = creatorId()
  const credentials: HabiticaCredentials = {
    userId,
    apiToken,
    clientTag: `${creator ?? 'unknown-creator'}-fingersnap`
  }
  connectionSession.credentials = credentials
  // No gearStats passed: the shared client applies its own catalog default
  // (gear contributes 0 until snap_assets' catalog lands).
  connectionSession.client = createHabiticaClient({ credentials })
  return credentials
}

export function connectedClient(): HabiticaClient | null {
  return connectionSession.client
}

export function isConnected(): boolean {
  return connectionSession.client !== null
}

export function disconnectSession(): void {
  connectionSession.credentials = null
  connectionSession.client = null
}

// Page unload wipes the credential memory (belt and braces with GC).
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => disconnectSession())
}

// ---------------------------------------------------------------------------
// Fixture demo: full pipeline exercise with no network and no credentials.
// ---------------------------------------------------------------------------

export function fixtureProfiles(): Array<{ key: string; label: string; profile: HabiticaProfile }> {
  return FIXTURES.map((f: HabiticaFixture) => ({
    key: f.key,
    label: `${f.key} — ${f.description}`,
    profile: toHabiticaProfile(f.user, gearLookupForFixture(f))
  }))
}

function gearLookupForFixture(f: HabiticaFixture): GearStatsLookup {
  return (key) => f.gearStats[key]
}

// ---------------------------------------------------------------------------
// Errors + feature visibility
// ---------------------------------------------------------------------------

/** Static, credential-free copy per error kind. */
export function friendlyErrorCopy(err: unknown): string {
  if (err instanceof HabiticaApiError) {
    switch (err.kind as HabiticaErrorKind) {
      case 'auth':
        return 'Habitica rejected the sign-in (check the user id and API token).'
      case 'rate-limited':
        return err.retryAfterMs
          ? `Habitica is rate-limiting requests. Try again in about ${Math.max(1, Math.round(err.retryAfterMs / 1000))} seconds.`
          : 'Habitica is rate-limiting requests. Wait a moment and try again.'
      case 'timeout':
        return 'Habitica took too long to answer. Try again.'
      case 'network':
        return 'Could not reach Habitica — check the connection.'
      case 'invalid-response':
        return 'Habitica sent an unexpected answer. Try again later.'
      case 'http':
        return `Habitica returned an error${err.status ? ` (status ${err.status})` : ''}. Try again later.`
    }
  }
  return 'Something went wrong while syncing. No account changes were made.'
}
