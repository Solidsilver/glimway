/**
 * Crafts content whose art isn't wired yet (docs/design/crafts.md 9.3): the
 * willow rod's inventory frames (lane G wires the crafts pass's rod). The
 * art tests hold their peace about exactly these ids — never about anything
 * else. The stable resolves to the crafts pass's west end (lane E).
 */
export const CRAFTS_ART_PENDING: ReadonlySet<string> = new Set(['willow-rod']);
