/**
 * "How do I…?" (playtest 1): small guides in the journal, each a few steps
 * that tick themselves off from what the player has and has done. One can be
 * pinned as the goal: the HUD's goal line, its needle and the edge glow then
 * follow its current step (src/game/entities/goal-guide.ts). No Phaser, no
 * network: the game builds a GuideContext and asks.
 */
import { GUIDES, type GuideDef, type GuideWhere } from '../content/guides.ts';

export type { GuideDef, GuideWhere };
export { GUIDES };

/** What the guides can see of the player. Everything a world knows; a guest has `connected: false`. */
export interface GuideContext {
  connected: boolean;
  claimed: boolean;
  /** Homestead tier (0 camp, 1 cottage, 2 workshop…); -1 with no deed. */
  tier: number;
  /** Tool actions the player carries a tool for (chop, break, dig, draw…). */
  tools: string[];
  /** A tool with the player's own maker's mark is carried (made at their bench). */
  madeTool: boolean;
  /** Any carried tool has a fitting in it. */
  fitted: boolean;
  /** Fitting items carried, loose. */
  fittings: number;
  /** Carried materials. */
  materials: Record<string, number>;
  /** Hearth-made things carried with the player's own maker's mark. */
  cooked: number;
  /** The player has sent mail. */
  sentMail: boolean;
  /** Home goods the player owns: carried, stored or set out. */
  homeGoods: { itemDef: string; placed: boolean }[];
  /** Story flags (seen places, quest beats, and `guide:<id>:<step>` for steps already done). */
  flags: string[];
}

/** The save flag that remembers a guide's step as done (it never un-ticks). */
export function guideFlag(id: string, step: number): string {
  return `guide:${id}:${step}`;
}

export interface GuideProgress {
  guide: GuideDef;
  /** Each step's state. */
  steps: { text: string; done: boolean; where: GuideWhere | null }[];
  /** The first step not done (null: the whole guide is done). */
  current: number | null;
  done: boolean;
  /** Needs a world (signing in) and this is a guest. */
  locked: boolean;
}

export function guideById(id: string): GuideDef | null {
  return GUIDES.find((g) => g.id === id) ?? null;
}

/**
 * Where a guide stands. A step is done once it has been met (remembered in
 * the save, so spending the timber or drinking the tea never un-ticks it),
 * or when it's met now. Each step carries its own prerequisites: nothing
 * later in a guide ticks an earlier step for the player.
 */
export function guideProgress(guide: GuideDef, ctx: GuideContext): GuideProgress {
  const flags = new Set(ctx.flags);
  const doneFlags = guide.steps.map((s, i) => flags.has(guideFlag(guide.id, i)) || s.done(ctx));
  const current = doneFlags.findIndex((d) => !d);
  return {
    guide,
    steps: guide.steps.map((s, i) => ({ text: s.text, done: doneFlags[i], where: s.where ?? null })),
    current: current < 0 ? null : current,
    done: current < 0,
    locked: !!guide.needsWorld && !ctx.connected,
  };
}

/** Steps met now and not yet remembered: the flags to add to the save. */
export function newlyMet(ctx: GuideContext): string[] {
  if (!ctx.connected) return [];
  const flags = new Set(ctx.flags);
  const out: string[] = [];
  for (const g of GUIDES) {
    g.steps.forEach((s, i) => {
      const f = guideFlag(g.id, i);
      if (!flags.has(f) && s.done(ctx)) out.push(f);
    });
  }
  return out;
}

/** Every guide's progress, in the journal's order. */
export function allGuides(ctx: GuideContext): GuideProgress[] {
  return GUIDES.map((g) => guideProgress(g, ctx));
}
