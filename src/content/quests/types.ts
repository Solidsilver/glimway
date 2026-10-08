/**
 * The shape of a quest's words (docs/design/indoors.md 5.8): each quest's
 * file holds the talks for its steps, keyed by the step they reach. The
 * server never needs these.
 */
import type { DialogueChoice } from '../world.ts';

/** What a talk can see when its lines depend on the hero (Mara's connected line). */
export interface TalkWords {
  connected: boolean;
}

export interface StepTalk {
  speaker: string;
  lines: readonly string[] | ((w: TalkWords) => string[]);
  /**
   * The offer that takes the step (a gated step's, so it can be shown
   * disabled with why). Without one, finishing the talk takes it.
   */
  offer?: { text: string; note?: string; reply?: string[] };
  /** Replies that all take the step (Orrin's two). */
  choices?: DialogueChoice[];
  /** A `wait` gate that hasn't opened: `words` is "about 1 h 20 m". */
  notYet?: (words: string) => string[];
  /** An `item` gate you can't meet yet. */
  short?: readonly string[];
}

/** A quest's words: step id → the talk that reaches it. */
export type QuestTalks = Readonly<Record<string, StepTalk>>;
