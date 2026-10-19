/**
 * The words of the loading screen (src/ui/LoadingScreen.svelte): one calm
 * line for each stage of entering the world (src/lib/loading.ts), and what
 * it says when a stage is slow or stuck. Placeholders for the lore pass:
 * reword freely, the stages stay the same.
 */
import type { LoadStage } from '../lib/loading.ts'

export const loadingLines: Record<LoadStage, string> = {
  /** Continue tapped: this page's place in the world (the lease) and your journey as the world holds it. */
  connect: 'Finding your way back…',
  /** The land around you: the open map's near read and the homestead lane, from the server. */
  land: 'Reading the lie of the land…',
  /** Fetching the art (the packed atlases; a return visit mostly checks them against the cache). */
  fetch: 'Gathering the lanterns…',
  /** Unpacking the fetched art into pictures. */
  decode: 'Unwrapping the lanterns…',
  /** Cutting the art into the world's pieces, a little each frame. */
  build: 'Lighting the lamps…',
  /** The Commons' fixed ground, if you stand on it, and the world's scene being put together. */
  arrive: 'Lighting the way…',
  /** The first chunks painted behind a dark screen, then the first frame. */
  paint: 'Lighting the way…'
}

export const loadingCopy = {
  /** Under the stage line once one stage has taken 8 seconds. */
  slow: 'This is taking longer than usual. The road is still there.',
  /** A stage that hasn't moved in 30 seconds. */
  stuck: 'The way has gone quiet. You can try again, or step back to the title.',
  /** A stage that failed outright. */
  failed: 'Something stopped the way from lighting. You can try again, or step back to the title.',
  /** The title's line when Continue failed and there was no loading screen to say it. */
  titleError: 'The way into your world didn’t open. Continue to try again.',
  retry: 'Try again',
  back: 'Back to the title',
  /** The Menu's button that copies the last loads' timings, for the owner to paste into a chat. */
  copyTimings: 'Copy load timings',
  copied: 'Load timings copied.',
  copyFailed: 'This browser wouldn’t copy them. The dev panel lists them too.',
  /** The screen reader's name for the loading screen. */
  label: 'Entering the world'
}
