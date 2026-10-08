import papersRaw from '../../content/papers.json' with { type: 'json' };
import type { PaperRule } from './api/ports.ts';
import questRaw from '../../content/quests.json' with { type: 'json' };
import storyRaw from '../../content/story.json' with { type: 'json' };
import vitalsRaw from '../../content/vitals.json' with { type: 'json' };
import type { QuestStep, QuestStart, QuestWhere } from './api/ports.ts';
import itemsRaw from '../../content/items.json' with { type: 'json' };
import { ROOMS, knownContentArea } from './rooms.ts';
import { residentById } from './residents.ts';
export interface Quest { id: string; title?: string; blurb?: string; line?: 'road' | 'village' | 'craft'; chapter?: number; after?: string[]; start?: QuestStart; needs?: 'habitica'; steps: QuestStep[] }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const contentId = (v: unknown): v is string => typeof v === 'string' && v.length <= 100 && /^[a-z0-9-]+$/.test(v);
const questId = (v: unknown): v is string => contentId(v) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v);
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every(k => allowed.includes(k)); }
export function validateQuests(value: unknown): Quest[] {
  const bad = (s: string): never => { throw new Error(`invalid quests: ${s}`); };
  if (!object(value) || !keys(value, ['quests']) || !Array.isArray(value.quests) || !value.quests.length) return bad('empty');
  const doc = value as unknown as { quests: Quest[] }, byId = new Map<string, Quest>();
  const defs = new Set(itemsRaw.items.map(d => d.id)), papers = new Set(papersRaw.papers.map(p => p.id));
  const questItems = new Set(storyRaw.questItems);
  const npcs: Record<string, string> = storyRaw.npcs, enemies: Record<string, string> = storyRaw.ids['defeated:'];
  const spots: Record<string, string> = { ...storyRaw.spots };
  for (const r of ROOMS.rooms) for (const id of Object.keys(r.spots)) spots[id] = r.id;
  const npc = (id: string) => !!residentById(id) || Object.hasOwn(npcs, id);
  const writer = (mark: string) => storyRaw.namespaces.some(n => mark === n.prefix || n.prefix.endsWith(':') && mark.startsWith(n.prefix));
  for (const q of doc.quests) {
    if (!object(q) || !keys(q, ['id','title','blurb','line','chapter','after','start','needs','steps']) || !questId(q.id) || byId.has(q.id) || !Array.isArray(q.steps) || !q.steps.length || q.line !== undefined && !['road','village','craft'].includes(q.line) || q.chapter !== undefined && (!Number.isSafeInteger(q.chapter) || q.chapter < 0 || q.line !== 'road') || q.needs !== undefined && q.needs !== 'habitica' || [q.title,q.blurb].some(v => v !== undefined && typeof v !== 'string')) return bad('quest');
    byId.set(q.id, q);
    for (const s of q.steps) { if (!object(s) || !Array.isArray(s.items) || !s.items.every(id => typeof id === 'string' && questItems.has(id))) return bad('quest items'); }
  }
  const trigger = (v: unknown, start: boolean) => {
    if (!object(v) || Object.keys(v).length !== 1) return bad('one trigger required');
    const [kind, target] = Object.entries(v)[0]!;
    if (kind === 'new') { if (!start || target !== true) return bad('new trigger'); return; }
    if (typeof target !== 'string' || !target) return bad('trigger target');
    const valid = kind === 'talk' ? npc(target) : kind === 'use' ? Object.hasOwn(spots, target) : kind === 'reach' ? knownContentArea(target) : kind === 'defeat' ? Object.hasOwn(enemies, target) : kind === 'carry' ? defs.has(target) || questItems.has(target) : kind === 'flag' ? writer(target) : kind === 'open' ? target === 'journal' : kind === 'sync' ? target === 'embers' : false;
    if (!valid) return bad('unknown trigger target');
  };
  for (const q of doc.quests) {
    if (q.start !== undefined) trigger(q.start, true);
    const steps = new Set<string>();
    for (let i = 0; i < q.steps.length; i++) {
      const s = q.steps[i]!;
      if (!keys(s as unknown as Record<string, unknown>, ['id','at','items','marks','papers','embers','witness','goal','objective','where','do','gate','give','note','moment']) || !questId(s.id) || steps.has(s.id) || typeof s.at !== 'string' || s.at && !knownContentArea(s.at) || !Number.isSafeInteger(s.embers) || s.embers < 0 || s.embers > 5 || ![s.items,s.marks,s.papers].every(v => Array.isArray(v) && v.every(id => typeof id === 'string' && id.length > 0)) || typeof s.witness !== 'string' || s.witness && !['warden','lantern'].includes(s.witness) || s.goal !== undefined && (typeof s.goal !== 'string' || [...s.goal].length > 40) || s.objective !== undefined && typeof s.objective !== 'string') return bad(`step ${q.id}:${s.id}`);
      steps.add(s.id); trigger(s.do, false);
      if (s.marks.some(m => !writer(m)) || s.papers.some(p => !papers.has(p))) return bad('unknown grant');
      const g = s.gate;
      if (g !== undefined) {
        if (!object(g) || !Object.keys(g).length || !keys(g, ['with','wait','item','embers']) || g.with !== undefined && (typeof g.with !== 'string' || !npc(g.with)) || g.embers !== undefined && !positive(g.embers)) return bad('gate');
        if (g.wait !== undefined) {
          const w = g.wait;
          if (!object(w) || Object.keys(w).length !== 1 || !keys(w, ['hours','turnings']) || i === 0 || ('hours' in w ? typeof w.hours !== 'number' || !Number.isFinite(w.hours) || w.hours <= 0 : !positive(w.turnings))) return bad('wait');
        }
        if (g.item !== undefined && (!object(g.item) || !keys(g.item, ['def','qty','keep']) || typeof g.item.def !== 'string' || !defs.has(g.item.def) || !positive(g.item.qty) || typeof g.item.keep !== 'boolean')) return bad('gate item');
      }
      if (s.give !== undefined) {
        if (!Array.isArray(s.give) || s.give.length && !g) return bad('ungated give');
        const given = new Set<string>();
        for (const item of s.give) { if (!object(item) || !keys(item, ['def','qty']) || typeof item.def !== 'string' || !defs.has(item.def) || !positive(item.qty) || given.has(item.def)) return bad('give'); given.add(item.def); }
      }
      if (s.note !== undefined && (!object(s.note) || !keys(s.note, ['title','body']) || typeof s.note.title !== 'string' || !s.note.title || typeof s.note.body !== 'string' || !s.note.body) || s.moment !== undefined && (!object(s.moment) || !keys(s.moment, ['eyebrow','title']) || typeof s.moment.title !== 'string' || !s.moment.title || typeof s.moment.eyebrow !== 'string' || !s.moment.eyebrow)) return bad('note/moment');
      const t = s.do as unknown as Record<string, string>;
      const anywhere = ['carry','open','sync','flag'].some(k => k in t);
      if (!s.at && !anywhere && !g?.with) return bad('empty at');
      if (t.talk) {
        if (residentById(t.talk) ? s.at !== '' || g?.with !== t.talk : s.at !== npcs[t.talk]) return bad('talk area');
      }
      if (t.use && s.at !== spots[t.use] || t.reach && s.at !== t.reach || t.defeat && s.at !== enemies[t.defeat]) return bad('trigger area');
      const w = s.where;
      if (w !== undefined) {
        if (!object(w) || !keys(w, ['area','npc','spot','enemy','ui']) || [w.area,w.npc,w.spot,w.enemy,w.ui].some(v => v !== undefined && (typeof v !== 'string' || !v))) return bad('where');
        const guide = w as QuestWhere;
        const targets = [guide.npc,guide.spot,guide.enemy,guide.ui].filter(v => v !== undefined);
        if (targets.length > 1 || !targets.length && !guide.area || guide.area && !knownContentArea(guide.area) || guide.ui && (guide.ui !== 'journal' || guide.area)) return bad('where');
        if (guide.npc && (!npc(guide.npc) || !residentById(guide.npc) && guide.area && guide.area !== npcs[guide.npc]) || guide.spot && (!Object.hasOwn(spots,guide.spot) || guide.area && guide.area !== spots[guide.spot]) || guide.enemy && (!Object.hasOwn(enemies,guide.enemy) || guide.area && guide.area !== enemies[guide.enemy])) return bad('where target');
      }
    }
    if (q.after !== undefined) {
      if (!Array.isArray(q.after)) return bad('after'); const refs = new Set<string>();
      for (const ref of q.after) {
        if (typeof ref !== 'string') return bad('after'); const parts = ref.split(':'), target = byId.get(parts[0]!);
        if (!target || parts.length > 2 || refs.has(ref) || parts.length === 2 && !target.steps.some(s => s.id === parts[1])) return bad(`after ${ref}`);
        refs.add(ref);
      }
    }
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false; if (done.has(id)) return true;
    visiting.add(id); for (const ref of byId.get(id)!.after ?? []) if (!visit(ref.split(':')[0]!)) return false;
    visiting.delete(id); done.add(id); return true;
  };
  for (const id of byId.keys()) if (!visit(id)) return bad('after cycle');
  return doc.quests;
}
export function validateStory(value: unknown): typeof storyRaw {
  const s = value as typeof storyRaw;
  if (!s || !Array.isArray(s.namespaces) || !s.namespaces.length || !s.ids || !s.areas || !Array.isArray(s.echoes) || s.echoes.length !== 6) throw new Error('invalid story');
  const prefixes = new Set<string>();
  for (const n of s.namespaces) { if (!n.prefix || prefixes.has(n.prefix) || !['client','server'].includes(n.writer)) throw new Error('invalid namespace'); prefixes.add(n.prefix); }
  for (const table of [s.npcs, s.spots]) {
    if (!object(table) || !Object.keys(table).length || !Object.entries(table).every(([id, area]) => contentId(id) && ['village','woodland','ruin','commons'].includes(area))) throw new Error('invalid story targets');
  }
  if (!Array.isArray(s.questItems) || !s.questItems.length || !s.questItems.every(contentId) || new Set(s.questItems).size !== s.questItems.length) throw new Error('invalid story quest items');
  return s;
}
export function validateVitals(value: unknown): typeof vitalsRaw {
  const v = value as typeof vitalsRaw;
  if (!v || ![v.regenCap,v.fallHpFraction,v.fallManaFraction,v.reportGapCap].every(n => Number.isFinite(n) && n > 0) || v.fallHpFraction > 1 || v.fallManaFraction > 1) throw new Error('invalid vitals');
  return v;
}
export const QUESTS = validateQuests(questRaw);
export const STORY = validateStory(storyRaw);
export const VITALS = validateVitals(vitalsRaw);

/** The same find rules the server embeds, including server-only grant sources. */
export function validatePapers(value: unknown): Map<string, PaperRule> {
  const doc = value as { papers: { id: string; collection: string; source: string; rule: PaperRule }[] };
  if (!doc || !Array.isArray(doc.papers) || !doc.papers.length) throw new Error('invalid papers');
  const rules = new Map<string, PaperRule>();
  for (const p of doc.papers) {
    if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 122 || rules.has(p.id) || !p.collection || !p.rule || p.rule.kind !== p.source || !['library-start','placed','quest','gift','commons','wilds-poi','wilds-chest','village-project','turning','echo'].includes(p.source)) throw new Error('invalid paper');
    const r = p.rule;
    if (p.source === 'placed' && (!r.area || !Number.isSafeInteger(r.tx) || r.tx! < 0 || !Number.isSafeInteger(r.ty) || r.ty! < 0) || ['quest','gift'].includes(p.source) && !r.stage || p.source === 'village-project' && !r.project || p.source === 'commons' && !r.fact || p.source === 'wilds-poi' && !r.poi && !r.site || p.source === 'wilds-chest' && r.tier !== 3 || p.source === 'echo' && !r.member || p.source === 'turning' && !r.unbuilt && !r.fact && !r.site) throw new Error('invalid paper find rule');
    rules.set(p.id, r);
  }
  return rules;
}
export const PAPER_RULES = validatePapers(papersRaw);
