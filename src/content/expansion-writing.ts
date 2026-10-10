/**
 * Lore Spine (canon: docs/lore/chronicle.md):
 * The Hearthwick Commons, past the east gate, were the carters' staging ground for the Lantern Road. Thirty-one years ago Keeper
 * Wenna Hale closed the road under the mark (two weaves and a break); six went out under it anyway, and the cart that should have
 * come home never did. Every Carting Day a polished hame hangs on the Commons gate for it. Now the Commons are being taken up as
 * homesteads, and Silas, who was meant to drive the seventh cart, builds the houses.
 * Beyond lie the Wilds. They are not cursed; they drift, because the land forgets what it isn't reminded of. The outer Wilds turn
 * on a schedule the Keeper posts a day ahead, and at a turning they give back what they were keeping: objects meant to come home.
 * Glims hold light, and lamps are kept by naming them.
 */

import type { LocationInfo, Dialogue } from './world.ts';

export interface BuilderNPC {
  name: string;
  bio: string;
  dialogue: {
    firstMeeting: Dialogue;
    offerCampsite: Dialogue;
    sellDecorations: Dialogue;
    notEnoughGlims: Dialogue;
    afterUpgrade: Dialogue;
    idleLines: string[];
  };
}

export interface HomesteadTier {
  id: string;
  name: string;
  blurb: string;
}

export interface Decoration {
  id: string;
  name: string;
  blurb: string;
  category: 'furniture' | 'decor' | 'utility';
  footprint: [number, number];
}

export interface POI {
  id: string;
  name: string;
  discoveryText: string;
}

export interface Trinket {
  id: string;
  name: string;
  blurb: string;
}

export interface Material {
  id: string;
  name: string;
  blurb: string;
  harvestVerb: string;
}

export interface WildsInner {
  id: string;
  location: LocationInfo;
}

export interface FallenHeroLanterns {
  leftBehind: string;
  relitByFriend: string;
  yourOwnLantern: string;
}

export interface Project {
  id: string;
  name: string;
  open: string;
  inProgress: string;
  complete: string;
}


// 1. Hearthwick Commons
export const HEARTHWICK_COMMONS: LocationInfo = {
  name: 'Hearthwick Commons',
  eyebrow: 'East of the village gate',
  tagline: 'A polished hame hangs on the gate. Nobody takes it down.',
  description: 'A wide clearing of tall grass and stumps past the east gate, where carters once staged for the lantern road. Every Carting Day a polished hame is hung on the Commons gate for the cart that never came home.'
};

export const BUILDER_NPC_DATA: BuilderNPC = {
  name: 'Silas',
  bio: 'A retired carter who limps on his left knee and carves a fox for every new door, long ear on the left.',
  dialogue: {
    firstMeeting: {
      speaker: 'Silas',
      lines: [
        'Well now, a neighbour. I drove the lantern road twenty years. Was meant to drive the last run, too. Knee gave out at the fork. Now I build roofs.',
        'Clear yourself a plot and I\'ll help you lay the skids. No deep footings, mind. Out here a house sits on the land like a barge sits on a river.'
      ]
    },
    offerCampsite: {
      speaker: 'Silas',
      lines: [
        'A good camp wants a level hearth, a windbreak, a cot up off the ground, and a lamp you\'ve named. I\'ll set it up if you\'ve the warmth to spare.'
      ]
    },
    sellDecorations: {
      speaker: 'Silas',
      lines: [
        'Got a few pieces finished if you want the place looking lived-in. Pegged, not nailed. Iron goes at the Hall price these days.'
      ]
    },
    notEnoughGlims: {
      speaker: 'Silas',
      lines: [
        'You\'re a few glims short for that one, neighbour. The wood will wait. Wood\'s good at waiting.'
      ]
    },
    afterUpgrade: {
      speaker: 'Silas',
      lines: [
        'There. Steady as a route stone, and she\'ll creak come autumn, which is how you know she\'s living. Go on in. Tell me what you think.'
      ]
    },
    idleLines: [
      'Measure twice, cut once, and complain about the saw. Orrin skips the first two.',
      'Every door gets a fox over the lintel, so the house remembers you. Old carter\'s custom. Not mine. I just kept it.',
      'Orrin thinks he knows joints. Orrin knows nothing about joints.',
      'Green wood sinks, dry wood sings. Don\'t hurry a roof.',
      'Carting Day soon. They\'ll hang the hame on the gate again. I polish it the night before. Somebody has to.',
      'Knee\'s grumbling. Weather, likely. Don\'t mind it.'
    ]
  }
};

export const SIGN_FORMAT = "{name}'s Place";

// 2. Homestead tiers
export const HOMESTEAD_TIERS: HomesteadTier[] = [
  { id: 'tier-0', name: 'Campsite', blurb: 'A levelled patch with a stone fire ring, a canvas cot up on blocks (never sleep on bare ground), and a lamp post.' },
  { id: 'tier-1', name: 'Cottage', blurb: 'One room on four iron-oak skids, pegged not nailed, with slate on top and a fox over the door.' },
  { id: 'tier-2', name: 'Workshop', blurb: 'Deep eaves over a heavy bench, a rack for clean tools, and a chest that doesn\'t drink the damp.' },
  { id: 'tier-3', name: 'Garden', blurb: 'Raised beds inside the lamp\'s light, where the herbs stay where you planted them.' },
  { id: 'tier-4', name: 'Hall', blurb: 'A proper home: a long table, warm hearths, and floors that creak every autumn, as they should.' }
];

// 3. Decorations
/** Silas's words for the buildings in his yard (content/homestead.json's `building` rows). */
export const BUILDING_BLURBS: Record<string, string> = {
  stable: 'Timber walls, a tack room and one bay with a half door. Your mounts stand here between rides, and it grows a stall at a time.'
};

export const DECORATIONS_GLIMS: Decoration[] = [
  { id: 'wooden-stool', name: 'Wooden Stool', blurb: 'Three uneven legs, perfectly balanced. Silas swears he meant it.', category: 'furniture', footprint: [1, 1] },
  { id: 'reading-chair', name: 'Reading Chair', blurb: 'Overstuffed, a little frayed, and exactly the right distance from the lamp.', category: 'furniture', footprint: [1, 2] },
  { id: 'braided-rug', name: 'Braided Rug', blurb: 'Thick wool in old Carting colours, smelling faintly of lavender.', category: 'decor', footprint: [2, 2] },
  { id: 'iron-lantern', name: 'Iron Lantern', blurb: 'A small indoor lamp with a clean wick. Tell it what it holds, and it holds it.', category: 'decor', footprint: [1, 1] },
  { id: 'oak-table', name: 'Oak Table', blurb: 'Windfall oak, three leafy branches left at the stump. Scrubbed smooth by years of spilled tea.', category: 'furniture', footprint: [2, 2] },
  { id: 'potted-fern', name: 'Potted Fern', blurb: 'Thriving despite being ignored. Ferns don\'t wander. They sulk.', category: 'decor', footprint: [1, 1] },
  { id: 'bookshelf', name: 'Short Bookshelf', blurb: 'Holds exactly twelve field journals: one for every wick of the year.', category: 'furniture', footprint: [2, 1] },
  { id: 'wash-basin', name: 'Wash Basin', blurb: 'Cold Wend water. Wakes you faster than any rooster.', category: 'utility', footprint: [1, 1] }
];

export const DECORATIONS_MATERIAL: Decoration[] = [
  { id: 'lantern-post', name: 'Lantern Post', blurb: 'Squared oak, an amber lamp on the crossbar. Set it at the edge of your light and give it a name: land only stays put where a named lamp holds it. Each one costs more than the last.', category: 'utility', footprint: [1, 1] },
  { id: 'stone-hearth', name: 'Stone Hearth', blurb: 'Quarried stone, never drift-stone, or it steps into the kitchen while you sleep. Keeps a glow till morning.', category: 'utility', footprint: [2, 1] },
  { id: 'carved-bed', name: 'Carved Bed', blurb: 'Raised well off the floor and stuffed with hay and dried mint. Sleep high.', category: 'furniture', footprint: [2, 2] },
  { id: 'woven-basket', name: 'Woven Basket', blurb: 'For spare bootlaces, twine, and whatever the Wilds hand back.', category: 'decor', footprint: [1, 1] },
  { id: 'display-stand', name: 'Display Stand', blurb: 'Show off your favourite whittled fox. Check which ear is the long one.', category: 'furniture', footprint: [1, 1] },
  { id: 'tool-rack', name: 'Tool Rack', blurb: 'Clean your tools. Rust is just iron forgetting it is a saw.', category: 'decor', footprint: [2, 1] },
  { id: 'amber-sconce', name: 'Amber Sconce', blurb: 'Candle-grade amber that keeps the light a few minutes after the flame is out.', category: 'decor', footprint: [1, 1] }
];

// 4. The Wilds
export const WILDS_INNER: WildsInner = {
  id: 'inner-1',
  location: {
    name: 'The Tangle',
    eyebrow: 'Just past the Commons',
    tagline: 'The scar of a stormy night. The paths keep their own hours.',
    description: 'Iron-oak roots and sudden drops, torn up by a fast drift thirty years ago. The old road ran through here once. Now the ground moves when nobody is watching it.'
  }
};

export const POIS: POI[] = [
  { id: 'old-shrine', name: 'Old Shrine', discoveryText: 'A mossed stone shrine where a lamp once stood. The iron-oak around it grew tight-ringed: the land still remembers being held still here.' },
  { id: 'waystone', name: 'Fallen Waystone', discoveryText: 'Half-sunk in the soil, its direction weave worn smooth. It points squarely into an oak tree, which was not there when the stone was cut.' },
  { id: 'frozen-pond', name: 'Frozen Pond', discoveryText: 'Cloudy ice, thick even in summer. Under it, a carter\'s work glove, taken off for a fiddly job and never fetched. The pond is keeping it cold for someone.' },
  { id: 'abandoned-cart', name: 'Abandoned Cart', discoveryText: 'Its axle isn\'t worn through. It\'s grown through: one root, one stormy night. The cargo is gone, and the tail-board was latched shut behind it.' },
  { id: 'mossy-arch', name: 'Mossy Arch', discoveryText: 'Two great stones leaning together over a path the woods took back. A lamp hook still hangs at the top. Someone trimmed a wick here every night, once.' }
];

/** Objects the Wilds give back at a turning. Ids match content/wilds.json (the generator drops these). */
export const TRINKETS: Trinket[] = [
  { id: 'whittled-fox', name: 'Whittled Fox', blurb: 'A carter\'s door-fox in soft pine, one ear carved longer than the other. Meant for a lintel somewhere.' },
  { id: 'beeswax-candle', name: 'Beeswax Candle', blurb: 'Never lit, saved for a birthday. The Wilds kept it a long while. Now they\'ve handed it back.' },
  { id: 'river-glass-bead', name: 'River Glass Bead', blurb: 'Frosted green glass off a carter\'s harness, tumbled smooth. The Wend brings down what the first frost throws.' },
  { id: 'spare-bootlace', name: 'Spare Bootlace', blurb: 'Waxed leather, still knotted in the double hitch runners use, as if the boot came off a moment ago.' },
  { id: 'tin-whistle', name: 'Tin Whistle', blurb: 'Dented to one clear note. Runners dent their whistles until the note is theirs. Whose note this was, nobody says.' }
];

/**
 * More objects the Wilds give back, written for the canon (a work glove,
 * Tam's knotted ox-halter, eleven stamped road-nails). Not in
 * content/wilds.json yet, so the generator never drops them: adding them
 * there changes the Go parity vectors.
 */
export const MORE_TRINKETS: Trinket[] = [
  { id: 'work-glove', name: 'Work Glove', blurb: 'Taken off for a fiddly job and never fetched. It still holds the shape of the hand that left it.' },
  { id: 'knotted-halter', name: 'Knotted Ox-Halter', blurb: 'Rope worked in a patient, talkative knot, the kind a driver ties while chatting to the oxen.' },
  { id: 'road-nails', name: 'Stamped Road-Nails', blurb: 'Eleven iron nails, each stamped with the wheel and wave. Lantern-post nails. Eleven exactly.' }
];

export const MATERIALS: Material[] = [
  { id: 'timber', name: 'Timber', blurb: 'Windfall, mostly. Leave three leafy branches at every stump, as the custom runs.', harvestVerb: 'Chop' },
  { id: 'stone', name: 'Stone', blurb: 'Flat quarry stone for footings and hearths. Never drift-stone for a wall.', harvestVerb: 'Gather' },
  { id: 'fiber', name: 'Fiber', blurb: 'Bracken and bark-strip, tough enough to weave.', harvestVerb: 'Cut' },
  { id: 'amber', name: 'Amber', blurb: 'Sap the woods have let go of. Amber is the woods\' own memory, set hard and glowing.', harvestVerb: 'Pry' }
];

/** Walking into a camp in the Wilds: echoes of people waiting. */
export const CAMP_WALK_IN_LINES = [
  'A kettle on a cold fire, still waiting to boil.',
  'A cot raised on stone blocks, the way the pamphlets tell you.',
  'Someone sat here long enough to whittle. Pine shavings, all curled the same way.',
  'A quiet spot. The woods are holding their breath.'
];

export const CHEST_OPEN_FLAVOR = [
  'The lid groans on oak pegs. Nobody out here paid the Hall price for hinges.',
  'A puff of amber dust as the latch gives way.',
  'Something wrapped in oilcloth shifts inside.'
];

export const FALLEN_HERO_LANTERNS: FallenHeroLanterns = {
  leftBehind: 'A lantern lies cold here, dropped by a traveler who stumbled in the dark. Leave one for Ada, the saying goes.',
  relitByFriend: 'You trim the wick and light it. Never two dark in a row. They\'ll find their way back by it.',
  yourOwnLantern: 'Your own lantern, waiting where you fell. Someone kept the ground from taking it. Best pick it up.'
};

/** The Turning: the outer Wilds reshuffle on a schedule the Keeper posts a day ahead. */
export const SEASON_SHIFT_NOTICE = 'Posted on the notice board: the outer Wilds have turned. Cairn-walkers, clear your stones. Charts start fresh today.';

/** The notice posted the day before a turning; {wick} is the month (e.g. "Amber"). content/calendar.go writes the same text (vectors guard it). */
export const TURNING_NOTICE_FORMAT = 'Dark of {wick}-wick — the outer Wilds will turn.';

/** Carting Day (Cart-wick the 6th): a market now, and a hame on the gate. */
export const CARTING_DAY_NOTICE = 'Carting Day. Stalls on the Commons, twists at the bakery, and a polished hame on the gate for the cart that never came home.';

// 5. New lines for existing NPCs (Mara, Pip, Orrin)
export const NEW_NPC_LINES: Record<string, string[]> = {
  mara: [
    'I hear you\'ve claimed a plot in the Commons. Gran used to say a road is only kept if people live along it.',
    'The outer Wilds turned again. They give things back at a turning, things meant to come home. Bring me anything with a name on it.',
    'If you find route stones out in the Tangle, leave them standing and tell me where. I\'ll write it in pencil. Ink is for what\'s done.'
  ],
  pip: [
    'I ran out to see your place! Tripped on a root, mud to the knees, worth it. Your door is on the Pencil Map now. In pencil. Obviously.',
    'Did you know the hills move when nobody\'s looking? Ashwatch hill went four hand-spans since Mudrise. I measured. Elara checked my figures.',
    'If you need messages run to your cottage, my rate is one whittled fox. Silas\'s, preferably. I can tell the year by the ears.'
  ],
  orrin: [
    'Building in the Commons? Don\'t dig deep. Level the topsoil, lay iron-oak skids, peg it. If the floor doesn\'t creak in autumn, it\'s too tight.',
    'Silas is doing your timber? Hm. He\'s slow, but his joints are passable. Barely. Tell him I said barely.',
    'If the Wilds keep shifting, someone will have to build a bridge that walks back to its place. Don\'t look at me. ...Don\'t look at me like that.'
  ]
};

// 6. Village projects
export const VILLAGE_PROJECTS: Project[] = [
  {
    id: 'north-bridge',
    name: 'Repair the north bridge',
    open: 'The north bridge over the creek is rotted through. Orrin wants iron-oak and quarried stone, and he wants them before he changes his mind.',
    inProgress: 'The footings are set, pegged, and complained about. A little more timber and the deck is done.',
    complete: 'The north bridge stands on iron-oak and good stone again. Orrin walked it twice and said "hm," which is high praise.'
  },
  {
    id: 'well-canopy',
    name: 'Build a well canopy',
    open: 'Leaves keep falling in the village well. A slate canopy before Amber-wick, Mara says, or it\'s leaf soup for everyone.',
    inProgress: 'The frame is up and creaks properly. A few more materials for the slates.',
    complete: 'The well has its canopy. Orrin cut a mark into the lintel that means "here." He says it leans only slightly.'
  },
  {
    id: 'mill-wheel',
    name: 'Reinforce the mill wheel',
    open: 'The Wend is running high and the mill wheel is groaning. Finn is counting its turns again. Timber and fiber to lash it tight.',
    inProgress: 'Half the paddles are lashed. Finn is down to counting every other turn. Keep it coming before the next stir.',
    complete: 'The wheel turns smooth and quiet. "Forty-one and holding," Finn says, and for once he sounds pleased about it.'
  }
];
