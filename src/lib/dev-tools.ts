/**
 * Dev mode in the client (docs/design/server-settings.md).
 *
 * DEV_TOOLS: the dev panel and playtest hooks are compiled into this build —
 * the Vite dev server, or a dev-tools build (GLIMWAY_DEV_TOOLS=1, for a
 * staging server). A release build replaces it with false, so what it guards
 * never reaches the bundle. `typeof`: Node tests have no Vite define.
 *
 * Which tools show is then the server's word (web-settings.ts), except under
 * the Vite dev server, where local playtesting and e2e keep every tool as
 * before and the clock follows the server.
 */
import { webSettings, type DevTools } from './web-settings.ts'

/** Vite's define (vite.config.ts); declared here so every tsconfig that reaches this file knows it. */
declare const __GLIMWAY_DEV_TOOLS__: boolean

export const DEV_TOOLS: boolean = typeof __GLIMWAY_DEV_TOOLS__ !== 'undefined' && __GLIMWAY_DEV_TOOLS__

/** The Vite dev server (local playtesting, e2e). */
export const DEV_LOCAL: boolean = !!import.meta.env?.DEV

/** The tools to show now: none in a release build. */
export function devTools(): DevTools | null {
  if (!DEV_TOOLS) return null
  const dev = webSettings().dev
  if (DEV_LOCAL) return { grant: true, hooks: true, fight_fall: true, world_lab: true, clock: dev?.clock ?? false }
  return dev
}

/** The dev panel has something to show. */
export function devPanelOn(tools: DevTools | null): boolean {
  return DEV_LOCAL || !!tools && (tools.grant || tools.clock || tools.world_lab)
}
