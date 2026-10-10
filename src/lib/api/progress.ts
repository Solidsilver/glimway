/**
 * What is left of the connected save's progress document. The document,
 * its merge and the reconnect plans are gone (design server-first 2.3); the
 * link adopts server states and predicts operations instead
 * (src/lib/api/predict.ts).
 *
 * TODO(C1): the export below goes once the origin flow
 * (src/ui/account-flow.svelte.ts) and the guest pack (src/lib/inventory.ts)
 * stop reading it; then this file goes too.
 */

/** The four quest items (`quest-item` marks on the server). */
export const QUEST_ITEMS: readonly string[] = ['field-journal', 'hearthwick-map', 'lantern-route-rubbing', 'warden-seal'];
