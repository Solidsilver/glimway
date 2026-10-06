import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assetKind, atZeroRule, giveable, isInstanced, isStackable, ITEMS, ITEM_RULES, offHandable, slotCount, usableNow } from '../src/lib/items.ts';

/**
 * What each item definition means once the rules apply (content/items.json),
 * as the TypeScript loader derives it. content/items_test.go derives the
 * same from Go and compares, so the two loaders can never drift apart.
 */
export function itemVectors() {
  const per = ITEM_RULES.wear.pointsPerUse;
  return ITEMS.items.map((d) => ({
    id: d.id,
    instanced: isInstanced(d),
    stackable: isStackable(d),
    assetKind: assetKind(d),
    atZero: atZeroRule(d),
    slots: slotCount(d),
    maxPoints: d.kind === 'tool' && atZeroRule(d) !== 'never' ? (d.uses ?? 0) * per : d.kind === 'fitting' && d.fitting !== 'remember' ? ITEM_RULES.wear.fittingUses * per : 0,
    giveable: giveable(d),
    usableNow: usableNow(d),
    offHand: offHandable(d),
  }));
}
export function serializeItemVectors() {
  return JSON.stringify(itemVectors(), null, 1) + '\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeFileSync(new URL('../content/vectors/items.json', import.meta.url), serializeItemVectors());
