import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CALENDAR, calendarAt, validateCalendar } from '../src/lib/calendar.ts';
import { CRAFTING, PROJECTS, validateCrafting, validateProjects } from '../src/lib/workshop.ts';
import { serializeCalendarVectors } from '../scripts/calendar-vectors.ts';
import { VILLAGE_PROJECTS } from '../src/content/expansion-writing.ts';
import { PAPERS } from '../src/content/papers.ts';
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts';

test('calendar parity vectors are current, with complete UTC boundary and festival coverage', () => {
  assert.equal(JSON.stringify(JSON.parse(readFileSync(new URL('../content/vectors/clock.json', import.meta.url), 'utf8')).calendar) + '\n', serializeCalendarVectors());
  const epoch = Date.parse(CALENDAR.epoch) / 1000;
  for (const [i, wick] of CALENDAR.wicks.entries()) { const d = calendarAt(epoch + i * 7 * 86400); assert.equal(d.wick, wick); assert.equal(d.day, 1); assert.equal(d.wickNumber, i+1); }
  for (const f of CALENDAR.festivals) assert.equal(calendarAt(epoch + (CALENDAR.wicks.indexOf(f.wick) * 7 + f.day - 1) * 86400).festival, f.name);
  assert.equal(calendarAt(epoch-1).wick, 'Quiet'); assert.equal(calendarAt(epoch-1).day, 7);
  assert.equal(calendarAt(epoch+84*86400).year, 2); assert.equal(calendarAt(epoch+84*86400).wickNumber, 13);
  assert.equal(calendarAt(epoch+6*86400-1).notice, null); assert.ok(calendarAt(epoch+6*86400).notice);
  const nine = { ...CALENDAR, wickDays: 9 }; assert.equal(calendarAt(epoch+8*86400, nine).day, 9);
});
test('calendar loader rejects invalid durations, order, epochs and festivals', () => {
  for (const mutate of [(c: typeof CALENDAR) => { c.wickDays=0; }, (c: typeof CALENDAR) => { c.wicks.reverse(); }, (c: typeof CALENDAR) => { c.epoch='2026-02-30T00:00:00Z'; }, (c: typeof CALENDAR) => { c.festivals[0].day=20; }, (c: typeof CALENDAR) => { c.festivals[0].wick='Absent'; }]) { const c=structuredClone(CALENDAR);mutate(c);assert.throws(()=>validateCalendar(c)); }
  assert.throws(()=>calendarAt(NaN));
});
test('workshop has bounded recipes using known decorations, utility items and item definitions', () => {
  assert.equal(CRAFTING.recipes.length,39); assert.equal(HOMESTEAD_DATA.tiers[2].purchasable,true);assert.ok(HOMESTEAD_DATA.tiers[2].embers>0);assert.ok(Object.keys(HOMESTEAD_DATA.tiers[2].materials!).length>0);
  for (const r of CRAFTING.recipes) if (r.output.kind==='decoration') assert.ok(HOMESTEAD_DATA.items.some(v=>v.id===r.output.id));
  for (const mutate of [(c: typeof CRAFTING)=>{c.recipes[0].output.id='absent';},(c: typeof CRAFTING)=>{c.recipes[0].materials={};},(c: typeof CRAFTING)=>{c.recipes[0].output.qty=0;},(c: typeof CRAFTING)=>{c.recipes[0].minTier=1;},(c: typeof CRAFTING)=>{c.recipes[1].id=c.recipes[0].id;}]){const c=structuredClone(CRAFTING);mutate(c);assert.throws(()=>validateCrafting(c));}
  for (const v of [null,{},[],{...CRAFTING,recipes:[null]}]) assert.throws(()=>validateCrafting(v));
});
test('the hearth has the craft-and-repair recipes: tier 1, food, remedies and oils, unique ids', () => {
  assert.equal(CRAFTING.hearthRecipes?.length, 10);
  const ids = new Set(CRAFTING.recipes.map(r=>r.id));
  for (const r of CRAFTING.hearthRecipes!) {
    assert.equal(r.minTier, 1, `${r.id} cooks at the cottage`);
    assert.ok(!ids.has(r.id), `${r.id} is its own recipe`);
    ids.add(r.id);
    assert.ok(['item','material'].includes(r.output.kind), `${r.id} makes something you carry`);
    assert.ok(r.output.qty >= 1, `${r.id} makes at least one`);
  }
  for (const id of ['hearth-saltings-tea','hearth-comfrey-salve','hearth-candle-oil','hearth-willow-bark-tea','hearth-hearth-oil','hearth-keepers-twists','hearth-oil-twists','hearth-wax-seal','hearth-storm-oil']) assert.ok(ids.has(id), id);
  for (const mutate of [(c: typeof CRAFTING)=>{c.hearthRecipes![0].minTier=2;},(c: typeof CRAFTING)=>{c.hearthRecipes![0].output.kind='decoration';},(c: typeof CRAFTING)=>{c.hearthRecipes![1].id=c.hearthRecipes![0].id;},(c: typeof CRAFTING)=>{c.hearthRecipes![0].output.qty=0;}]){const c=structuredClone(CRAFTING);mutate(c);assert.throws(()=>validateCrafting(c));}
});
test('projects include the authored village works and every village-project paper', () => {
  for (const p of VILLAGE_PROJECTS) assert.ok(PROJECTS.projects.some(v=>v.id===p.id && v.name===p.name));
  const projectPapers = PROJECTS.projects.flatMap(p=>p.papers).sort();
  assert.deepEqual(projectPapers, PAPERS.filter(p=>p.source.kind==='village-project').map(p=>p.id).sort());
  for (const mutate of [(p:typeof PROJECTS)=>{p.projects[0].papers=['absent'];},(p:typeof PROJECTS)=>{p.projects[0].papers=[];},(p:typeof PROJECTS)=>{p.projects[0].materials={gold:1};},(p:typeof PROJECTS)=>{p.projects[0].worldFlag='forged';}]){const p=structuredClone(PROJECTS);mutate(p);assert.throws(()=>validateProjects(p));}
});
