/**
 * Crafts content whose art isn't wired yet (docs/design/crafts.md 9). The
 * art tests hold their peace about exactly these ids — never about anything
 * else. Empty now: the stable (lane E) and the willow rod (lane G) are wired.
 */
export const CRAFTS_ART_PENDING: ReadonlySet<string> = new Set<string>();
