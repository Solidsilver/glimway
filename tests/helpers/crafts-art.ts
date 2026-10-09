/**
 * Crafts content whose art the crafts pass delivers but no lane has wired
 * yet (docs/design/crafts.md 9, lane H): the stable's back and front layers
 * (9.2, lane E). Until it's wired this resolves to no art at all, and the
 * art tests hold their peace about exactly this id — never about anything
 * else. The willow rod's icon is wired (lane G, the items pass).
 */
export const CRAFTS_ART_PENDING: ReadonlySet<string> = new Set(['stable']);
