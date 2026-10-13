import test from 'node:test';
import assert from 'node:assert/strict';
import { refusalMatchesRule } from './helpers/vector-rule.ts';
import { validateItems } from '../src/lib/items.ts';
import { validateHomesteadData } from '../src/lib/homestead.ts';
import { validateGathering } from '../src/lib/gathering.ts';
import { validateRepairs } from '../src/lib/repairs.ts';
import { validateCrafting, validateProjects } from '../src/lib/workshop.ts';
import { validateAbilities } from '../src/lib/abilities.ts';
import { validateFishing } from '../src/lib/fishing.ts';
import itemsRaw from '../content/items.json' with { type: 'json' };
import homesteadRaw from '../content/homestead.json' with { type: 'json' };
import gatheringRaw from '../content/gathering.json' with { type: 'json' };
import repairsRaw from '../content/repairs.json' with { type: 'json' };
import craftingRaw from '../content/crafting.json' with { type: 'json' };
import projectsRaw from '../content/projects.json' with { type: 'json' };
import abilitiesRaw from '../content/abilities.json' with { type: 'json' };
import fishingRaw from '../content/fishing.json' with { type: 'json' };
import itemsVectors from '../content/vectors/items-loader.json' with { type: 'json' };
import homesteadVectors from '../content/vectors/homestead-loader.json' with { type: 'json' };
import gatheringVectors from '../content/vectors/gathering.json' with { type: 'json' };
import repairsVectors from '../content/vectors/repairs.json' with { type: 'json' };
import craftingVectors from '../content/vectors/crafting.json' with { type: 'json' };
import projectsVectors from '../content/vectors/projects.json' with { type: 'json' };
import abilitiesVectors from '../content/vectors/abilities.json' with { type: 'json' };
import fishingVectors from '../content/vectors/fishing.json' with { type: 'json' };

interface Edit { path: (string | number)[]; value?: unknown; remove?: boolean }
function edited(base: unknown, edits: Edit[]): unknown {
  const value = structuredClone(base);
  for (const e of edits) { let target = value as any; for (const key of e.path.slice(0, -1)) target = target[key]; if (e.remove) delete target[e.path.at(-1)!]; else target[e.path.at(-1)!] = e.value; }
  return value;
}

const families: [string, unknown, { loader: { name: string; valid: boolean; rule?: string; edits: Edit[] }[] }, (v: unknown) => unknown][] = [
  ['items', itemsRaw, itemsVectors, validateItems],
  ['homestead', homesteadRaw, homesteadVectors, validateHomesteadData],
  ['gathering', gatheringRaw, gatheringVectors, validateGathering],
  ['repairs', repairsRaw, repairsVectors, validateRepairs],
  ['crafting', craftingRaw, craftingVectors, validateCrafting],
  ['projects', projectsRaw, projectsVectors, validateProjects],
  ['abilities', abilitiesRaw, abilitiesVectors, validateAbilities],
  ['fishing', fishingRaw, fishingVectors, validateFishing],
];
for (const [family, raw, vectors, validate] of families) {
  for (const v of vectors.loader) test(`shared ${family} loader: ${v.name}`, () => {
    const value = edited(raw, v.edits);
    if (v.valid) assert.doesNotThrow(() => validate(value));
    else assert.throws(() => validate(value), (e: Error) => typeof v.rule === 'string' && v.rule.length > 0 && refusalMatchesRule(e, v.rule), v.rule);
  });
}
