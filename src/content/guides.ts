/**
 * The journal's "How do I…?" guides (src/lib/guides.ts). Each step says what
 * to do in a line, knows when it's done, and names where to go (the goal
 * needle and edge glow lead there while the guide is pinned). In-world voice,
 * short; no real-life tasks or apps.
 */
import type { GuideContext } from '../lib/guides.ts';

/**
 * Where a step happens:
 * - `silas`: Silas, at his counter in the Yard or out by his sawhorse
 * - `pell`: Pell, at the desk in the deed office (through the Yard's side door)
 * - `gate`: your gate on the lane
 * - `door`: your cottage door
 * - `mailbox`: your mailbox, by the cottage
 * - `bench`: the workbench in your cottage
 * - `hearth`: the hearth in your cottage
 * - `wilds`: the Tangle, through the Commons arch
 */
export type GuideWhere = 'silas' | 'pell' | 'gate' | 'door' | 'mailbox' | 'bench' | 'hearth' | 'outdoors';

interface GuideStep {
  text: string;
  done: (ctx: GuideContext) => boolean;
  where?: GuideWhere;
}

export interface GuideDef {
  id: string;
  title: string;
  /** One line under the title. */
  blurb: string;
  /** Building and the bench need a world to keep them. */
  needsWorld?: boolean;
  steps: GuideStep[];
}

const claimed = (c: GuideContext) => c.claimed;
const cottage = (c: GuideContext) => c.tier >= 1;
const workshop = (c: GuideContext) => c.tier >= 2;
/** Made at your own bench: a tool with your maker's mark (one given or bought doesn't count). */
const madeTool = (c: GuideContext) => workshop(c) && c.madeTool;
const ownsShelf = (c: GuideContext) => c.homeGoods.some((g) => g.itemDef === 'gate-shelf');
const has = (c: GuideContext, m: Record<string, number>) => Object.entries(m).every(([k, n]) => (c.materials[k] ?? 0) >= n);
const materialsTotal = (c: GuideContext) => Object.values(c.materials).reduce((a, b) => a + b, 0);
const inTangle = (c: GuideContext) => c.flags.some((f) => f.startsWith('seen:wilds:'));

/** What Silas wants for a workshop (content/homestead.json, tier 2). */
const WORKSHOP_MATERIALS = { timber: 20, stone: 10, fiber: 8 };

export const GUIDES: GuideDef[] = [
  {
    id: 'claim',
    title: 'Claim a plot of your own',
    blurb: 'Pell keeps the deeds for the land behind the Commons gates, in a room at Silas’s Yard.',
    needsWorld: true,
    steps: [{ text: 'Go through the side door of Silas’s Yard and sign a deed with Pell.', done: claimed, where: 'pell' }],
  },
  {
    id: 'gather',
    title: 'Gather timber and stone',
    blurb: 'The Wilds give back what they’re done with: windfall, stone, fibre and amber.',
    needsWorld: true,
    steps: [
      { text: 'Walk up the Commons lane and through the arch into the Tangle.', done: inTangle, where: 'outdoors' },
      {
        text: 'Take your axe, pick or spade in hand, then work a tree, a stone or a stump. Camps and chests give too.',
        done: (c) => inTangle(c) && materialsTotal(c) >= 10,
        where: 'outdoors',
      },
    ],
  },
  {
    id: 'first-tool',
    title: 'Make your first tool',
    blurb: 'An axe, a pick or a spade, made at your own bench.',
    needsWorld: true,
    steps: [
      { text: 'Sign a deed with Pell at Silas’s Yard.', done: claimed, where: 'pell' },
      { text: 'Ask Silas to raise a cottage on your land.', done: cottage, where: 'silas' },
      {
        text: 'Bring 20 timber, 10 stone and 8 fibre back from the Wilds.',
        done: (c) => cottage(c) && (workshop(c) || has(c, WORKSHOP_MATERIALS)),
        where: 'outdoors',
      },
      { text: 'Ask Silas to build on a workshop.', done: workshop, where: 'silas' },
      { text: 'At the bench in your cottage, make a bench axe, pick or spade.', done: madeTool, where: 'bench' },
    ],
  },
  {
    id: 'fit',
    title: 'Fit a tool',
    blurb: 'A fitting set into a tool: a bead to glow, cord to grip.',
    needsWorld: true,
    steps: [
      { text: 'Make an amber bead or waxed cord at your bench, or find a fitting in the Wilds.', done: (c) => c.fittings > 0 || c.fitted, where: 'bench' },
      { text: 'Open your bag, pick the tool, and choose Fit.', done: (c) => c.fitted },
    ],
  },
  {
    id: 'hearth',
    title: 'Cook at the hearth',
    blurb: 'Teas, salves and oils, each with your maker’s mark.',
    needsWorld: true,
    steps: [
      { text: 'Sign a deed with Pell at Silas’s Yard.', done: claimed, where: 'pell' },
      { text: 'Ask Silas to raise a cottage on your land.', done: cottage, where: 'silas' },
      { text: 'At the hearth in your cottage, cook something you have the makings for.', done: (c) => cottage(c) && c.cooked > 0, where: 'hearth' },
    ],
  },
  {
    id: 'mail',
    title: 'Send something to a neighbour',
    blurb: 'Every plot has a mailbox. Pieces and parcels wait there to be collected.',
    needsWorld: true,
    steps: [
      { text: 'Sign a deed with Pell at Silas’s Yard.', done: claimed, where: 'pell' },
      { text: 'At the mailbox by your cottage, choose a neighbour and send.', done: (c) => c.claimed && c.sentMail, where: 'mailbox' },
    ],
  },
  {
    id: 'gate-shelf',
    title: 'Leave gifts on a gate shelf',
    blurb: 'A shelf by your gate, for travellers on the lane. One gift each a day.',
    needsWorld: true,
    steps: [
      { text: 'Ask Silas to build on a workshop.', done: workshop, where: 'silas' },
      {
        text: 'Make a gate shelf at your bench.',
        done: (c) => workshop(c) && ownsShelf(c),
        where: 'bench',
      },
      {
        text: 'Set it out by your gate on the lane.',
        done: (c) => workshop(c) && c.homeGoods.some((g) => g.itemDef === 'gate-shelf' && g.placed),
        where: 'gate',
      },
    ],
  },
];
