/**
 * Lore Spine:
 * The Hearthwick Commons were once the bustling staging ground for the lantern road, where carters and travelers set up camp before heading into Brackenwood. Now, they are being reclaimed as homesteads. 
 * Beyond the old routes lie the Wilds: untamed, overgrown tracks that shift and weave with the seasons as the magic of the deep woods responds to the weather. Mara's grandmother, the last active lantern keeper, used to chart these shifting paths from the Ashwatch ruin to keep the road safe, but since her time the Wilds have grown thick, swallowing old shrines and campsites alike.
 */

import type { LocationInfo, Dialogue } from './world.ts';

export interface BuilderNPC {
  name: string;
  bio: string;
  dialogue: {
    firstMeeting: Dialogue;
    offerCampsite: Dialogue;
    sellDecorations: Dialogue;
    notEnoughEmbers: Dialogue;
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
  tagline: 'Quiet plots of land waiting to be cleared.',
  description: 'A wide clearing of tall grass and stumps just east of the village gate. Old wagon ruts suggest this used to be a staging ground for the lantern road.'
};

export const BUILDER_NPC_DATA: BuilderNPC = {
  name: 'Silas',
  bio: 'A retired carter with a bad knee and a good eye for timber.',
  dialogue: {
    firstMeeting: {
      speaker: 'Silas',
      lines: [
        'Well now, a traveler settling down. I used to drive carts through here before the road closed. Now I mostly turn good timber into better roofs.',
        'If you want to clear a plot, I can help you lay the stones.'
      ]
    },
    offerCampsite: {
      speaker: 'Silas',
      lines: [
        'A good campsite needs a level hearth and windbreak. I can set that up for you if you have the warmth to spare.'
      ]
    },
    sellDecorations: {
      speaker: 'Silas',
      lines: [
        'Got a few pieces finished if you want to make the place look lived-in. Sturdy work, no rushing.'
      ]
    },
    notEnoughEmbers: {
      speaker: 'Silas',
      lines: [
        'You are a bit short on warmth for that one. Come back when you have a few more embers to spare.'
      ]
    },
    afterUpgrade: {
      speaker: 'Silas',
      lines: [
        'There it is. Solid as a route stone. Take a look inside, tell me what you think.'
      ]
    },
    idleLines: [
      'Measure twice, cut once, and complain about the saw.',
      'Weather is holding up, good day for a roof.',
      'Orrin thinks he knows joints. Orrin knows nothing about joints.'
    ]
  }
};

export const SIGN_FORMAT = "{name}'s Place";

// 2. Homestead tiers
export const HOMESTEAD_TIERS: HomesteadTier[] = [
  { id: 'tier-0', name: 'Campsite', blurb: 'A leveled patch of dirt with a stone fire ring and a canvas bedroll.' },
  { id: 'tier-1', name: 'Cottage', blurb: 'A sturdy one-room timber frame with a slate roof and a real door.' },
  { id: 'tier-2', name: 'Workshop', blurb: 'Expanded eaves covering a heavy crafting bench and a storage chest.' },
  { id: 'tier-3', name: 'Garden', blurb: 'Tilled earth and raised beds where useful things grow in the sun.' },
  { id: 'tier-4', name: 'Hall', blurb: 'A proper home with polished floors, warm hearths, and a trophy wall.' }
];

// 3. Decorations
export const DECORATIONS_EMBER: Decoration[] = [
  { id: 'wooden-stool', name: 'Wooden Stool', blurb: 'Three uneven legs, perfectly balanced.', category: 'furniture', footprint: [1, 1] },
  { id: 'reading-chair', name: 'Reading Chair', blurb: 'Overstuffed and slightly frayed at the edges.', category: 'furniture', footprint: [1, 2] },
  { id: 'braided-rug', name: 'Braided Rug', blurb: 'Thick wool, smelling faintly of lavender.', category: 'decor', footprint: [2, 2] },
  { id: 'iron-lantern', name: 'Iron Lantern', blurb: 'A small indoor lamp with a clean wick.', category: 'decor', footprint: [1, 1] },
  { id: 'oak-table', name: 'Oak Table', blurb: 'Scrubbed smooth by years of spilled tea.', category: 'furniture', footprint: [2, 2] },
  { id: 'potted-fern', name: 'Potted Fern', blurb: 'Thriving despite being ignored.', category: 'decor', footprint: [1, 1] },
  { id: 'bookshelf', name: 'Short Bookshelf', blurb: 'Holds exactly twelve field journals.', category: 'furniture', footprint: [2, 1] },
  { id: 'wash-basin', name: 'Wash Basin', blurb: 'Cold water wakes you up faster.', category: 'utility', footprint: [1, 1] }
];

export const DECORATIONS_MATERIAL: Decoration[] = [
  { id: 'stone-hearth', name: 'Stone Hearth', blurb: 'Keeps the embers burning until morning.', category: 'utility', footprint: [2, 1] },
  { id: 'carved-bed', name: 'Carved Bed', blurb: 'Stuffed with fresh hay and dried mint.', category: 'furniture', footprint: [2, 2] },
  { id: 'woven-basket', name: 'Woven Basket', blurb: 'Good for holding spare bootlaces.', category: 'decor', footprint: [1, 1] },
  { id: 'display-stand', name: 'Display Stand', blurb: 'Show off your favorite whittled fox.', category: 'furniture', footprint: [1, 1] },
  { id: 'tool-rack', name: 'Tool Rack', blurb: 'A place for everything, everything in its place.', category: 'decor', footprint: [2, 1] },
  { id: 'amber-sconce', name: 'Amber Sconce', blurb: 'Casts a warm, golden light on the walls.', category: 'decor', footprint: [1, 1] }
];

// 4. The Wilds
export const WILDS_INNER: WildsInner = {
  id: 'inner-1',
  location: {
    name: 'The Tangle',
    eyebrow: 'Just past the Commons',
    tagline: 'The woods grow quickly when left alone.',
    description: 'A dense stretch of ancient roots and sudden drops. The trees here are older than Hearthwick, and the paths rarely stay put.'
  }
};

export const POIS: POI[] = [
  { id: 'old-shrine', name: 'Old Shrine', discoveryText: 'A crumbling stone altar covered in moss. Someone left a small offering of acorns here a very long time ago.' },
  { id: 'waystone', name: 'Fallen Waystone', discoveryText: 'Half-buried in the soil, its directional markings worn smooth by rain. It points squarely into an oak tree.' },
  { id: 'frozen-pond', name: 'Frozen Pond', discoveryText: 'The ice is thick and cloudy all year round. A carter\'s glove is perfectly preserved near the center, lost during a sudden frost.' },
  { id: 'abandoned-cart', name: 'Abandoned Cart', discoveryText: 'Its axle is split, and the canvas is rotted. The carters must have abandoned it when the road was first closed.' },
  { id: 'mossy-arch', name: 'Mossy Arch', discoveryText: 'Two massive stones leaning against each other. It frames a view of a path that the woods reclaimed decades ago.' }
];

export const CHARTED_BY_FORMAT = 'Charted by {name}';

export const TRINKETS: Trinket[] = [
  { id: 'whittled-fox', name: 'Whittled Fox', blurb: 'Carved from soft pine, its ears are slightly lopsided.' },
  { id: 'beeswax-candle', name: 'Beeswax Candle', blurb: 'Smells of honey and old dust. Never been lit.' },
  { id: 'river-glass-bead', name: 'River Glass Bead', blurb: 'Frosted green glass, smoothed by years of tumbling water.' },
  { id: 'spare-bootlace', name: 'Spare Bootlace', blurb: 'Leather, rubbed with wax to keep the water out.' },
  { id: 'tin-whistle', name: 'Tin Whistle', blurb: 'Dented on one side. It still plays a clear, piercing note.' }
];

export const MATERIALS: Material[] = [
  { id: 'timber', name: 'Timber', blurb: 'Sturdy lengths of seasoned wood.', harvestVerb: 'Chop' },
  { id: 'stone', name: 'Stone', blurb: 'Heavy, flat rocks suitable for building.', harvestVerb: 'Gather' },
  { id: 'fiber', name: 'Fiber', blurb: 'Tough stems and vines that can be woven.', harvestVerb: 'Cut' },
  { id: 'amber', name: 'Amber', blurb: 'Hardened tree sap with a deep golden glow.', harvestVerb: 'Pry' }
];

export const CAMP_WALK_IN_LINES = [
  'Someone left in a hurry.',
  'The ashes are still slightly warm.',
  'A quiet spot to catch your breath.',
  'Wind whistles through the abandoned tents.'
];

export const CHEST_OPEN_FLAVOR = [
  'The lid groans on rusty hinges.',
  'A puff of dust escapes as the lock gives way.',
  'Something shiny clatters inside.'
];

export const FALLEN_HERO_LANTERNS: FallenHeroLanterns = {
  leftBehind: 'A cold lantern lies here, dropped by a traveler who stumbled in the dark.',
  relitByFriend: 'You sparked the wick. The warm light will help them find their way back.',
  yourOwnLantern: 'Your own lantern, waiting where you fell. Best pick it up.'
};

export const SEASON_SHIFT_NOTICE = 'The wind changes direction sharply. The outer Wilds have shifted.';

// 5. New lines for existing NPCs (Mara, Pip, Orrin)
export const NEW_NPC_LINES: Record<string, string[]> = {
  mara: [
    'I hear you have claimed a plot in the Commons. Grandmother always hoped people would settle past the gate again.',
    'The Wilds beyond your home are restless. The old routes shift every season, just like the stories say.',
    'If you find any route stones out in the Tangle, leave them be. They belong to the woods now.'
  ],
  pip: [
    'I ran out to the Commons to see your place! I tripped over a root and got mud on my knees, but it was worth it.',
    'Did you know the trees in the Wilds actually move when you are not looking? I swear they do!',
    'If you need messages run to your new cottage, my fee is one whittled fox.'
  ],
  orrin: [
    'So you are building in the Commons. Ensure your foundation is deep, or the frost will heave it right over.',
    'Silas is doing your timber work? Hm. He is slow, but his joints are passable. Barely.',
    'If the Wilds keep shifting, someone is going to need to build a bridge that moves. Do not look at me.'
  ]
};

// 6. Village projects
export const VILLAGE_PROJECTS: Project[] = [
  {
    id: 'north-bridge',
    name: 'Repair the north bridge',
    open: 'The old timber bridge across the north creek is rotted through. We need strong wood and stone to rebuild the span.',
    inProgress: 'The stone footings are set. We just need a little more timber to finish the deck.',
    complete: 'The north bridge is solid oak and stone again. Carters can finally cross safely.'
  },
  {
    id: 'well-canopy',
    name: 'Build a well canopy',
    open: 'Leaves keep falling into the village well. We need to build a proper slate roof over it before autumn.',
    inProgress: 'The frame is up. Just needs a few more materials for the slate shingles.',
    complete: 'The well has a sturdy new canopy. The water is clear, and Orrin says it only leans slightly.'
  },
  {
    id: 'mill-wheel',
    name: 'Reinforce the mill wheel',
    open: 'The river is running high and the mill wheel is groaning. We need extra timber and fiber to lash it tight.',
    inProgress: 'Half the paddles are reinforced. Keep bringing materials before the next storm.',
    complete: 'The mill wheel turns smoothly and quietly. The miller is very relieved.'
  }
];
