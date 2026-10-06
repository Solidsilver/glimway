import test from 'node:test';
import assert from 'node:assert/strict';
import { allGuides, guideById, guideFlag, guideProgress, GUIDES, newlyMet, type GuideContext } from '../src/lib/guides.ts';

const base = (over: Partial<GuideContext> = {}): GuideContext => ({
  connected: true,
  claimed: false,
  tier: -1,
  tools: [],
  madeTool: false,
  fitted: false,
  fittings: 0,
  materials: {},
  cooked: 0,
  sentMail: false,
  homeGoods: [],
  flags: [],
  ...over,
});

test('guides: the text is short, in-world, and every step says where or what', () => {
  const words = /\b(habit|task|to-?do|daily|XP|app|Habitica|streak)s?\b/i;
  assert.ok(GUIDES.length >= 6);
  for (const g of GUIDES) {
    for (const line of [g.title, g.blurb, ...g.steps.map((s) => s.text)]) {
      assert.ok(line.length > 0 && line.length <= 160, `${g.id}: "${line}"`);
      assert.doesNotMatch(line, words, `${g.id}: "${line}"`);
    }
    assert.ok(g.steps.length > 0, g.id);
  }
  assert.equal(new Set(GUIDES.map((g) => g.id)).size, GUIDES.length, 'ids are unique');
});

test('guides: each step stands on its own; a workshop means the deed and cottage steps are met', () => {
  const g = guideById('first-tool')!;
  const p = guideProgress(g, base({ claimed: true, tier: 2 }));
  assert.deepEqual(p.steps.map((s) => s.done), [true, true, true, true, false]);
  assert.equal(p.current, 4);
  assert.equal(p.steps[4].where, 'bench');
  assert.equal(guideProgress(g, base({ claimed: true, tier: 2, madeTool: true })).done, true);
});

test('guides: a tool given or found (an heirloom, no deed) is not "your first tool"', () => {
  const p = guideProgress(guideById('first-tool')!, base({ tools: ['chop', 'break', 'dig'] }));
  assert.equal(p.done, false);
  assert.deepEqual(p.steps.map((s) => s.done), [false, false, false, false, false]);
  assert.equal(p.current, 0);
  // Even with a workshop, a tool someone else made doesn't finish it.
  assert.equal(guideProgress(guideById('first-tool')!, base({ claimed: true, tier: 2, tools: ['chop'] })).done, false);
});

test('guides: materials carried with no deed tick nothing before them', () => {
  const p = guideProgress(guideById('first-tool')!, base({ materials: { timber: 20, stone: 10, fiber: 8 } }));
  assert.deepEqual(p.steps.map((s) => s.done), [false, false, false, false, false]);
  assert.equal(p.steps[0].where, 'silas');
});

test('guides: a met step is remembered in the save and never un-ticks', () => {
  const g = guideById('hearth')!;
  const cooking = base({ claimed: true, tier: 1, cooked: 2 });
  const flags = newlyMet(cooking);
  assert.ok(flags.includes(guideFlag('hearth', 2)), 'cooking is recorded');
  // The tea drunk: nothing carried, yet the step stays done.
  const later = guideProgress(g, base({ claimed: true, tier: 1, cooked: 0, flags }));
  assert.equal(later.done, true);
  // Recorded steps aren't offered again; guests record nothing.
  assert.equal(newlyMet(base({ claimed: true, tier: 1, cooked: 2, flags })).filter((f) => f.startsWith('guide:hearth')).length, 0);
  assert.deepEqual(newlyMet(base({ connected: false, claimed: true, tier: 1, cooked: 2 })), []);
});

test('guides: a fresh player starts at the first step; the Silas steps point at Silas', () => {
  const p = guideProgress(guideById('first-tool')!, base());
  assert.equal(p.current, 0);
  assert.equal(p.steps[0].where, 'silas');
  // Enough materials but no workshop yet: that step is done, Silas is next.
  const q = guideProgress(guideById('first-tool')!, base({ claimed: true, tier: 1, materials: { timber: 20, stone: 10, fiber: 8 } }));
  assert.equal(q.current, 3);
  // A gate shelf from a neighbour doesn't stand for a workshop.
  const shelf = guideProgress(guideById('gate-shelf')!, base({ claimed: true, tier: 0, homeGoods: [{ itemDef: 'gate-shelf', placed: true }] }));
  assert.deepEqual(shelf.steps.map((s) => s.done), [false, false, false]);
});

test('guides: guests see the world guides locked', () => {
  for (const p of allGuides(base({ connected: false }))) if (p.guide.needsWorld) assert.equal(p.locked, true, p.guide.id);
});

test('guides: the gate shelf is done once it stands by the gate', () => {
  const g = guideById('gate-shelf')!;
  assert.equal(guideProgress(g, base({ tier: 2, claimed: true, homeGoods: [{ itemDef: 'gate-shelf', placed: false }] })).current, 2);
  assert.equal(guideProgress(g, base({ tier: 2, claimed: true, homeGoods: [{ itemDef: 'gate-shelf', placed: true }] })).done, true);
});
