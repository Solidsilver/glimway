/** Texture keys of the crafts pass's frames (src/game/crafts-art.ts makes them). Phaser-free, for lookups in node tests. */
export const CRAFTS_ART_PREFIX = 'crafts-art:'

export const craftsArt = (frame: string): string => `${CRAFTS_ART_PREFIX}${frame}`

/**
 * Placed home goods drawn from the crafts pass (their world sprite, the
 * thumbnail's source): the stable's west end with its door shut, which is
 * the whole stable at one stall. The homestead draws a placed stable
 * specially, bay by bay (src/lib/stable-layout.ts).
 */
export const CRAFTS_WORLD_ART: Readonly<Record<string, string>> = {
  stable: 'stable-west-front-shut'
}
