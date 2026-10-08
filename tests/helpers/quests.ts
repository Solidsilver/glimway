/** Walk the lantern road in tests: its scene events, through the quest predictor. */
import { reachStep, ROAD_EVENT_STEP, LANTERN_ROAD } from '../../src/lib/quests.ts';
import type { GameState, QuestEvent } from '../../src/lib/state.ts';

export function road(state: GameState, ...events: QuestEvent[]): GameState {
  let s = state;
  for (const e of events) {
    const next = reachStep(s, LANTERN_ROAD, ROAD_EVENT_STEP[e], 0);
    if (!next) throw new Error(`not the next step: ${e} at ${JSON.stringify(s.quests)}`);
    s = next;
  }
  return s;
}
