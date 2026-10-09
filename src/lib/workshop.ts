import craftingRaw from '../../content/crafting.json' with { type: 'json' };
import papersRaw from '../../content/papers.json' with { type: 'json' };
import projectsRaw from '../../content/projects.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { CraftingSchema, type CraftingValid, type RecipeValid, type UtilityItemValid } from './gen/glimway/content/v1/crafting_pb.js';
import { ProjectsSchema, type ProjectValid, type ProjectsValid } from './gen/glimway/content/v1/projects_pb.js';
import { HOMESTEAD_DATA } from './homestead.ts';
import { loadWilds } from './wilds/data.ts';
import { assetKind, isStackable, itemDef } from './items.ts';

/** The workshops' recipes (proto/glimway/content/v1/crafting.proto), with the schema's required fields non-optional. */
export type Crafting = CraftingValid;
export type Recipe = RecipeValid;
export type UtilityItem = UtilityItemValid;
export type Projects = ProjectsValid;
export type Project = ProjectValid;

/** The bill: carried stacks (the keys are checked in code). */
function validRecipeCosts(materials: Record<string, number>): boolean {
  return Object.keys(materials).length > 0 && Object.entries(materials).every(([k, n]) => { const d = itemDef(k); return !!d && isStackable(d) && n >= 1 && n <= 1_000_000; });
}
/** The Wilds bill. */
function validMaterialCosts(materials: Record<string, number>): boolean {
  return Object.keys(materials).length > 0 && Object.entries(materials).every(([k, n]) => loadWilds().materials.includes(k) && n >= 1 && n <= 1_000_000);
}
/** A material's stand-ins, one for one: on the bill, carried stacks of their own, never repeats. */
function validSwaps(r: Recipe): boolean {
  for (const [k, swaps] of Object.entries(r.swaps ?? {})) {
    if (!(k in r.materials) || swaps.standIns.length === 0) return false;
    for (const s of swaps.standIns) {
      if (s === k || s in r.materials) return false;
      const d = itemDef(s);
      if (!d || !isStackable(d)) return false;
    }
  }
  return true;
}

/** Throws on anything content/workshop.go would refuse. */
export function validateCrafting(value: unknown): Crafting {
  const c = decodeContent(CraftingSchema, value, 'crafting', ['utilityItems', 'recipes', 'hearthRecipes']) as Crafting;
  const bad = (why: string): never => { throw new Error(`invalid crafting: ${why}`); };
  const items = new Set<string>(); const recipes = new Set<string>();
  for (const v of c.utilityItems) {
    if (items.has(v.id)) return bad(`duplicate id ${v.id}`);
    const d = itemDef(v.id);
    if (!d || d.kind !== 'part' || d.name !== v.name) return bad(`utility item ${v.id}`);
    items.add(v.id);
  }
  // A bench recipe: tier 2, its output any catalogue good.
  for (const r of c.recipes) {
    if (recipes.has(r.id)) return bad(`duplicate id ${r.id}`);
    if (r.minTier !== 2 || !validRecipeCosts(r.materials) || !validSwaps(r)) return bad(`recipe ${r.id}`);
    if (r.output.kind === 'decoration') {
      const def = HOMESTEAD_DATA.items.find(v => v.id === r.output.id);
      if (!def || def.minTier > r.minTier) return bad(`recipe ${r.id} output`);
    } else {
      const d = itemDef(r.output.id);
      if (!d || assetKind(d) !== r.output.kind || (r.output.kind === 'instance' && r.output.qty !== 1)) return bad(`recipe ${r.id} output`);
    }
    recipes.add(r.id);
  }
  // A hearth recipe: tier 1, its output a carried stack, and a found
  // recipe names the page that teaches it (a starting recipe names
  // neither).
  for (const r of c.hearthRecipes) {
    if (recipes.has(r.id)) return bad(`duplicate id ${r.id}`);
    if (r.minTier !== 1 || !validRecipeCosts(r.materials) || !validSwaps(r)) return bad(`hearth recipe ${r.id}`);
    if ((r.page === '') !== (r.found === '')) return bad(`hearth recipe ${r.id} page`);
    if (r.page !== '') {
      const p = itemDef(r.page);
      if (!p || p.kind !== 'paper') return bad(`hearth recipe ${r.id} page`);
    }
    if (r.output.kind !== 'item' && r.output.kind !== 'material') return bad(`hearth recipe ${r.id} output`);
    const d = itemDef(r.output.id);
    if (!d || assetKind(d) !== r.output.kind) return bad(`hearth recipe ${r.id} output`);
    recipes.add(r.id);
  }
  return c;
}
/** Throws on anything content/workshop.go would refuse. */
export function validateProjects(value: unknown): Projects {
  const p = decodeContent(ProjectsSchema, value, 'projects', ['projects']) as Projects;
  const bad = (why: string): never => { throw new Error(`invalid projects: ${why}`); };
  const ids = new Set<string>(); const papers = new Set<string>();
  for (const v of p.projects) {
    if (ids.has(v.id)) return bad(`duplicate id ${v.id}`);
    if (!validMaterialCosts(v.materials)) return bad(`${v.id} materials`);
    ids.add(v.id);
    for (const paper of v.papers) {
      const row = papersRaw.papers.find(p => p.id === paper);
      if (!row || row.source !== 'village-project') return bad(`${v.id} paper ${paper}`);
      if (papers.has(paper)) return bad(`duplicate paper ${paper}`);
      papers.add(paper);
    }
  }
  // Every authored project paper has a completion path.
  for (const paper of papersRaw.papers) if (paper.source === 'village-project' && !papers.has(paper.id)) return bad(`paper without a project ${paper.id}`);
  return p;
}
export const CRAFTING = validateCrafting(craftingRaw);
export const HEARTH_RECIPES = CRAFTING.hearthRecipes ?? [];
export const PROJECTS = validateProjects(projectsRaw);
