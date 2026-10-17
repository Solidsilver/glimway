/**
 * Crafts content whose art isn't wired yet (docs/design/crafts.md 9). The
 * art tests hold their peace about exactly these ids — never about anything
 * else. The stable (lane E) and the willow rod (lane G) are wired. The
 * way-lamp (0.13 camps) is drawn with the lot lantern's stake until its own
 * art lands (.agent/NOTES.md lists it for an art lane). The bench trowel
 * shows the generic pack placeholder until its icon is drawn
 * (docs/art-request-lamps.md, `item-bench-trowel`).
 */
export const CRAFTS_ART_PENDING: ReadonlySet<string> = new Set<string>(['way-lamp', 'bench-trowel']);
