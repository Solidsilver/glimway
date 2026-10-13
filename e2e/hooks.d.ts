import type { FsHooks } from '../src/game/dev-hooks.ts'
declare global {
  interface Window extends Partial<FsHooks> {
    /** Per-page predicate state used only by waitFrames. */
    __fsWaits?: Record<string, { loop: number; t: number; f: (arg: unknown) => unknown }>
  }
}
