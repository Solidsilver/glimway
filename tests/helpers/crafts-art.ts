/**
 * Crafts content whose art isn't wired yet (docs/design/crafts.md 9). The
 * art tests hold their peace about exactly these ids — never about anything
 * else. The stable (lane E) and the willow rod (lane G) are wired. The
 * way-lamp's placed world art is still pending; its inventory icon is in the
 * items pass.
 */
export const CRAFTS_ART_PENDING: ReadonlySet<string> = new Set<string>(['way-lamp']);
