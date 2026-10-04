import type { AreaId, GameState, QuestEvent, QuestStage } from '../lib/state.ts';
import { EMBER_COSTS, XP_PER_EMBER, checkSpend, chestOpened, isLit, type RoadLanternId } from '../lib/embers.ts';

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
}

export interface Dialogue {
  speaker: string;
  lines: string[];
  event?: QuestEvent;
  /** Optional replies offered after the last line; every choice keeps the event. */
  choices?: DialogueChoice[];
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
 * Demo character: a classless wayfarer with a sensible starter kit, standing
 * in for a future Habitica import. No account data is used in the demo.
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
    blurb: 'Half-full of other people\u2019s roads. Press J to read it.',
  },
  'hearthwick-map': {
    name: 'Map of Hearthwick',
    icon: 'map',
    blurb: 'Hand-inked by a carter. The east gate is circled twice.',
  },
  'ember-charm': {
    name: 'Ember Charm',
    icon: 'ember',
    blurb: 'Still warm from the Ashwatch chest. Your strikes find the gaps more often.',
  },
};

/** Display names for discovery ids. */
export const DISCOVERY_INFO: Record<string, ItemInfo> = {
  'route-marker': {
    name: 'The Faded Route Marker',
    icon: 'stone',
    blurb: 'A lichen-eaten waystone in Brackenwood, still pointing at the hill.',
  },
  'old-route-marker': {
    name: 'The Closure Mark',
    icon: 'scroll',
    blurb: 'A charcoal rubbing: two weaves and a break. The road was shut on purpose.',
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
    tagline: 'Someone here is always mending something.',
    description:
      'A hillside village of patched slate roofs, kitchen gardens, and a square where someone is always mending something. The dark lantern road begins at the east gate.',
  },
  woodland: {
    name: 'Brackenwood Path',
    eyebrow: 'The old lantern road',
    tagline: 'Cool shade, leaning stones — and things that hop. Watch for the wind-up.',
    description:
      'A soft trail under oak and bracken, cool even at midday. Old route stones lean in the moss, and the canopy keeps the east gate visible behind you.',
  },
  ruin: {
    name: 'Ashwatch Ruin',
    eyebrow: 'Beneath the hilltop shrine',
    tagline: 'Something made of stone is still keeping watch.',
    description:
      'A roofless waystation of grey blocks, heather pushing through the floor. The hilltop lantern shrine stands beyond its broken arch, watched over by a stone warden.',
  },
};

type DialogueRule = Dialogue & { forStages: QuestStage[] };

/**
 * NPC and interaction ids used by the runtime. This list is the agreement
 * point with docs/runtime-contract.md: mara, pip, orrin, clue, lantern.
 * The quest event 'defeat-guardian' is fired by runtime encounter logic, not
 * by dialogue.
 */
const DIALOGUE: Record<string, DialogueRule[]> = {
  mara: [
    {
      forStages: ['new'],
      speaker: 'Mara',
      lines: [
        'You must be the traveler the carters mentioned. Welcome to Hearthwick — mind the ladder, Orrin is mending the signpost again.',
        "I'm Mara. My grandmother kept the lantern road when it still carried people home after dark. Now half the route stones are mossed over and the hilltop lantern has been cold since before I was born.",
        'I would go myself, but the lamp oil ledger does not keep itself, and someone has to be here when the carters come through. Would you walk the old road for me? Brackenwood path, through the ruin, up to the shrine. Bring back whatever you find.',
      ],
      event: 'accept',
      choices: [
        {
          text: 'Of course. Point me at the gate.',
          reply: ['East gate, past the milestone. Thank you — truly. Grandmother would have liked you.'],
        },
        {
          text: '…Is there a reward?',
          reply: [
            'Ha! A lit road, the gratitude of a small village, and as much of Orrin\u2019s complaining as you can stand.',
            'Also soup. There is always soup. East gate, past the milestone.',
          ],
        },
      ],
    },
    {
      forStages: ['accepted'],
      speaker: 'Mara',
      lines: [
        'The east gate is the start of it. Follow the Brackenwood path and keep an eye out for the old route stones — my grandmother swore they still point the way.',
        'If you get turned around, ask Pip. That child knows every shortcut, mostly because they have taken all of them.',
      ],
    },
    {
      forStages: ['clue-found'],
      speaker: 'Mara',
      lines: [
        'A rubbing of the route marker — look at that, the pattern is still legible. Grandmother drew the same one in the front of her ledger.',
        'So the road was not abandoned, it was closed. Something about a warden on the shrine path. Be careful up there — careful, not slow.',
      ],
    },
    {
      forStages: ['guardian-defeated'],
      speaker: 'Mara',
      lines: [
        "You bested the stone warden? Orrin is going to pretend he never doubted you, but he did, loudly, over breakfast.",
        'The shrine is just past the arch. If the lamp still has oil in it, the flint and steel are on the ledge where they have always been. Light it. Let us see the road again.',
      ],
    },
    {
      forStages: ['lantern-lit'],
      speaker: 'Mara',
      lines: [
        "Is that — I can see it from here. A point of gold on the hill, just like in the stories. Come inside, tell me everything.",
        "You did it. The road is lit. When you are ready, meet me in the square — I want to hear it all from the beginning.",
      ],
      event: 'return-village',
    },
    {
      forStages: ['complete'],
      speaker: 'Mara',
      lines: [
        'There. The square has not looked like this in thirty years — lantern light on the slate, and everyone pretending they are not staying out late to enjoy it.',
        'Grandmother kept a line in her ledger: "A road is a promise people keep renewing." I think she would be glad to know it was renewed by a traveler who just kept walking.',
      ],
    },
  ],
  pip: [
    {
      forStages: ['new'],
      speaker: 'Pip',
      lines: [
        "New face! I'm Pip. I run messages between here and the mill, which is the fastest job in the world and also the only one.",
        "If you're heading into Brackenwood, do not eat the red berries no matter what anyone tells you. They are not poisonous, they just taste like soap and you will be annoyed for hours.",
      ],
    },
    {
      forStages: ['accepted'],
      speaker: 'Pip',
      lines: [
        "You're walking the old lantern road! Brilliant. Halfway along there is a fallen oak with a notch cut in it — that's where the path forks. Take the uphill side.",
        'I would come with you, but I have a delivery, and also Mara gave me a look. You know the look.',
      ],
    },
    {
      forStages: ['clue-found'],
      speaker: 'Pip',
      lines: [
        'Is that a rubbing? Let me see, let me see. The lines look like the ones on the mill sign, all curly at the ends.',
        "A stone warden. That's what the miller's dad used to call it. He said it is not mean, it is just still doing its job. Which is a lot like Orrin, actually.",
      ],
    },
    {
      forStages: ['guardian-defeated'],
      speaker: 'Pip',
      lines: [
        "You actually fought it? On purpose? I once ran past it and it did not even turn around and that was the most exciting day of my year.",
        'Go light the lantern. I want to see it from the mill roof. I want to see it from the moon, but the mill roof is a start.',
      ],
    },
    {
      forStages: ['lantern-lit'],
      speaker: 'Pip',
      lines: [
        "There's a light on the hill! There is a light on the hill! I have to tell everyone, but first — did it make a sound? Lanterns in stories always make a sound.",
        "I'm going to run the message route twice tonight just to look at it. Maybe three times. Do not tell Mara about the third time.",
      ],
    },
    {
      forStages: ['complete'],
      speaker: 'Pip',
      lines: [
        'People keep walking up the east gate road just to stand under the lantern glow and act like they are checking the fence. I have counted nine of them.',
        "I am collecting string for a light-line of my own, between the signpost and the well. Orrin says the knotwork is wrong. The knotwork is fine.",
      ],
    },
  ],
  orrin: [
    {
      forStages: ['new'],
      speaker: 'Orrin',
      lines: [
        "Mind the shavings. And the ladder. And the signpost — it leans because the frost heaves the post every winter, not because I fitted it badly.",
        "I'm Orrin. Built bridges for thirty years, now I build bridges and also signposts, and complain about both. You here about the lantern road? Hm. Thought someone would come eventually.",
      ],
    },
    {
      forStages: ['accepted'],
      speaker: 'Orrin',
      lines: [
        "The warden on the shrine path is stone, and it is not cruel — it is dutiful, which is harder to deal with. It tests whether you know why the road was closed.",
        "Take a rubbing of the route marker before you climb. The old pattern is the point. Anyone can wave a sword; the road wanted people who paid attention.",
      ],
    },
    {
      forStages: ['clue-found'],
      speaker: 'Orrin',
      lines: [
        "Let me see that rubbing. Aye — that is the closure mark, not a direction mark. Two weaves and a break. They closed the road on purpose after the winter of two storms.",
        "Mara's grandmother wrote the same pattern in her ledger and never told a soul what it meant. Some people keep their promises quietly. Annoying habit. Good habit.",
      ],
    },
    {
      forStages: ['guardian-defeated'],
      speaker: 'Orrin',
      lines: [
        "Huh. Thirty years that thing has been standing there and it took one traveler with a rubbing and a stubborn streak. I am not impressed. I am slightly impressed.",
        "Go on then. Light the lamp. I will still be here, and the signpost will still lean, and that is fine.",
      ],
    },
    {
      forStages: ['lantern-lit'],
      speaker: 'Orrin',
      lines: [
        "There is a light on the hill. Do not make a thing of it. I am not making a thing of it.",
        "...I have a bracket in the workshop that would fit the square's old lamp post. Been saving it. Do not tell Mara I said that. It is going to be a surprise.",
      ],
    },
    {
      forStages: ['complete'],
      speaker: 'Orrin',
      lines: [
        'Bracket held. Lamp post in the square is lit again, and the signpost is still leaning, and the world is in its proper order.',
        "You did right by this road, traveler. If you ever need a bridge built — or a bridge complained about — you know where I am.",
      ],
    },
  ],
  clue: [
    {
      forStages: ['new', 'clue-found', 'guardian-defeated', 'lantern-lit', 'complete'],
      speaker: 'Route Marker',
      lines: [
        'A weathered route stone, its carved pattern half swallowed by lichen. Without knowing what the pattern means, it is hard to make out where the carving ends and the wear begins.',
      ],
    },
    {
      forStages: ['accepted'],
      speaker: 'Route Marker',
      lines: [
        'A weathered route stone stands here, its carved pattern half swallowed by lichen — but the weave of lines is still deep enough to copy.',
        'You press paper to the stone and work charcoal over it. Two weaves and a break: a closure mark, pointing not along the road, but at why it was shut.',
      ],
      event: 'find-clue',
    },
  ],
  lantern: [
    {
      forStages: ['new', 'accepted', 'clue-found'],
      speaker: 'Hilltop Lantern',
      lines: [
        'The shrine lantern hangs cold in its iron frame, soot-streaked and patient. The stone warden stands between you and the lighting ledge, unmoving.',
      ],
    },
    {
      forStages: ['guardian-defeated'],
      speaker: 'Hilltop Lantern',
      lines: [
        'The stone warden has stepped aside. The iron frame still holds a dry wick, and flint and steel wait on the ledge where they were left decades ago.',
        'You strike a spark. The wick catches, then the oil, and the lantern fills with steady gold light. Somewhere far below, a village square turns its face toward the hill.',
      ],
      event: 'light-lantern',
    },
    {
      forStages: ['lantern-lit', 'complete'],
      speaker: 'Hilltop Lantern',
      lines: [
        'The lantern burns steadily, throwing a warm path of light down the hillside and across the dark weave of Brackenwood.',
        'On clear evenings, Hearthwick will be able to see this flame from the square. The old road is a promise people keep renewing.',
      ],
    },
  ],
};

const JOURNAL_BY_STAGE: Record<QuestStage, JournalEntry[]> = {
  new: [
    {
      title: 'Arrival in Hearthwick',
      body: 'A hillside village of patched roofs and small kindnesses. The carters left me at the square, where Mara keeps her grandmother\u2019s lamp-oil ledger and Orrin keeps pretending his signpost does not lean.',
    },
  ],
  accepted: [
    {
      title: "Mara's Request",
      body: 'Mara asked me to walk the old lantern road: through the east gate, along the Brackenwood path, past the Ashwatch ruin, up to the hilltop shrine. Her grandmother once kept that road lit. Find what is left of it.',
    },
    {
      title: 'Orrin\u2019s Advice',
      body: 'The stone warden on the shrine path is dutiful, not cruel. It wants proof that I know why the road was closed. The route marker in the ruin should carry the pattern.',
    },
  ],
  'clue-found': [
    {
      title: 'The Closure Mark',
      body: 'A charcoal rubbing from the ruin\u2019s route stone: two weaves and a break. Orrin says it is a closure mark, cut after the winter of two storms. The road was shut on purpose — and the warden is still keeping that decision.',
    },
  ],
  'guardian-defeated': [
    {
      title: 'The Stone Warden',
      body: 'The warden on the shrine path has yielded. It kept its post for decades longer than anyone in Hearthwick expected. The lighting ledge holds flint, steel, and a dry wick.',
    },
  ],
  'lantern-lit': [
    {
      title: 'The Hilltop Lantern',
      body: 'The shrine lantern is lit. Its light runs down the hillside toward Hearthwick, and the square turned to watch. Mara should hear it from me directly.',
    },
  ],
  complete: [
    {
      title: 'The Lantern Road',
      body: 'Told Mara the whole story in the square, under a relit lamp post — Orrin\u2019s doing, and his surprise. The old road glows again, and Hearthwick is staying out late to enjoy it. As Mara\u2019s grandmother wrote: a road is a promise people keep renewing.',
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
 * Dialogue for one NPC/interaction at the given quest stage. Optional `event`
 * fires when the runtime finishes presenting these lines: only the legal next
 * quest event is ever attached, so dialogue cannot skip or repeat stages.
 * Throws for unknown NPC ids.
 */
export function dialogueFor(npcId: string, stage: QuestStage): Dialogue {
  const rules = DIALOGUE[npcId];
  if (!rules) {
    throw new Error(
      `Unknown NPC id ${JSON.stringify(npcId)}; expected one of ${Object.keys(DIALOGUE)
        .map((id) => JSON.stringify(id))
        .join(', ')}`,
    );
  }
  const rule = rules.find((r) => r.forStages.includes(stage));
  if (!rule) {
    throw new Error(
      `No dialogue defined for NPC ${JSON.stringify(npcId)} at quest stage ${JSON.stringify(stage)}`,
    );
  }
  const dialogue: Dialogue = {
    speaker: rule.speaker,
    lines: [...rule.lines],
  };
  if (rule.event) {
    dialogue.event = rule.event;
  }
  if (rule.choices) {
    dialogue.choices = rule.choices.map((c) => ({ text: c.text, reply: c.reply ? [...c.reply] : undefined }));
  }
  return dialogue;
}

/**
 * Cumulative journal entries unlocked up to and including the given stage.
 * Entries are ordered by unlock stage and never shrink as the quest advances.
 */
export function journalEntries(stage: QuestStage): JournalEntry[] {
  const stageIndex = STAGE_ORDER.indexOf(stage);
  if (stageIndex === -1) {
    throw new Error(
      `Unknown quest stage ${JSON.stringify(stage)}; expected one of ${STAGE_ORDER.map((s) => JSON.stringify(s)).join(', ')}`,
    );
  }
  const entries: JournalEntry[] = [];
  for (let i = 0; i <= stageIndex; i += 1) {
    for (const entry of JOURNAL_BY_STAGE[STAGE_ORDER[i]]) {
      entries.push({ title: entry.title, body: entry.body });
    }
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
    ? `Every ${XP_PER_EMBER} XP you earn in Habitica becomes an ember. Sync from the Menu here in Hearthwick to collect them.`
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
    const lines = ['The village lantern hums with a low, patient warmth.', balance];
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
      'An old iron-bound chest. Its lock is shaped like a lantern with no flame.',
      'It looks like it wants an ember, not a key.',
      balance,
    ];
    if (short(EMBER_COSTS.chest)) lines.push(emberHint(opts.connected));
    return {
      speaker: 'Ashwatch Chest',
      lines,
      choices: [
        spendChoice(state, 'Kindle the lock', { kind: 'chest' }, 'chest', [
          'The lock-flame flares and the lid sighs open. Inside, wrapped in oilcloth: a small charm, still warm.',
        ], opts.connected, opts.remote ?? null),
        { text: 'Not yet' },
      ],
    };
  }

  // Road lanterns
  if (isLit(state, id)) {
    return {
      speaker: 'Road Lantern',
      lines: ['The lantern you lit burns steady. Resting in its light mends you.'],
    };
  }
  const lines = ['A cold iron lantern leans over the path. Its wick is dry but whole.', balance];
  if (short(EMBER_COSTS.roadLantern)) lines.push(emberHint(opts.connected));
  return {
    speaker: 'Road Lantern',
    lines,
    choices: [
      spendChoice(state, 'Light it', { kind: 'road-lantern', id }, `light:${id}`, [
        'The flame catches and steadies. Stand in its light to catch your breath.',
      ], opts.connected, opts.remote ?? null),
      { text: 'Leave it for now' },
    ],
  };
}
