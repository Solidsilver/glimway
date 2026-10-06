/**
 * Talk that doesn't repeat itself (playtest 1): once you've heard a
 * person's story lines, the next talk opens on a one-line greeting and the
 * choices, with "Hear it again" for anyone who wants the whole of it.
 * Anything new (a quest step, a line about the day) still plays in full.
 * The rules live in src/game/heard.ts; the words live here.
 */

/** The choices a short talk adds. */
export const TALK_COPY = {
  again: 'Hear it again',
  leave: 'Be on my way',
} as const;

/**
 * One-line greetings per person, picked in turn. Each says hello in their
 * own voice and leaves the talking to the choices (or to what's new).
 */
export const GREETINGS: Record<string, readonly string[]> = {
  mara: [
    'There you are. The ledger’s quieter with you out on the road.',
    'Mind the ink, it’s still wet. What do you need?',
    'Pull up the good crate. The other one wobbles.',
    'Back again? Pencil still sharp? The ground out there forgets. I don’t.',
  ],
  pip: [
    'Oh! You again. I’ve run to the mill twice since you blinked.',
    'Got a message? I’m fast. Fastest runner in Hearthwick. Only runner, also.',
    'The red berries still taste like soap. Just checking you remember.',
  ],
  orrin: [
    'Hm. You. The signpost’s leaning on purpose, before you ask.',
    'Stone doesn’t keep the hours, and neither do I. What is it?',
    'If it’s about the ladder, it was there first.',
  ],
  elara: [
    'Mind the jars. What does the drift say today?',
    'Ah, my favourite source of field notes. Go on.',
    'Still mapping? Use pencil. You know why.',
  ],
  finn: [
    'Forty-one. Sorry, counting. Hello.',
    'The wheel’s turning, the pond’s full, and I’m holding. You?',
    'Oh! Hello. Mind the flour, it gets everywhere.',
  ],
  hazel: [
    'Take a twist, you look peaky. Now, what is it?',
    'Back hungry? Good. That’s how I like them.',
    'Pip said you’d come by. Pip says a lot of things, at a run.',
  ],
  ada: [
    'You again. Good.',
    'Wick’s trimmed. Sit if you like.',
    'Still walking the stones. Good.',
  ],
};

/** Every line a short talk can say (the text rules in tests/world.test.ts). */
export function allTalkLines(): string[] {
  return [TALK_COPY.again, TALK_COPY.leave, ...Object.values(GREETINGS).flat()];
}

/** What the panel shows; matches src/content/world.ts Dialogue (no imports, so tests can use it). */
interface Choice {
  text: string;
  reply?: string[];
  action?: string;
  disabled?: boolean;
  note?: string;
  replay?: boolean;
  dismiss?: boolean;
}

/** A goodbye at the end of a choice list ("Not yet", "Just passing", "Be on my way"). */
function isGoodbye(c: Choice): boolean {
  return !c.action && !c.reply?.length && !c.disabled;
}

/**
 * The short form of a talk whose story you've heard: the greeting, then any
 * `fresh` lines (new today), then the choices with "Hear it again" (which
 * replays `full`) before the goodbye. With no choices of its own, the talk
 * offers "Hear it again" and a goodbye.
 */
export function shortTalk(opts: { greeting: string; fresh: readonly string[]; full: readonly string[]; choices?: readonly Choice[] }): { lines: string[]; choices: Choice[] } {
  const again: Choice = { text: TALK_COPY.again, reply: [...opts.full], replay: true };
  const own = [...(opts.choices ?? [])];
  let choices: Choice[];
  if (!own.length) choices = [again, { text: TALK_COPY.leave, dismiss: true }];
  else {
    const last = own[own.length - 1];
    choices = isGoodbye(last) ? [...own.slice(0, -1), again, last] : [...own, again];
  }
  return { lines: [opts.greeting, ...opts.fresh], choices };
}
