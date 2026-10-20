/**
 * The web client's settings: the server's settings file's [web] table, as the
 * server hands it to this player (GET /api/web-settings; server/internal/settings
 * and docs/design/server-settings.md). A setting here changes with the
 * server's file, never with a new web build. Read again on sign-in, since the
 * dev part is per account.
 */
import { CONTRACT_NUMBER } from './contract.ts'

/** Dev mode's tools this player has, both sides' (the server's routes and the client's hooks). */
export interface DevTools {
  grant: boolean
  hooks: boolean
  clock: boolean
  fight_fall: boolean
}

export interface WebSettings {
  /** Null: no dev tools for this player (and always null for a release server). */
  dev: DevTools | null
}

const NONE: WebSettings = { dev: null }
let current: WebSettings = NONE
const listeners = new Set<(s: WebSettings) => void>()
/** Bumped by each load and each reset: an answer to an older one is stale. */
let generation = 0

export function webSettings(): WebSettings {
  return current
}

/** Called with each change (not the current settings). Returns the unsubscribe. */
export function onWebSettings(fn: (s: WebSettings) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function adopt(next: WebSettings): void {
  current = next
  for (const fn of listeners) fn(next)
}

/**
 * Forget the settings now, before another account's are read (an account
 * switch, signing out): its grants never carry over to the next account,
 * and an answer still on its way for the last one is dropped.
 */
export function resetWebSettings(): void {
  generation += 1
  adopt(NONE)
}

/** The answer's shape checked: anything else reads as no settings. */
export function parseWebSettings(raw: unknown): WebSettings {
  const dev = (raw as { dev?: unknown } | null)?.dev
  if (!dev || typeof dev !== 'object') return NONE
  const d = dev as Record<string, unknown>
  return { dev: { grant: d.grant === true, hooks: d.hooks === true, clock: d.clock === true, fight_fall: d.fight_fall === true } }
}

/**
 * Ask the server again. An older server (no route) or no answer: no
 * settings. An answer that a newer load or a reset has overtaken changes
 * nothing; the settings it gives are the current ones.
 */
export async function loadWebSettings(fetcher: typeof fetch = fetch): Promise<WebSettings> {
  const mine = ++generation
  let next = NONE
  try {
    const res = await fetcher('/api/web-settings', { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Glimway-Contract': String(CONTRACT_NUMBER) } })
    if (res.ok) next = parseWebSettings(await res.json())
  } catch {
    next = NONE
  }
  if (mine === generation) adopt(next)
  return current
}
