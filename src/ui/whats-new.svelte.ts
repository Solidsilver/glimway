import releases from 'virtual:whats-new'
import { RUNNING } from '../lib/version'
import { WhatsNewStore } from './whats-new-store.svelte'

/** The game's "What's new" card (src/ui/whats-new-store.svelte.ts), fed by CHANGELOG.md at build time (scripts/whats-new.mjs). */
export const whatsNew = new WhatsNewStore(releases, RUNNING)
