import type { AreaId, GameState, QuestStage } from '../lib/state.ts';
import { LANTERN_ROAD, QUESTS, reachedIndex, type QuestRecord } from '../lib/quests.ts';
import { SIGNPOST_BETWEEN } from './quests/signpost.ts';
import { EMBER_COSTS, XP_PER_EMBER, checkSpend, chestOpened, isLit, type RoadLanternId } from '../lib/embers.ts';
import { HEARTHWICK_COMMONS, WILDS_INNER } from './expansion-writing.ts';
import { WILDS_OUTER, echoKeepsakeJournalEntries } from './echoes.ts';
import { witnessJournalEntries } from './witness.ts';
import { residentJournal } from './residents.ts';
import { heirloomJournalEntries } from './heirlooms.ts';

export interface DialogueChoice {
  text: string;
  /** Lines the speaker answers with before the conversation closes. */
  reply?: string[];
  /** Something the world does when this choice is picked (e.g. an ember spend). */
  action?: string;
  /** Shown but not pickable (e.g. not enough embers); `note` says why. */
  disabled?: boolean;
  /** Small side text: a cost, or why the choice is unavailable. */
  note?: string;
  /** "Hear it again": plays `reply`, then offers the other choices again (src/content/talk.ts). */
  replay?: boolean;
  /** A plain goodbye: dropped when it would be the only choice left. */
  dismiss?: boolean;
}

export interface Dialogue {
  speaker: string;
  lines: string[];
  /**
   * Taken when the talk closes: one of the lantern road's scene events
   * (`accept`…), or a `quest:step` ref (./quests/index.ts).
   */
  event?: string;
  /** Optional replies offered after the last line; every choice keeps the event. */
  choices?: DialogueChoice[];
  /** Which rule spoke (its `quest:step` ref): "heard it" is remembered per rule (src/game/heard.ts). */
  key?: string;
}

export interface ItemInfo {
  name: string;
  icon: string;
  blurb: string;
}

export interface JournalEntry {
  title: string;
  body: string;
}

export interface LocationInfo {
  name: string;
  description: string;
  /** Small line above the name on the area title card. */
  eyebrow: string;
  /** One short, in-voice line for the title card. */
  tagline: string;
}

export interface DemoCharacter {
  name: string;
  class: string;
  level: number;
  stats: { str: number; int: number; con: number; per: number };
}

/**
 * Demo character: a classless wayfarer with a sensible starter kit. Local
 * play is gone; this stays only as the fallback look and stats until C2
 * rewires every reader to the server's profile (TODO(C2)).
 */
export const DEMO_CHARACTER: DemoCharacter = {
  name: 'Wren',
  class: 'Adventurer',
  level: 1,
  stats: { str: 9, int: 7, con: 8, per: 8 },
};

/** Display names and flavor for inventory ids (raw ids never reach the UI). */
export const ITEM_INFO: Record<string, ItemInfo> = {
  'field-journal': {
    name: 'Field Journal',
    icon: 'book',
    blurb: 'Half-full of other people’s roads, all in pencil. Out here the ground forgets; paper shouldn’t. Press J to read it.',
  },
  'hearthwick-map': {
    name: 'Map of Hearthwick',
    icon: 'map',
    blurb: 'Sketched in pencil by a Low Road carter, because ink lies within a season. The east gate is circled twice.',
  },
  // The id keeps its old name for save compatibility (and the server's
  // quest-item list); only the words changed.
  'lantern-route-rubbing': {
    name: 'Wenna’s Naming, Copied Out',
    icon: 'scroll',
    blurb: 'Copied from the Ashwatch route stone, beside the closure mark: “The road is closed here. Behind you the village, ahead the dark. Hold the break.” Turned round, it is a naming the warden can rest on.',
  },
  'ember-charm': {
    name: 'Ember Charm',
    icon: 'ember',
    blurb: 'A chip of hearth-grade amber in a twist of wire, still warm from the Ashwatch chest. Your strikes find the gaps more often.',
  },
};

/** Display names for discovery ids. */
const DISCOVERY_INFO: Record<string, ItemInfo> = {
  'route-marker': {
    name: 'The Faded Route Marker',
    icon: 'stone',
    blurb: 'A Brackenwood route stone furred with keeper’s moss, which only grows where a lamp burned for years. It still points at the hill.',
  },
  'old-route-marker': {
    name: 'The Closure Mark',
    icon: 'scroll',
    blurb: 'Two weaves and a break, and beside it Wenna’s naming: the road is closed here. The road was shut on purpose.',
  },
};

export function itemInfo(id: string): ItemInfo {
  return ITEM_INFO[id] ?? { name: titleCase(id), icon: 'sparkle', blurb: '' };
}

export function discoveryInfo(id: string): ItemInfo {
  return DISCOVERY_INFO[id] ?? { name: titleCase(id), icon: 'sparkle', blurb: '' };
}

function titleCase(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export const locations: Record<AreaId, LocationInfo> = {
  village: {
    name: 'Hearthwick',
    eyebrow: 'The village of',
    tagline: 'The land forgets what it isn’t reminded of. Hearthwick reminds it.',
    description:
      'A hillside village of patched slate roofs at the top of the Low Road. Every window keeps a lamp, and one has kept it lit all night for thirty years. The dark lantern road starts at the east gate.',
  },
  woodland: {
    name: 'Brackenwood Path',
    eyebrow: 'The old lantern road',
    tagline: 'Iron-oak shade, leaning route stones — and things that hop. Watch for the wind-up.',
    description:
      'A soft trail under iron-oak and bracken, where the lantern road once ran east toward Sallow Ford. Route stones lean in the moss, and the lamps on their posts have been cold for thirty years.',
  },
  ruin: {
    name: 'Ashwatch Ruin',
    eyebrow: 'Beneath the hilltop shrine',
    tagline: 'Something made of stone is still holding its pose.',
    description:
      'The Keeper’s old waystation: grey blocks, heather through the floor, a route stone in the alcove. Past the broken arch the hilltop shrine waits, and a stone warden stands on the path, arms out.',
  },
  commons: HEARTHWICK_COMMONS,
};

/**
 * Location info for any area id — including the generated ones (Wilds saves
 * report `wilds` and their `chunk:…` areas; the Commons before its own
 * entry). Unknown ids get a generic card, so a new area can never crash a
 * title or a banner.
 */
/**
 * The area id to name a save's place by: the outer Wilds (a `wilds` save past
 * the crossing) read as their own region, everything else as saved.
 */
export function displayArea(state: { area: AreaId; wildsRegion?: string }): AreaId {
  return state.area === 'wilds' && state.wildsRegion === 'outer-1' ? 'chunk:outer-1' : state.area;
}

export function areaInfo(areaId: AreaId): LocationInfo {
  const known = (locations as unknown as Record<string, LocationInfo | undefined>)[areaId];
  if (known) return known;
  if (areaId === 'commons') return HEARTHWICK_COMMONS;
  if (areaId === 'cottage') return { name: 'Cottage', eyebrow: 'Behind the Commons gates', tagline: 'Four skids, a slate roof, a fox over the door.', description: 'One room on iron-oak skids, pegged not nailed.' };
  const lot = /^home:(\d+)$/.exec(areaId);
  if (lot) return { name: `Lot ${Number(lot[1]) + 1}`, eyebrow: 'Behind the Commons gates', tagline: 'Wild land, held by lamplight.', description: 'Land past a Commons gate: trees, stumps and stones, and whatever the deed-holders have built where their lamps reach.' };
  if (areaId.startsWith('chunk:outer-')) return WILDS_OUTER.location;
  if (areaId === 'wilds' || areaId.startsWith('chunk:')) return WILDS_INNER.location;
  return { name: titleCase(areaId), eyebrow: 'Somewhere new', tagline: '', description: '' };
}

/**
 * A rule speaks when any of its `when` refs holds: `quest:step` when that's
 * the step the quest has reached, `quest:new` before it starts. Rules are
 * tried in order, so a later, wider rule catches what the earlier ones
 * don't (the lantern road's `new` after the opening's own).
 */
type DialogueRule = Dialogue & { when: string[] };

/** Does `ref` hold for this record (exactly that step reached; `:new` for none)? */
function whenHolds(ref: string, record: QuestRecord): boolean {
  const i = ref.indexOf(':');
  const quest = ref.slice(0, i);
  const step = ref.slice(i + 1);
  return step === 'new' ? record[quest] === undefined : record[quest] === step;
}

/**
 * NPC and interaction ids used by the runtime (docs/runtime-contract.md):
 * mara, pip, orrin, clue, lantern.
 * The quest event 'defeat-guardian' is fired by runtime encounter logic (the
 * warden settling), not by dialogue.
 *
 * Canon: docs/lore/chronicle.md. The first quest hints at the village's
 * secrets (Mara's unreadable last page, the crooked signpost, Pip's notches)
 * and reveals none of them.
 */
const DIALOGUE: Record<string, DialogueRule[]> = {
  mara: [
    {
      when: ['lantern-road:accepted'],
      speaker: 'Mara',
      lines: [
        "East gate, then the Brackenwood path. Follow the route stones. The moss on them grows where lamps burned, and Gran swore they still point true.",
        'If you get turned around, ask Pip. That child knows every shortcut, mostly because they have taken all of them.',
      ],
    },
    {
      when: ['lantern-road:clue-found'],
      speaker: 'Mara',
      lines: [
        'You copied the words off the Ashwatch stone. Two weaves and a break, and a naming in a Keeper’s hand.',
        'Gran drew that mark inside the ledger cover and never once said what it meant.',
        "So the road wasn't abandoned. She closed it. On purpose. ...Noted.",
        "There's a warden on the shrine path, Orrin says. Be careful up there. Careful, not slow.",
      ],
    },
    {
      when: ['lantern-road:guardian-defeated'],
      speaker: 'Mara',
      lines: [
        "You settled the warden? Orrin is going to pretend he never doubted you. He did. Loudly. Over breakfast.",
        "The shrine is past the arch. The flint should be on the ledge where it's always been. Light it. I want to see the hill the way she saw it.",
      ],
    },
    {
      when: ['lantern-road:lantern-lit'],
      speaker: 'Mara',
      lines: [
        "I can see it from here. A point of gold on the hill, right where her ledger says. Thirty years dark, and one traveler. I'm glad. I am.",
        "I just need to sit a minute. Then come find me in the square. I want all of it, from the beginning.",
      ],
      event: 'return-village',
    },
    {
      when: ['lantern-road:complete'],
      speaker: 'Mara',
      lines: [
        "The square hasn't looked like this in thirty years. Lamp on the post, and half the village pretending they aren't staying out late.",
        "Gran kept a line in the ledger: 'A road is a promise people keep renewing.' It took someone off the Low Road to renew it. Noted, Gran.",
        "There's a page at the back of her ledger I still can't read. Keeper's script. Not tonight. But I think I'm nearer to wanting to.",
      ],
    },
    {
      when: ['signpost:light-first-lamp'],
      speaker: 'Mara',
      lines: [
        "There's a lamp burning past the east gate, and I can see it from my crate. That one's yours. The village noticed. I noticed.",
        "My grandmother Wenna kept the lantern road east of here. The lamp on Ashwatch hill has been dark thirty years. Longer than I've been alive.",
        "I'd walk it myself, but the oil ledger doesn't keep itself. Would you go on? Past your lamp, the ruin, up to the shrine. Tell me what's left of it.",
      ],
      event: 'accept',
      choices: [
        {
          text: 'Of course. Point me at the gate.',
          reply: ['East gate, past the milestone. Thank you. Truly. And if you mark anything down, use pencil. The ground out there forgets.'],
        },
        {
          text: '…Is there a reward?',
          reply: [
            'Ha! A lit hill, a village in your debt, and as much of Orrin’s complaining as you can stand.',
            "Also soup. Soup's on the ledger for anyone working for the village. East gate, past the milestone.",
          ],
        },
      ],
    },
    {
      when: ['signpost:see-mara'],
      speaker: 'Mara',
      lines: [...SIGNPOST_BETWEEN.maraLamp],
    },
    {
      // The opening, before Orrin has sent you to her (and anything the rules above miss).
      when: ['lantern-road:new'],
      speaker: 'Mara',
      lines: [...SIGNPOST_BETWEEN.maraOpening],
    },
  ],
  pip: [
    {
      when: ['lantern-road:new'],
      speaker: 'Pip',
      lines: [
        "New face! I'm Pip Penhallow, runner. I run messages between the square and the mill, which is the fastest job in the world and also the only one.",
        "Going into Brackenwood? Don't eat the red berries. Not poison, they just taste like soap. And wash anything you pick. Foxes walk on it.",
      ],
    },
    {
      when: ['lantern-road:accepted'],
      speaker: 'Pip',
      lines: [
        "You're walking the old road! Halfway along there's a fallen oak with a notch cut in it. That's the fork. Take the uphill side.",
        "Someone cut notches at every fork out there, all the same height. Not woodpeckers. Woodpeckers can't count. They're on my Pencil Map.",
        'I would come with you, but I have a delivery, and also Mara gave me a look. You know the look.',
      ],
    },
    {
      when: ['lantern-road:clue-found'],
      speaker: 'Pip',
      lines: [
        "Two weaves and a break! And words! That's the skipping game. 'Warden, Warden, do not frown, say the words and sit down!'",
        "You don't run at it. That's how you get caught. Wait till it lunges and stops to find its feet, creep in close, and say the naming to the lamp in its chest.",
        "Hitting it is pointless, scientifically. It's not a monster, it's a jointed frame with a latch. I wrote that in my copybook. Orrin glared.",
      ],
    },
    {
      when: ['lantern-road:guardian-defeated'],
      speaker: 'Pip',
      lines: [
        "You settled it? It sat down? In the game the Leader has to groan and sit and be a stone. Did it groan? Please say it groaned.",
        'Go light the lantern. I want to see it from the mill roof. I want to see it from the moon, but the mill roof is a start.',
      ],
    },
    {
      when: ['lantern-road:lantern-lit'],
      speaker: 'Pip',
      lines: [
        "There's a light on the hill! There is a LIGHT on the HILL! Did it make a sound? Lanterns in stories always make a sound.",
        "I'm running the message route twice tonight just to look at it. Maybe three times. Don't tell Mara about the third time.",
      ],
    },
    {
      when: ['lantern-road:complete'],
      speaker: 'Pip',
      lines: [
        "People keep walking to the east gate to stand in the glow and pretend they're checking the fence. Nine so far. I'm counting for science.",
        "Mum says Uncle Joss dented his whistle so you could hear it across the square. Mine's still round. The right note hasn't found me yet.",
      ],
    },
  ],
  orrin: [
    {
      when: ['signpost:meet-orrin', 'signpost:fetch-finger'],
      speaker: 'Orrin',
      lines: [...SIGNPOST_BETWEEN.orrinFetching],
    },
    {
      when: ['signpost:bring-finger'],
      speaker: 'Orrin',
      lines: [...SIGNPOST_BETWEEN.orrinNoting],
    },
    {
      when: ['lantern-road:new'],
      speaker: 'Orrin',
      lines: [
        'Mind the shavings. Post’s holding: three fingers off plumb, east, the way it should be. Frost’ll have another go at it come spring. It always does.',
        "I'm Orrin. Built every bridge within a day of here, and complained about all of them. Here about the lantern road? Hm. Thought someone would come.",
      ],
    },
    {
      when: ['lantern-road:accepted'],
      speaker: 'Orrin',
      lines: [
        "There's a warden on the shrine path. Drift-stone. Not cruel. Dutiful, which is worse. It doesn't care who you are. It cares where it stands.",
        "Copy down what's cut on the route stone in the ruin before you climb. The words are the point. Anyone can swing a stick. The road wanted people who read.",
      ],
    },
    {
      when: ['lantern-road:clue-found'],
      speaker: 'Orrin',
      lines: [
        "Let me see that. Aye. That's the closure mark, not a direction mark. Two weaves and a break. Cut after the Winter of Two Storms. Shut on purpose.",
        "Don't bother hitting it. Stone doesn't mind. It's a lamp in a stone coat, and a lamp listens. Wenna told it the road is closed here.",
        "Tell it the road is held again. Up close, when it's stopped to find its feet. Say it plain.",
        "Mara's grandmother kept that mark in her ledger and never told a soul what it meant. Some people keep promises quietly. Annoying. Good, but annoying.",
      ],
    },
    {
      when: ['lantern-road:guardian-defeated'],
      speaker: 'Orrin',
      lines: [
        "Settled, is it. Thirty years on that path, and one traveler with a few good words and a stubborn jaw. I'm not impressed. I'm slightly impressed.",
        "...I'll go up tomorrow and look at it. Not to fuss. A man can look at his own — at a thing. Go on. Light the lamp.",
      ],
    },
    {
      when: ['lantern-road:lantern-lit'],
      speaker: 'Orrin',
      lines: [
        "There's a light on the hill. Don't make a thing of it. I'm not making a thing of it.",
        "...I've a bracket in the workshop that'd fit the square's old lamp post. Been keeping it. Don't tell Mara. It's going to be a surprise.",
      ],
    },
    {
      when: ['lantern-road:complete'],
      speaker: 'Orrin',
      lines: [
        'Bracket held. Lamp post in the square is lit again, the signpost still leans, and the world is in its proper order.',
        "You did right by this road. If you ever need a bridge built — or complained about — you know where I am. Measure in fingers. They're yours.",
      ],
    },
  ],
  clue: [
    {
      when: ['lantern-road:new', 'lantern-road:clue-found', 'lantern-road:guardian-defeated', 'lantern-road:lantern-lit', 'lantern-road:complete'],
      speaker: 'Route Marker',
      lines: [
        "A weathered route stone, its pattern furred with keeper's moss. Without knowing what you're looking for, it's hard to say where carving ends and wear begins.",
      ],
    },
    {
      when: ['lantern-road:accepted'],
      speaker: 'Route Marker',
      lines: [
        "A route stone stands in the alcove, its pattern half under keeper's moss — but the cut lines are still deep enough to copy.",
        'Two weaves and a break: not a direction, but a fence. Beside it, smaller, a naming cut in a Keeper’s hand:',
        '“The road is closed here. Behind you the village, ahead the dark. Hold the break.”',
        'You copy the words down. The road was closed here, on purpose — and told to stay closed.',
      ],
      event: 'find-clue',
    },
  ],
  lantern: [
    {
      when: ['lantern-road:new', 'lantern-road:accepted', 'lantern-road:clue-found'],
      speaker: 'Hilltop Lantern',
      lines: [
        'The shrine lantern hangs cold in its iron frame, soot-streaked and patient. The stone warden stands across the path to the ledge, arms out.',
      ],
    },
    {
      when: ['lantern-road:guardian-defeated'],
      speaker: 'Hilltop Lantern',
      lines: [
        'The warden rests now, its chest-lamp guttered to a coal. On the ledge: flint, steel, a dry wick, and words scratched in a small, neat hand.',
        "'You are the shrine above Ashwatch. Behind you the ruin, before you the road east. Hold.' You read it aloud to the wick, feeling a little foolish.",
        'You strike a spark. The wick catches, then the oil, and the lamp fills with steady gold. Far below, a village square turns its face toward the hill.',
      ],
      event: 'light-lantern',
    },
    {
      when: ['lantern-road:lantern-lit', 'lantern-road:complete'],
      speaker: 'Hilltop Lantern',
      lines: [
        'The lantern burns steady, laying a warm path down the hillside and over the dark weave of Brackenwood.',
        'East of here the old road runs on toward Sallow Ford, lamp after cold lamp. This one, at least, the land will remember.',
      ],
    },
  ],
};

const JOURNAL_BY_STAGE: Record<QuestStage, JournalEntry[]> = {
  new: [
    {
      title: 'Arrival in Hearthwick',
      body: 'Came up the Low Road and over the last rise into Hearthwick: patched slate roofs, a lamp in every window, and one window they say has not gone dark at night in thirty years. Mara keeps her grandmother’s oil ledger. Orrin keeps resetting a signpost that leans.',
    },
  ],
  accepted: [
    {
      title: "Mara's Request",
      body: 'Mara asked me to walk the old lantern road: out the east gate, along the Brackenwood path, through Ashwatch Ruin, up to the hilltop shrine. Her grandmother Wenna kept that road. Find what is left of it.',
    },
    {
      title: 'Orrin’s Advice',
      body: 'A warden stands on the shrine path: drift-stone, dutiful, not cruel. Orrin says the road wanted people who looked closely. The route stone in the ruin should carry the pattern.',
    },
  ],
  'clue-found': [
    {
      title: 'The Closure Mark',
      body: 'Two weaves and a break on the Ashwatch route stone, and beside it a naming cut in a Keeper’s hand: “The road is closed here. Behind you the village, ahead the dark. Hold the break.” I copied it down. Orrin calls it a closure mark, cut after the Winter of Two Storms. The road was shut on purpose. Orrin and Pip agree on one thing: don’t fight the warden. When it lunges and stops to find its feet, get close and speak the naming to its lamp, turned round: the road is held again.',
    },
  ],
  'guardian-defeated': [
    {
      title: 'The Warden Settled',
      body: 'Each time I spoke the naming to its heart-lamp it faltered, until its arms came down and the lamp in its chest guttered low. It isn’t broken. It is resting in its pose, the way it was made to. The ledge beyond holds flint, steel, and a dry wick.',
    },
  ],
  'lantern-lit': [
    {
      title: 'The Hilltop Lantern',
      body: 'The shrine lantern is lit, and named: the words were scratched on the ledge, and I said them aloud. Its light runs down toward Hearthwick, and the square turned to watch. Mara should hear it from me.',
    },
  ],
  complete: [
    {
      title: 'The Lantern Road',
      body: 'Told Mara the whole of it in the square, under a lamp post Orrin relit as his surprise. The hill glows again. Mara says there is a page at the back of the ledger she still can’t read. Not tonight, she said.',
    },
  ],
};

const STAGE_ORDER: QuestStage[] = [
  'new',
  'accepted',
  'clue-found',
  'guardian-defeated',
  'lantern-lit',
  'complete',
];

/**
 * Dialogue for one NPC/interaction for the save's quest record: the first
 * rule whose `when` holds. Optional `event` fires when the runtime finishes
 * presenting these lines: only the legal next step is ever attached, so
 * dialogue cannot skip or repeat steps. Throws for unknown NPC ids.
 */
export function dialogueFor(npcId: string, record: QuestRecord): Dialogue {
  const rules = DIALOGUE[npcId];
  if (!rules) {
    throw new Error(
      `Unknown NPC id ${JSON.stringify(npcId)}; expected one of ${Object.keys(DIALOGUE)
        .map((id) => JSON.stringify(id))
        .join(', ')}`,
    );
  }
  const rule = rules.find((r) => r.when.some((ref) => whenHolds(ref, record)));
  if (!rule) {
    throw new Error(`No dialogue defined for NPC ${JSON.stringify(npcId)} at ${JSON.stringify(record)}`);
  }
  const dialogue: Dialogue = {
    speaker: rule.speaker,
    lines: [...rule.lines],
    key: rule.when.find((ref) => whenHolds(ref, record)),
  };
  if (rule.event) {
    dialogue.event = rule.event;
  }
  if (rule.choices) {
    dialogue.choices = rule.choices.map((c) => ({ text: c.text, reply: c.reply ? [...c.reply] : undefined }));
  }
  return dialogue;
}

/** Every rule's `when` refs (tests check each names a real quest step). */
export function dialogueRefs(): string[] {
  return Object.values(DIALOGUE).flatMap((rules) => rules.flatMap((r) => r.when));
}

/**
 * Cumulative journal entries for the save's quest record: the lantern
 * road's pages up to the step reached (the opening's notes after the
 * first), then the notes of every village quest step reached
 * (src/lib/quests.ts). Entries never shrink as quests advance.
 * With the save's flags, the residents you have met (./residents.ts) join
 * in after the entries of the road step you met them at.
 */
export function journalEntries(record: QuestRecord, flags: readonly string[] = []): JournalEntry[] {
  const road = QUESTS.find((q) => q.id === LANTERN_ROAD)!;
  const stageIndex = reachedIndex(road, record) + 1;
  const notes = (quest: (typeof QUESTS)[number]): JournalEntry[] =>
    quest.steps.slice(0, reachedIndex(quest, record) + 1).flatMap((s) => (s.note ? [{ title: s.note.title, body: s.note.body }] : []));
  const entries: JournalEntry[] = [];
  for (let i = 0; i <= stageIndex; i += 1) {
    for (const entry of JOURNAL_BY_STAGE[STAGE_ORDER[i]]) {
      entries.push({ title: entry.title, body: entry.body });
    }
    entries.push(...residentJournal(flags, STAGE_ORDER[i]));
    // The opening's notes come between arriving and Mara's request.
    if (i === 0) for (const q of QUESTS) if (q.line === 'road' && q.id !== LANTERN_ROAD) entries.push(...notes(q));
  }
  // The village's quests (the lantern road keeps its pages above).
  for (const q of QUESTS) if (q.line !== 'road') entries.push(...notes(q));
  entries.push(...heirloomJournalEntries(flags));
  // The keepsakes with no living owner, left at their Echo camps.
  entries.push(...echoKeepsakeJournalEntries(flags));
  // Beats you stood beside in someone else's story.
  entries.push(...witnessJournalEntries(flags));
  if (flags.includes('unmoored:felt')) {
    entries.push({
      title: 'The Drift’s Sway',
      body: 'The woods began to sway and the ground went soft and uncertain underfoot. Not a storm, just the land forgetting its own shape for a while.',
    });
  }
  if (flags.includes('unmoored:cleared')) {
    entries.push({
      title: 'Finding the Anchor',
      body: 'The edges settled and the ground stood still again. Lamplight, comfrey salve, or patience — the world remembers when you remind it.',
    });
  }
  if (flags.includes('warden-sliver:found')) {
    entries.push({
      title: 'A Still Stone',
      body: 'A chip of grey stone with an amber fleck. It sits very still in your hand.',
    });
  }
  return entries;
}

// ------------------------------------------------------------------ embers

export type EmberSpotKind = 'hearth' | RoadLanternId | 'chest';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** How to get more embers, in the world's voice. */
function emberHint(connected: boolean): string {
  return connected
    ? `Every ${XP_PER_EMBER} XP you earn in Habitica becomes an ember. Sync from the Menu in Hearthwick or the Commons to collect them.`
    : `Embers come from real-life progress: connect Habitica in the Menu, and every ${XP_PER_EMBER} XP you earn there becomes an ember.`;
}

/** Connected play: `online` spends wait for the server, `offline` can't spend. */
export type RemoteMode = 'online' | 'offline' | null;

function spendChoice(state: GameState, label: string, spend: Parameters<typeof checkSpend>[1], action: string, reply: string[], imported: boolean, remote: RemoteMode = null): DialogueChoice {
  const check = checkSpend(state, spend, { imported });
  const cost = plural(check.cost, 'ember');
  if (check.ok && remote === 'offline') return { text: label, note: 'Needs a connection', disabled: true };
  // Online, the payoff is told after the server says yes (no reply here).
  if (check.ok) return remote === 'online' ? { text: label, note: cost, action } : { text: label, note: cost, action, reply };
  const note =
    check.reason === 'short'
      ? `Needs ${cost}`
      : check.reason === 'full'
        ? 'Already rested'
        : check.reason === 'needs-earned'
          ? `Needs ${cost} earned on Habitica`
          : 'Done';
  return { text: label, note, disabled: true };
}

/**
 * Conversations at the places where embers are spent. Built from the live
 * state so costs, balances and already-done states are always current.
 */
export function emberDialogue(id: EmberSpotKind, state: GameState, opts: { connected: boolean; remote?: RemoteMode }): Dialogue {
  const balance = state.embers > 0 ? `You carry ${plural(state.embers, 'ember')}.` : 'You have no embers yet.';
  const short = (cost: number) => state.embers < cost;

  if (id === 'hearth') {
    const lines = ['The square\u2019s lamp burns low and patient, named and tended every dusk. Its warmth reaches as far as the well.', balance];
    if (short(EMBER_COSTS.rest)) lines.push(emberHint(opts.connected));
    return {
      speaker: 'Hearth Lantern',
      lines,
      choices: [
        spendChoice(state, 'Rest by the flame', { kind: 'rest' }, 'rest', [
          'You sit with your back to the warm post. Aches loosen. Your head clears.',
        ], opts.connected, opts.remote ?? null),
        { text: 'Just warm my hands', reply: ['You stay a moment. It helps a little, the way small warm things do.'] },
      ],
    };
  }

  if (id === 'chest') {
    if (chestOpened(state)) {
      return {
        speaker: 'Ashwatch Chest',
        lines: ['The chest stands open and empty. Its lock-flame still flickers, pleased with itself.'],
      };
    }
    const lines = [
      'A Keeper\u2019s chest, oak pegged into oak: no Hall-price hinges here. Its lock is shaped like a lantern with no flame.',
      'It looks like it wants an ember, not a key.',
      balance,
    ];
    if (short(EMBER_COSTS.chest)) lines.push(emberHint(opts.connected));
    return {
      speaker: 'Ashwatch Chest',
      lines,
      choices: [
        spendChoice(state, 'Kindle the lock', { kind: 'chest' }, 'chest', [
          'The lock-flame flares and the lid sighs open. Inside, wrapped in green oilcloth: a chip of amber in a twist of wire, still warm.',
        ], opts.connected, opts.remote ?? null),
        { text: 'Not yet' },
      ],
    };
  }

  // Road lanterns
  if (isLit(state, id)) {
    return {
      speaker: 'Road Lantern',
      lines: ['The lantern you lit burns steady, one link of the old chain held again. Resting in its light mends you.'],
    };
  }
  const lines = ['A cold road lantern leans over the path, one of the old chain. Its wick is dry but whole.', balance];
  if (short(EMBER_COSTS.roadLantern)) lines.push(emberHint(opts.connected));
  return {
    speaker: 'Road Lantern',
    lines,
    choices: [
      spendChoice(state, 'Light it', { kind: 'road-lantern', id }, `light:${id}`, [
        'You name it for the stretch it stands on, and the flame catches and steadies. Stand in its light to catch your breath.',
      ], opts.connected, opts.remote ?? null),
      { text: 'Leave it for now' },
    ],
  };
}
