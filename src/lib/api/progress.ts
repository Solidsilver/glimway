/**
 * What is left of the connected save's progress document. The document,
 * its merge and the reconnect plans are gone (design server-first 2.3); the
 * link adopts server states and predicts operations instead
 * (src/lib/api/predict.ts).
 *
 * TODO(C1): the two exports below go once the origin flow
 * (src/ui/account-flow.svelte.ts) and the guest pack (src/lib/inventory.ts)
 * stop reading them; then this file goes too.
 */
import { CHARM_ITEM } from '../embers.ts';
import type { GameState } from '../state.ts';

/** The four quest items (`quest-item` marks on the server). */
export const QUEST_ITEMS: readonly string[] = ['field-journal', 'hearthwick-map', 'lantern-route-rubbing', 'warden-seal'];

/** Whether a state carries progress worth migrating (vs a brand-new journey). */
export function hasProgress(state: GameState): boolean {
  return (
    state.quest !== 'new' ||
    state.embers > 0 ||
    state.discoveries.length > 0 ||
    state.defeatedEnemies.length > 0 ||
    state.playSeconds >= 30 ||
    state.inventory.includes(CHARM_ITEM)
  );
}
