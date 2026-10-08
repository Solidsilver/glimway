import papersRaw from '../../content/papers.json' with { type: 'json' };
import type { PaperRule } from './api/ports.ts';
import questRaw from '../../content/quests.json' with { type: 'json' };
import storyRaw from '../../content/story.json' with { type: 'json' };
import vitalsRaw from '../../content/vitals.json' with { type: 'json' };
import type { QuestStep } from './api/ports.ts';
export interface Quest { id: string; steps: QuestStep[] }
export function validateQuests(value: unknown): Quest[] {
  const doc = value as { quests: Quest[] };
  if (!doc || !Array.isArray(doc.quests) || !doc.quests.length) throw new Error('invalid quests');
  const quests = new Set<string>();
  for (const q of doc.quests) {
    if (!q.id || quests.has(q.id) || !Array.isArray(q.steps) || !q.steps.length) throw new Error('invalid quest');
    quests.add(q.id); const steps = new Set<string>();
    for (const s of q.steps) {
      if (!s.id || steps.has(s.id) || !['village','woodland','ruin','commons'].includes(s.at) || !Number.isSafeInteger(s.embers) || s.embers < 0 || ![s.items,s.marks,s.papers].every(v => Array.isArray(v) && v.every(id => typeof id === 'string' && id.length > 0))) throw new Error('invalid quest step');
      steps.add(s.id);
    }
  }
  return doc.quests;
}
export function validateStory(value: unknown): typeof storyRaw {
  const s = value as typeof storyRaw;
  if (!s || !Array.isArray(s.namespaces) || !s.namespaces.length || !s.ids || !s.areas || !Array.isArray(s.echoes) || s.echoes.length !== 6) throw new Error('invalid story');
  const prefixes = new Set<string>();
  for (const n of s.namespaces) { if (!n.prefix || prefixes.has(n.prefix) || !['client','server'].includes(n.writer)) throw new Error('invalid namespace'); prefixes.add(n.prefix); }
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
