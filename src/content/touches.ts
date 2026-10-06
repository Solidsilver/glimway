/**
 * Lines for the small world touches (docs/hands-on-design.md, section 3):
 * smelling the flowers, sitting down, and reading the signs. All of it is
 * flavor — no items, no spends, nothing tracked — so it lives here as plain
 * content in the canon voice (docs/lore/chronicle.md).
 *
 * Rules for every line in this file, checked by tests/world.test.ts:
 * in-world only (no real-life tasks or apps), 160 characters or fewer, and
 * varied — each pool cycles so two presses in a row say something different.
 */

/** Smelling a flower pot, planter or bed: one line each time, cycling. */
export const FLOWER_LINES: readonly string[] = [
  'Lavender and warm stone.',
  'Crushed green and last night’s rain. Someone watered here this morning.',
  'Bees work the blooms, half asleep. Nobody hurries them.',
  'Sweet pea, and a hint of hearth-smoke off the roofs below the square.',
  'The stems all lean east, into the wind that walks up the Low Road.',
];

/** Sitting down on a bench: one line each time, cycling. */
export const SIT_LINES: readonly string[] = [
  'You sit. The old bench holds you the way a good bench does, without comment.',
  'You sit a while. The square does its slow work around you, and your head clears.',
  'You sit. Wood, iron and lamplight, all holding still together.',
];

/** Sitting on a placed seat at home (src/game/seats.ts): one line each time, cycling, per piece. */
export const SEAT_LINES: Readonly<Record<string, readonly string[]>> = {
  'wooden-stool': [
    'You sit on the stool. Three legs, and not one of them wobbles.',
    'A short sit on a plain stool. Rest you made room for keeps best.',
  ],
  'reading-chair': [
    'You sink into the reading chair. The arms are worn exactly where hands go.',
    'The reading chair takes you in. The lamp hums. Nothing needs you for a while.',
  ],
};

/** The Empty Chair, placed: set for the ones the Tangle kept, and never sat in. */
export const EMPTY_CHAIR_LINE =
  'Set for the ones the Tangle kept, sap-gold cushion and all. You leave it empty, the way it’s meant to be.';

/** What a sign says, by speaker, cycling through its lines per read. */
export interface SignCopy {
  speaker: string;
  lines: readonly string[];
}

/**
 * Sign copy, keyed by what the sign is:
 * - `post`: the village signpost in the square (it leans; it always has).
 * - `route`: a route sign on the old lantern road.
 * - `milestone`: a road stone with the old route on its face.
 * - `gate:<from>:<to>`: the sign by an area exit, worded for its road.
 * Anything else falls back to `sign:generic` (see signCopy).
 */
export const SIGN_COPY: Record<string, SignCopy> = {
  post: {
    speaker: 'Village Signpost',
    lines: [
      'The square’s signpost leans three fingers off plumb. Fresh shovel-cuts at its foot: Orrin has reset it this spring. Same lean. Don’t ask.',
      'Arrows for the mill, the well and the east gate, all freshly painted. The arrow east has been touched most.',
    ],
  },
  route: {
    speaker: 'Route Sign',
    lines: [
      'A route sign on a leaning stone. A notch is cut at eye height, level with every fork on the road. Not woodpeckers. Woodpeckers can’t count.',
      'The Keeper’s mark is burned into the top corner: a wheel and a wave. It means the Hall promised this road would be kept.',
    ],
  },
  milestone: {
    speaker: 'Milestone',
    lines: [
      'A flat stone by the lane: TO SALLOW FORD, THE LOW ROAD. A punched toll token is set into its face, worn smooth.',
      'Another road stone, its numbers gone soft under the moss. The route still reads true, mile after missing mile.',
    ],
  },
  'gate:village:woodland': {
    speaker: 'Gate Sign',
    lines: [
      'East gate. The sign reads BRACKENWOOD PATH, repainted this spring. Under it, in old pencil: “back by dark, or bring a lamp.”',
      'Below the sign, bootprints in the mud go both ways. The woods give things back, and the village keeps sending things out.',
    ],
  },
  'gate:village:commons': {
    speaker: 'Gate Sign',
    lines: [
      'A hand-painted board: THE COMMONS. The lane of gates — and soup off the ledger for anyone working for the village.',
      'Someone has chalked the old saying under it: leave one for Ada. The gate is never latched.',
    ],
  },
  'gate:woodland:village': {
    speaker: 'Gate Sign',
    lines: [
      'The sign back to Hearthwick, arrow west. The moss on its post grows thickest where a lamp burned for years.',
      'Someone nailed a second board beside it: SOUP AT THE SQUARE, it says, for anyone working for the village.',
    ],
  },
  'gate:woodland:ruin': {
    speaker: 'Gate Sign',
    lines: [
      'A leaning sign marks the climb to Ashwatch. Someone has crossed out RUIN and written WAYSTATION. The crossing-out is older.',
      'Past this point the lamps went cold first. The moss on the sign is the only green that kept.',
    ],
  },
  'gate:ruin:woodland': {
    speaker: 'Gate Sign',
    lines: [
      'The way back, the sign says, arrow west. The letters face the village, as if the road expected you to look back.',
      'At the bottom, a short row of scratches, counted in fives. Someone passes here often, and wants the walk to stay remembered.',
    ],
  },
  'gate:commons:village': {
    speaker: 'Gate Sign',
    lines: [
      'The gate sign home: UPHILL TO HEARTHWICK. Somebody has added, smaller: mind the ladder.',
      'The hill up to the village, the sign says, as if the Commons were the valley’s own. Maybe, now, it is.',
    ],
  },
  'gate:commons:wilds': {
    speaker: 'Gate Sign',
    lines: [
      'The crossing. Past the last post the road is dark, and the Wilds drift. The ledger says the account is still open.',
      'Under the arrow, worn first of all the words: COUNT HOUSE. Whoever set this sign expected carts to log their loads.',
    ],
  },
  'sign:generic': {
    speaker: 'Sign',
    lines: [
      'A sign by the road, the letters neat. Where it points is only a rumor until you walk it.',
      'The letters are neat, the arrow true. Out here a sign is a kind of tending: someone stood here and told the road to stay.',
    ],
  },
};

/** The copy for a sign key, falling back to the plain sign for roads unlisted. */
export function signCopy(key: string): SignCopy {
  const copy = SIGN_COPY[key] ?? SIGN_COPY['sign:generic'];
  return { speaker: copy.speaker, lines: [...copy.lines] };
}

/** The next line in a pool, cycling — varied each press, repeating in time. */
export function nextLine(pool: readonly string[], count: number): string {
  return pool[count % pool.length];
}
