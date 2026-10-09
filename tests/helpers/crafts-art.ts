/**
 * Crafts content whose art the crafts pass delivers (docs/design/crafts.md
 * 9, lane H): the stable's back and front layers (9.2) and the willow rod's
 * icon frames (9.3). Until that pass lands these resolve to no art at all,
 * and the art tests hold their peace about exactly these ids — never about
 * anything else.
 */
export const CRAFTS_ART_PENDING: ReadonlySet<string> = new Set(['stable', 'willow-rod']);
