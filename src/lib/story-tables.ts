import papersRaw from '../../content/papers.json' with { type: 'json' };
import itemsRaw from '../../content/items.json' with { type: 'json' };
import questRaw from '../../content/quests.json' with { type: 'json' };
import storyRaw from '../../content/story.json' with { type: 'json' };
import vitalsRaw from '../../content/vitals.json' with { type: 'json' };
import type { PaperRule, QuestGate, QuestItem, QuestStep, QuestStart, QuestTrigger, QuestWhere } from './api/ports.ts';

/** A quest as `content/quests.json` holds it (the tree ./quests.ts walks). */
export interface Quest { id: string; title?: string; blurb?: string; line?: 'road' | 'village' | 'craft'; chapter?: number; after?: string[]; start?: QuestStart; needs?: 'habitica'; steps: QuestStep[] }
import { ROOMS, knownContentArea } from './rooms.ts';
import { residentById } from './residents.ts';
import { decodeContent } from './content-proto.ts';
import { QuestsSchema, type QuestsValid, type QuestValid, type QuestStepValid, type QuestTriggerValid, type QuestWhereValid, type QuestGateValid } from './gen/glimway/content/v1/quests_pb.js';
import { StorySchema, type StoryValid } from './gen/glimway/content/v1/story_pb.js';
import { PapersSchema, type PapersValid } from './gen/glimway/content/v1/papers_pb.js';
import { VitalsSchema, type VitalsValid } from './gen/glimway/content/v1/vitals_pb.js';


// ---------------------------------------------------------------- story

/** The story tables' own rule: one prefix per namespace. The mark
 * vocabularies (writer, npc/spot areas, quest-item ids) are on the
 * schema. */
function storyRules(doc: StoryValid): void {
  const seen = new Set<string>();
  for (const n of doc.namespaces) {
    if (seen.has(n.prefix)) throw new Error(`invalid story: duplicate namespace ${n.prefix}`);
    seen.add(n.prefix);
  }
}

/**
 * Reads story JSON through the schema (proto/glimway/content/v1/
 * story.proto). Shape note: `ids` was a map of maps and is now a map of
 * messages, each naming its pairs' `areas` — the loader reads it back
 * into the map-of-maps the client speaks.
 */
export type Story = Omit<StoryValid, 'ids'> & { ids: Record<string, Record<string, string>> };
export function validateStory(value: unknown): Story {
  const doc = decodeContent(StorySchema, value, 'story', ['namespaces']) as unknown as StoryValid;
  storyRules(doc);
  const ids: Record<string, Record<string, string>> = {};
  for (const [prefix, table] of Object.entries(doc.ids)) ids[prefix] = { ...table.areas };
  return { ...doc, ids };
}

// ---------------------------------------------------------------- quests

/**
 * The quests doc's own rules, read across the other tables — the twin of
 * validateQuests in content/quests.go (same tags). The per-step shape
 * (one trigger, the wait, the gate, the grants) is on the schema.
 */
function questsRules(doc: QuestsValid, story: StoryValid): void {
  const bad = (s: string): never => { throw new Error(`invalid quests: ${s}`); };
  const defs = new Set(itemsRaw.items.map(d => d.id));
  const paperIDs = new Set(papersRaw.papers.map(p => p.id));
  const spots: Record<string, string> = { ...story.spots };
  for (const r of ROOMS.rooms) for (const id of Object.keys(r.spots)) spots[id] = r.id;
  const npc = (id: string) => residentById(id) !== null || (story.npcs[id] ?? '') !== '';
  const writer = (mark: string) => story.namespaces.some(n => mark === n.prefix || n.prefix.endsWith(':') && mark.startsWith(n.prefix));
  const enemies = (id: string) => story.ids['defeated:']?.areas[id] ?? '';
  const byId = new Map<string, QuestValid>();
  const questItems = new Set(story.questItems);
  for (const q of doc.quests) {
    if (byId.has(q.id)) return bad(`duplicate id ${q.id}`);
    byId.set(q.id, q);
    for (const s of q.steps) for (const id of s.items) {
      if (!questItems.has(id)) return bad(`unknown quest item ${id}`);
    }
  }
  // A step's trigger names a target in the tables; `new` is only ever a
  // quest's start, and only true.
  const trigger = (t: QuestTriggerValid | undefined, start: boolean): void => {
    if (t === undefined) return bad('missing trigger');
    if (t.new !== undefined) {
      if (!start || !t.new) return bad('new trigger');
      return;
    }
    const ok = t.talk !== undefined ? npc(t.talk)
      : t.use !== undefined ? Object.hasOwn(spots, t.use)
      : t.reach !== undefined ? knownContentArea(t.reach)
      : t.defeat !== undefined ? enemies(t.defeat) !== ''
      : t.carry !== undefined ? defs.has(t.carry) || questItems.has(t.carry)
      : t.flag !== undefined ? writer(t.flag)
      : t.open !== undefined ? t.open === 'journal'
      : t.sync !== undefined ? t.sync === 'embers'
      : false;
    if (!ok) return bad('unknown trigger target');
  };
  for (const q of doc.quests) {
    if (q.start !== undefined) trigger(q.start, true);
    for (let i = 0; i < q.steps.length; i++) {
      const s = q.steps[i]!;
      if (s.at !== '' && !knownContentArea(s.at)) return bad(`step ${q.id}:${s.id}`);
      for (const mark of s.marks) if (!writer(mark)) return bad(`unknown mark ${mark}`);
      for (const id of s.papers) if (!paperIDs.has(id)) return bad(`unknown paper ${id}`);
      const g = s.gate;
      if (g !== undefined) {
        if (g.with !== '' && !npc(g.with)) return bad(`gate ${s.id}`);
        if (g.wait !== undefined && i === 0) return bad(`wait ${s.id}`);
        if (g.item !== undefined && !defs.has(g.item.def)) return bad(`gate item ${s.id}`);
      }
      for (const item of s.give) if (!defs.has(item.def)) return bad(`give ${s.id}`);
      trigger(s.do, false);
      const t = s.do;
      if (t.talk !== undefined) {
        if (residentById(t.talk) !== null) {
          if (s.at !== '' || g === undefined || g.with !== t.talk) return bad(`resident talk ${s.id}`);
        } else if (s.at !== (story.npcs[t.talk] ?? '')) {
          return bad(`npc area ${s.id}`);
        }
      }
      if (t.use !== undefined && s.at !== spots[t.use] || t.reach !== undefined && s.at !== t.reach || t.defeat !== undefined && s.at !== enemies(t.defeat)) return bad(`trigger area ${s.id}`);
      const w = s.where;
      if (w !== undefined) {
        if (w.npc !== '') {
          if (!npc(w.npc)) return bad(`where npc ${s.id}`);
          if (residentById(w.npc) === null && w.area !== '' && w.area !== (story.npcs[w.npc] ?? '')) return bad(`where npc area ${s.id}`);
        }
        if (w.spot !== '' && (spots[w.spot] === undefined || w.area !== '' && w.area !== spots[w.spot]) || w.enemy !== '' && (enemies(w.enemy) === '' || w.area !== '' && w.area !== enemies(w.enemy))) return bad(`where target ${s.id}`);
      }
    }
    const refs = new Set<string>();
    for (const ref of q.after) {
      const parts = ref.split(':');
      const target = byId.get(parts[0]!);
      if (!target || parts.length > 2 || refs.has(ref) || parts.length === 2 && !target.steps.some(s => s.id === parts[1])) return bad(`after ${ref}`);
      refs.add(ref);
    }
  }
  // The after-graph is acyclic.
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (done.has(id)) return true;
    visiting.add(id);
    for (const ref of byId.get(id)!.after) if (!visit(ref.split(':')[0]!)) return false;
    visiting.delete(id);
    done.add(id);
    return true;
  };
  for (const id of byId.keys()) if (!visit(id)) return bad('after cycle');
}

// The loader's resolved view: the generated quest tree mapped onto the
// port types the client already speaks (plain objects, optional keys only
// where the file had them) — message instances carry $typeName.
const triggerOut = (t: QuestTriggerValid | undefined): QuestStart | undefined => {
  if (t === undefined) return undefined;
  if (t.new !== undefined) return { new: true };
  if (t.talk !== undefined) return { talk: t.talk };
  if (t.use !== undefined) return { use: t.use };
  if (t.reach !== undefined) return { reach: t.reach };
  if (t.defeat !== undefined) return { defeat: t.defeat };
  if (t.carry !== undefined) return { carry: t.carry };
  if (t.flag !== undefined) return { flag: t.flag };
  if (t.open !== undefined) return { open: 'journal' };
  return { sync: 'embers' };
};
const whereOut = (w: QuestWhereValid | undefined): QuestWhere | undefined => {
  if (w === undefined) return undefined;
  const out: QuestWhere = {};
  if (w.area !== '') out.area = w.area;
  if (w.npc !== '') out.npc = w.npc;
  if (w.spot !== '') out.spot = w.spot;
  if (w.enemy !== '') out.enemy = w.enemy;
  if (w.ui !== '') out.ui = 'journal';
  return out;
};
const itemOut = (i: { def: string; qty: number }): QuestItem => ({ def: i.def, qty: i.qty });
const gateOut = (g: QuestGateValid | undefined): QuestGate | undefined => {
  if (g === undefined) return undefined;
  const out: QuestGate = {};
  if (g.with !== '') out.with = g.with;
  if (g.wait !== undefined) out.wait = g.wait.hours !== undefined ? { hours: g.wait.hours } : { turnings: g.wait.turnings! };
  if (g.item !== undefined) out.item = { ...itemOut(g.item), keep: g.item.keep ?? false };
  if (g.embers !== undefined) out.embers = g.embers;
  return out;
};
const stepOut = (s: QuestStepValid): QuestStep => ({
  id: s.id,
  at: s.at,
  items: s.items,
  marks: s.marks,
  papers: s.papers,
  embers: s.embers,
  witness: s.witness,
  goal: s.goal,
  objective: s.objective,
  where: whereOut(s.where),
  do: triggerOut(s.do) as QuestTrigger,
  gate: gateOut(s.gate),
  give: s.give.map(itemOut),
  note: s.note !== undefined ? { title: s.note.title, body: s.note.body } : undefined,
  moment: s.moment !== undefined ? { eyebrow: s.moment.eyebrow, title: s.moment.title } : undefined,
});
const questOut = (q: QuestValid): Quest => ({
  id: q.id,
  title: q.title,
  blurb: q.blurb,
  line: q.line === '' ? undefined : q.line as Quest['line'],
  chapter: q.chapter !== undefined ? Number(q.chapter) : undefined,
  after: q.after,
  start: triggerOut(q.start),
  needs: q.needs === '' ? undefined : q.needs as Quest['needs'],
  steps: q.steps.map(stepOut),
});

/**
 * Reads quests JSON through the schema (proto/glimway/content/v1/
 * quests.proto): nulls and unknown keys refused, the schema's rules run,
 * then the tree's own rules in code (questsRules, above).
 */
export function validateQuests(value: unknown): Quest[] {
  const doc = decodeContent(QuestsSchema, value, 'quests', ['quests']) as unknown as QuestsValid;
  const story = decodeContent(StorySchema, storyRaw, 'story', ['namespaces']) as unknown as StoryValid;
  questsRules(doc, story);
  return doc.quests.map(questOut);
}

// ---------------------------------------------------------------- papers

/**
 * Reads papers JSON through the schema (proto/glimway/content/v1/
 * papers.proto): the sources, shelf signs and each find rule's own fields
 * are on it; the catalog's one rule — one id per paper — stays here,
 * naming the duplicate.
 */
export function validatePapers(value: unknown): Map<string, PaperRule> {
  const doc = decodeContent(PapersSchema, value, 'papers', ['papers']) as unknown as PapersValid;
  const rules = new Map<string, PaperRule>();
  for (const p of doc.papers) {
    if (rules.has(p.id)) throw new Error(`invalid papers: duplicate id ${p.id}`);
    const r = p.rule;
    const out: PaperRule = { kind: r.kind };
    if (r.area !== '') out.area = r.area;
    if (r.tx !== 0) out.tx = r.tx;
    if (r.ty !== 0) out.ty = r.ty;
    if (r.after !== '') out.after = r.after;
    if (r.stage !== '') out.stage = r.stage;
    if (r.from !== '') out.from = r.from;
    if (r.project !== '') out.project = r.project;
    if (r.fact !== '') out.fact = r.fact;
    if (r.poi !== '') out.poi = r.poi;
    if (r.site !== '') out.site = r.site;
    if (r.member !== '') out.member = r.member;
    if (r.paper !== '') out.paper = r.paper;
    if (r.roadLit) out.roadLit = true;
    if (r.east) out.east = true;
    if (r.mark !== '') out.mark = r.mark;
    if (r.tier !== 0) out.tier = r.tier;
    if (r.unbuilt) out.unbuilt = true;
    rules.set(p.id, out);
  }
  return rules;
}

// ---------------------------------------------------------------- vitals

/**
 * Reads vitals JSON through the schema (proto/glimway/content/v1/
 * vitals.proto); there are no rules left in code.
 */
export type Vitals = VitalsValid;
export function validateVitals(value: unknown): Vitals {
  return decodeContent(VitalsSchema, value, 'vitals', []) as unknown as Vitals;
}

export const QUESTS = validateQuests(questRaw);
export const STORY = validateStory(storyRaw);
export const VITALS = validateVitals(vitalsRaw);
export const PAPER_RULES = validatePapers(papersRaw);
