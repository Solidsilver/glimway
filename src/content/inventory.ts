/**
 * Copy for the inventory panel (I). Item names and descriptions come from
 * the existing content (src/content/world.ts, expansion-writing.ts); only the
 * three crafted pieces had none, so their lines are here.
 */

/** The workshop bench's utility pieces (content/crafting.json `utilityItems`). */
export const CRAFTED_BLURBS: Record<string, string> = {
  'lamp-wick': 'Braided fiber, waxed at the tip. A lamp is only as good as its wick.',
  'oilcloth-wrap': 'Fiber cloth rubbed with linseed. Keeps a paper dry on the road.',
  'wooden-peg': 'A peg for a hook or a hinge. The kind of thing you only miss once.',
}

export const INVENTORY_TABS = [
  { id: 'tools', label: 'Tools', icon: 'sword' },
  { id: 'supplies', label: 'Supplies', icon: 'ember' },
  { id: 'keepsakes', label: 'Keepsakes', icon: 'sparkle' },
  { id: 'home', label: 'Home goods', icon: 'lantern' },
  { id: 'papers', label: 'Papers', icon: 'scroll' },
] as const

export const inventoryCopy = {
  title: 'Inventory',
  close: 'Close the inventory',
  intro: {
    tools: 'Tools wear with use. Some can be mended.',
    supplies: 'Materials from the Wilds and things you make at the bench.',
    keepsakes: 'Things the road gave back, and the charm from the Ashwatch chest.',
    home: 'Pieces for your place on the Commons.',
  },
  empty: {
    tools: 'No tools yet.',
    supplies: 'Nothing yet. The Tangle, north of the Commons, gives timber, stone, fiber and amber.',
    keepsakes: 'Nothing yet. The Wilds hand things back now and then.',
    homeGuest: 'Home goods are kept in a world. Sign in to have a place on the Commons.',
    homeWorld: 'Nothing yet. Silas sells furniture in his yard on the Commons.',
  },
  road: 'For the road',
  roadNote: 'Quest things. They stay with you.',
  placed: (n: number) => `${n} set out`,
  stored: (n: number) => `${n} put away`,
  papersNote: 'Also in your Journal (J).',
  newBadge: 'New',
  characterPointer: 'Your pack, materials and keepsakes are in the Inventory.',
  open: 'Open the inventory',
  // The item model (in a world).
  pockets: 'Pockets',
  pocket: (n: number) => `Pocket ${n}`,
  pocketEmpty: 'Empty',
  pocketMore: 'A satchel, apron or coat adds a second pocket.',
  offHand: 'Off hand',
  offHandClosed: 'Opens when you take a class.',
  offHandEmpty: 'Empty',
  offHandNote: 'Put away while you chop, dig, sit, draw water or fight.',
  madeBy: (name: string) => `Made by ${name}`,
  usesLeft: (n: number) => (n === 1 ? '1 use left' : `${n} uses left`),
  neverWears: 'Never wears',
  state: { blunt: 'Blunt. Mend it to use it again.', cracked: 'Cracked. Mend it to use it again.', dull: 'Dull. Sharp again by morning.' } as Record<string, string>,
  fittings: 'Fittings',
  actions: { use: 'Use', pocket: 'Pocket', unpocket: 'Take out', carry: 'Carry', putAway: 'Put away', give: 'Give', mend: 'Mend', fit: 'Fit to', takeOff: 'Take off' },
  giveTo: 'Hand it to',
  giveNobody: 'Stand next to someone to hand it over.',
  mendAt: (who: string, cost: string) => `${who} (${cost})`,
  mendBench: 'At your bench',
  ownChest: 'Your own chest',
  thanks: 'Thank-yous',
  thanksLine: (from: string, what: string) => `${from} used ${what} you made.`,
  loading: 'Opening your pack…',
}
