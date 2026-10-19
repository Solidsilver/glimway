/**
 * The open map's own words (docs/design/open-map.md 2.9) that aren't in
 * content/wilds.json `words` (the lines the server shares, like a way's
 * name): what clearing, laying and lifting say, the finder's lines, the
 * world map's words (docs/design/world-map.md), and Elara's talk around this wick's rumour. Short and
 * plain; the currency is glims, and nothing here costs any.
 */
import { rumourLines, type RumourParts } from '../lib/wilds/rumour.ts';

/** What the prompt and the buttons say for the path work. */
export const PATH_LABELS = {
  clear: { thicket: 'Clear the thicket', log: 'Clear the fallen trunk' } as Record<string, string>,
  clearVerb: 'Clear',
  lay: { stone: 'Lay stone', plank: 'Lay plank' } as Record<string, string>,
  lift: { stone: 'Lift the stone', plank: 'Lift the plank' } as Record<string, string>,
} as const;

/** What a finished piece of path work says (a thought, not a reward). */
export const PATH_DONE = {
  cleared: { thicket: 'Cleared. There’s a way through now.', log: 'The trunk rolls aside.' } as Record<string, string>,
} as const;

/**
 * Refusals in plain words, by the server's code (or the client's own check
 * before sending). `needTool`, `needMaterial`, `notOnWater` and the drift
 * come from content/wilds.json `words`.
 */
export const PATH_REFUSALS: Record<string, string> = {
  'already-cleared': 'That’s clear already.',
  'not-clearable': 'Nothing here a spade or an axe can shift.',
  'already-laid': 'There’s a path here already.',
  'cannot-lay-here': 'You can’t lay a path here.',
  'not-your-path': 'Someone else laid this. It’s theirs to lift.',
  'not-your-land': 'A lot lantern holds this land. Only the lot’s own folk change its ground.',
  'too-far-away': 'Step a little closer.',
  'not-in-wilds': 'Paths are for the Wilds.',
  'epoch-ended': 'The drift has turned. The land is new.',
  offline: 'Needs a connection. The land is shared, so the world has to hear it.',
  pending: 'The world hasn’t answered yet. The rest can wait until it does.',
  busy: 'One thing at a time.',
  unknown: 'That didn’t take. Try again in a moment.',
};

/** The confirm before a first lay on turning land this wick. */
export const TURNS_CONFIRM = {
  title: 'Lay a path here?',
  yes: 'Lay it',
  no: 'Not here',
  /** On land a lot lantern holds (roadmap 0.12): it keeps while the lantern burns. */
  held: 'This land holds while the lantern burns. A path here stays with it; if the lantern goes dark, its stone or timber waits for you at Pell’s.',
} as const;

/** "Found by <name>" and the first finder's lines (open-map.md 2.10). */
export const FINDS = {
  /** A toast when you reach a place someone else found first this wick. */
  foundBefore: '{name} got here first this wick.',
  /** A toast when you're first but the find was empty. */
  firstEmpty: 'Nobody has been here this wick. It’s yours on the map until the turning.',
  /** The rumour's bundle. */
  bundleClosed: 'Open the bundle',
  bundleVerb: 'Open',
  bundleOpened: 'Someone tucked this here for whoever came looking.',
  bundleEmpty: 'The bundle is open and empty. You were here.',
  bundleLook: 'Look at the bundle',
} as const;

/** A way sign's prompt. */
export const WAY_SIGN = {
  look: 'Read the sign',
  verb: 'Read',
} as const;

/** The world map (world-map.md; its land and marks are open-map.md 2.8's). */
export const MAP_LABELS = {
  heading: 'World map',
  title: 'Walked land',
  loading: 'Unfolding the map…',
  empty: 'You haven’t walked the Wilds this wick. Go out through the Commons gate.',
  offline: 'The map fills in as you walk. It needs the Wilds read once this session.',
  guest: 'The map shows the Wilds you walk. It needs a connected world.',
  offlineNow: 'Offline — showing the land already read.',
  partial: 'Some land couldn’t be read just now. It’s blank until it can be.',
  ended: 'The wick has turned. Only the Tangle is shown until the Wilds are read again.',
  outside: 'You’re outside the Wilds. The map opens at the Commons gate.',
  noCentre: 'You’re not in the Wilds, so there’s nobody to centre on.',
  retry: 'Try again',
  you: 'You',
  gate: 'Commons gate',
  frontier: 'The Whitequiet’s edge',
  road: 'The Lantern Road',
  river: 'The Wend',
  ways: 'Ways',
  places: 'Places',
  noWays: 'No ways yet this wick. Lay stone from one place to another and it gets a name.',
  between: 'from {from} to {to}',
  seen: 'Seen from afar',
  foundBy: 'Found by {name}',
  foundByLegend: 'Found by…',
  onMap: 'You’re on the map.',
  noPlaces: 'none yet.',
  notFound: 'Not found yet',
  wick: 'Walked this wick. The Beyond turns at the wick; the Tangle stays.',
  legend: 'Legend',
  keys: 'Arrow keys or WASD move the map (Shift for further), + and − zoom, Home centres on you, End shows it all. M or Escape closes it.',
  controls: 'Map controls',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  centre: 'Centre on me',
  showAll: 'Show all',
  details: 'Details',
  close: 'Close the map',
  centred: 'Centred on you.',
  atGate: 'At the Commons gate.',
  shownAll: 'Showing all the land you know.',
  zoom: 'Zoom {pct}%',
  legendWalked: 'Walked land',
  legendBlank: 'Not walked yet',
  legendBeyond: 'Past the Whitequiet’s edge',
} as const;

/**
 * Elara's talk around the rumour (open-map.md 2.10, decision 19): she rode
 * the drift from the Saltings, and she hears things. The rumour itself is
 * built from content/wilds.json `rumour`.
 */
export const ELARA_RUMOUR = {
  ask: 'Heard anything from the drift?',
  /** Before the rumour, in her voice. */
  lead: [
    'A carter came in off the drift road this morning. They always talk.',
    'I had it from a Saltings hand, and they don’t lie about the drift.',
    'Field note, unverified. Don’t tell Mara I said unverified.',
  ],
  /** After the rumour. */
  after: 'It won’t keep past the turning. Nothing out there does.',
  /** The wick has turned and this wick's word hasn't reached her yet (the state not read again since). */
  turned: 'The drift’s only just turned. Whatever I’d heard is under new land now. Ask me again in a little while.',
} as const;

/** Area cards for the open map's new land (src/content/world.ts). */
export const OPEN_MAP_CARDS = {
  beyond: {
    name: 'The Wilds',
    eyebrow: 'Out past the old drift',
    tagline: 'New land every wick, as far as the drift lets you go.',
    description: 'Woods that were not here last wick and will be gone by the next. Paths you lay out here go when the land turns. The Lantern Road stays.',
  },
  meadow: {
    name: 'The meadow',
    eyebrow: 'Out past the old drift',
    tagline: 'Open grass, stone, and a lone tree here and there.',
    description: 'Where the woods thin out. Good for fiber and stone, poor for timber. It turns at the wick with the rest of the land out here.',
  },
  wend: {
    name: 'The Wend',
    eyebrow: 'The river',
    tagline: 'Wide and dark. Cross at a ford.',
    description: 'The river runs south toward the mill. Where a path meets it there is a ford of stepping stones; wading is slow. It keeps its bed; the land along it turns every wick.',
  },
} as const;

/** What a lay or a lift says when it makes or breaks a named way (decision 23). */
export const WAY_NEWS = {
  made: 'The path joins {from} and {to}. It’s {way} now.',
  broken: '{way} is broken. Close the gap and it joins again.',
  rerouted: '{way} goes round the gap now.',
} as const;

/**
 * Elara's "Heard anything from the drift?" choice (open-map.md 2.10), for
 * her talk in the library: this wick's rumour between her own lines, her
 * line once you've found it, or that nothing has reached her. `rumour` is
 * the server's (`PlayerState.rumour`), null when there is none.
 */
export function elaraRumourChoice(rumour: (RumourParts & { epoch: string }) | null | 'turned'): { text: string; reply: string[] } {
  // Never a place from the last wick: until this wick's is read, she says it has turned.
  if (rumour === 'turned') return { text: ELARA_RUMOUR.ask, reply: [ELARA_RUMOUR.turned] };
  const said = rumourLines(rumour);
  if (!rumour || said.found) return { text: ELARA_RUMOUR.ask, reply: [said.text] };
  // Her way in changes with the wick, and holds still within one.
  let h = 0;
  for (const ch of rumour.epoch) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const lead = ELARA_RUMOUR.lead[h % ELARA_RUMOUR.lead.length]!;
  return { text: ELARA_RUMOUR.ask, reply: [lead, said.text, ELARA_RUMOUR.after] };
}
