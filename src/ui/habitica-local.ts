/**
 * UI-side Habitica wiring: the credentials' in-memory holder and error copy
 * for the connect guide (src/lib/habitica/*, contract: docs/import-contract.md).
 *
 * SECURITY CONTRACT: credentials live ONLY in this module's in-memory holder,
 * for the lifetime of a connected session — until Disconnect or page unload.
 * They are never written to GameState, IndexedDB saves, export codes,
 * localStorage, logs, or the event bus. Error copy is static text plus status
 * codes — never raw error bodies or token material.
 */
import { HabiticaApiError, createHabiticaClient, type HabiticaErrorKind } from '../lib/habitica/client.ts'

import type { HabiticaClient, HabiticaCredentials, HabiticaProfile } from '../lib/habitica/types.ts'

export type { HabiticaClient, HabiticaCredentials, HabiticaProfile }

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
  const env = (import.meta as unknown as { env?: Record<string, string> }).env
  const appName = env?.VITE_HABITICA_APP_NAME?.trim() || 'glimway'
  const credentials: HabiticaCredentials = {
    userId,
    apiToken,
    clientTag: `${creator ?? 'unknown-creator'}-${appName}`
  }
  connectionSession.credentials = credentials
  // No gearStats passed: the shared client applies its own default, the
  // bundled gear catalog (gearStatsFor).
  connectionSession.client = createHabiticaClient({ credentials })
  return credentials
}

export function connectedClient(): HabiticaClient | null {
  return connectionSession.client
}

/** The credentials in memory (null before a paste or a remembered load). */
export function memoryCredentials(): HabiticaCredentials | null {
  return connectionSession.credentials
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
// Errors + feature visibility
// ---------------------------------------------------------------------------

/** Static, credential-free copy per error kind. */
export function friendlyErrorCopy(err: unknown): string {
  if (err instanceof HabiticaApiError) {
    switch (err.kind as HabiticaErrorKind) {
      case 'auth':
        return 'Habitica didn\u2019t recognise those details — double-check your User ID and API Token.'
      case 'rate-limited':
        return err.retryAfterMs
          ? `Habitica is rate-limiting requests. Try again in about ${Math.max(1, Math.round(err.retryAfterMs / 1000))} seconds.`
          : 'Habitica is rate-limiting requests. Wait a moment and try again.'
      case 'timeout':
        return 'Habitica is taking a nap (it didn\u2019t answer in time). Try again?'
      case 'network':
        return 'Couldn\u2019t reach Habitica — are you online?'
      case 'invalid-response':
        return 'Habitica sent back something we didn\u2019t expect. Try again in a bit.'
      case 'http':
        return `Habitica had a problem${err.status ? ` (error ${err.status})` : ''}. Try again in a bit.`
    }
  }
  return 'Something went wrong while syncing. Your Habitica account wasn\u2019t touched.'
}
