import { designedSource } from '../../src/content/papers.ts';

/** Full server find rules, retained by the catalog generator. */
export interface PaperRule {
  kind: string; area?: string; tx?: number; ty?: number; after?: string; stage?: string; from?: string;
  project?: string; fact?: string; poi?: string; site?: string; member?: string; paper?: string;
  roadLit?: boolean; east?: boolean; mark?: string; tier?: number; unbuilt?: boolean;
}
const FIND_RULES: Record<string, Omit<PaperRule, 'kind'>> = {
  "to-the-bench-across": {
    "area": "hearthwick",
    "fact": "silas-toolbox"
  },
  "silas-pine-offcut-scrap": {
    "area": "hearthwick",
    "fact": "door-fox"
  },
  "orrins-drift-slap-foundation-standard": {
    "area": "hearthwick",
    "fact": "foundation"
  },
  "deed-of-sale-commons-plot": {
    "area": "hearthwick",
    "fact": "plot"
  },
  "the-hame-polishers-list": {
    "area": "hearthwick",
    "fact": "carting-day"
  },
  "joss-penhallow-letter-map-case": {
    "unbuilt": true
  },
  "failed-grid-of-sector-4": {
    "poi": "old-shrine"
  },
  "joss-penhallow-field-notes-pencil-map": {
    "poi": "mossy-arch",
    "roadLit": true,
    "east": true
  },
  "the-blind-routes-smugglers-ledger": {
    "tier": 3
  },
  "nan-greer-trail-journal": {
    "site": "given",
    "roadLit": true,
    "fact": "turned"
  },
  "mary-fenns-cairn-slip": {
    "site": "cairn",
    "paper": "will-of-elias-fenn"
  },
  "the-jackdaws-display": {
    "site": "nest",
    "roadLit": true
  },
  "a-salting-drift-table": {
    "site": "reeds",
    "mark": "Mudrise",
    "paper": "elara-quill-field-notes-turncaps"
  },
  "dorrits-second-span": {
    "site": "plank"
  },
  "weir-effect-survey-draft": {
    "fact": "turning",
    "roadLit": true
  },
  "notices-from-the-board": {
    "fact": "board",
    "roadLit": true
  },
  "betts-flat-verse": {
    "member": "bett"
  },
  "tams-ox-words": {
    "member": "tam"
  },
  "count-house-tally-book-scrap": {
    "project": "north-bridge"
  },
  "forty-one-and-holding": {
    "project": "mill-wheel"
  },
  "note-in-the-linseed-box": {
    "project": "mill-wheel"
  },
  "marens-notes-on-hubs-and-tyres": {
    "project": "wheel-wick-guildhouse"
  },
  "tarrow-requisition-reply-hinges": {
    "project": "orrins-hinges"
  },
  "adas-oil-receipts": {
    "project": "cooley-window-fund"
  }
};
export function designedRule(id: string): PaperRule | undefined {
  const s = designedSource(id);
  if (!s) return undefined;
  if (s.kind === 'placed') return { kind: s.kind, area: s.area, tx: s.tx, ty: s.ty, ...(s.after ? { after: s.after } : {}) };
  if (s.kind === 'quest' || s.kind === 'gift') return { kind: s.kind, stage: s.stage, ...('from' in s && s.from ? { from: s.from, area: 'hearthwick' } : {}) };
  return { kind: s.kind, ...FIND_RULES[id] };
}

