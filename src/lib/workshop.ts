import craftingRaw from '../../content/crafting.json' with { type: 'json' };
import projectsRaw from '../../content/projects.json' with { type: 'json' };
import papersRaw from '../../content/papers.json' with { type: 'json' };
import { HOMESTEAD_DATA } from './homestead.ts';
import { loadWilds } from './wilds/data.ts';
import { assetKind, isStackable, itemDef } from './items.ts';
export interface Asset { kind: 'material' | 'item' | 'decoration' | 'instance'; id: string; qty: number }
export interface Recipe { id: string; name: string; minTier: number; materials: Record<string, number>; output: Asset }
export interface Crafting { utilityItems: { id: string; name: string }[]; recipes: Recipe[]; hearthRecipes?: Recipe[] }
export interface Project { id: string; name: string; materials: Record<string, number>; papers: string[]; worldFlag: string }
export interface Projects { projects: Project[] }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]{1,100}$/.test(v);
const positive = (v: unknown, max = 1_000_000): v is number => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= max;
export function validMaterialCosts(v: unknown): v is Record<string, number> { return object(v) && Object.keys(v).length > 0 && Object.entries(v).every(([k,n]) => loadWilds().materials.includes(k) && positive(n)); }
/** A recipe's bill: any carried stack (materials, parts, wax…). */
export function validRecipeCosts(v: unknown): v is Record<string, number> { return object(v) && Object.keys(v).length > 0 && Object.entries(v).every(([k,n]) => { const d = itemDef(k); return !!d && isStackable(d) && positive(n); }); }
export function validateCrafting(value: unknown): Crafting {
  const c = value as Crafting;
  const bad = (): never => { throw new Error('invalid crafting'); };
  if (!object(c) || !Array.isArray(c.utilityItems) || !c.utilityItems.length || !Array.isArray(c.recipes) || !c.recipes.length || c.recipes.length > 60) return bad();
  const items = new Set<string>(); const recipes = new Set<string>();
  for (const v of c.utilityItems) { const d = object(v) ? itemDef(v.id) : null; if (!object(v) || !id(v.id) || typeof v.name !== 'string' || !v.name || items.has(v.id) || d?.kind !== 'part' || d.name !== v.name) return bad(); items.add(v.id); }
  for (const r of c.recipes) {
    if (!object(r) || !id(r.id) || typeof r.name !== 'string' || !r.name || recipes.has(r.id) || r.minTier !== 2 || !validRecipeCosts(r.materials) || !object(r.output) || !positive(r.output.qty, 100)) return bad();
    if (r.output.kind === 'decoration') { const def = HOMESTEAD_DATA.items.find(v => v.id === r.output.id); if (!def || def.minTier > r.minTier) return bad(); }
    else { const d = itemDef(r.output.id); if (!d || assetKind(d) !== r.output.kind || (r.output.kind === 'instance' && r.output.qty !== 1)) return bad(); }
    recipes.add(r.id);
  }
  if (c.hearthRecipes) {
    if (!Array.isArray(c.hearthRecipes)) return bad();
    for (const r of c.hearthRecipes) {
      if (!object(r) || !id(r.id) || typeof r.name !== 'string' || !r.name || recipes.has(r.id) || r.minTier !== 1 || !validRecipeCosts(r.materials) || !object(r.output) || !positive(r.output.qty, 100)) return bad();
      const d = itemDef(r.output.id);
      if (!d || assetKind(d) !== r.output.kind || (r.output.kind !== 'item' && r.output.kind !== 'material')) return bad();
      recipes.add(r.id);
    }
  }
  return c;
}
export function validateProjects(value: unknown): Projects {
  const p = value as Projects;
  const bad = (): never => { throw new Error('invalid projects'); };
  if (!object(p) || !Array.isArray(p.projects) || !p.projects.length) return bad();
  const ids = new Set<string>(); const papers = new Set<string>();
  for (const v of p.projects) {
    if (!object(v) || !id(v.id) || typeof v.name !== 'string' || !v.name || ids.has(v.id) || !validMaterialCosts(v.materials) || v.worldFlag !== `project:${v.id}:complete` || !Array.isArray(v.papers)) return bad();
    ids.add(v.id);
    for (const paper of v.papers) { if (papers.has(paper) || !papersRaw.papers.some(p => p.id === paper && p.source === 'village-project')) return bad(); papers.add(paper); }
  }
  for (const p of papersRaw.papers) if (p.source === 'village-project' && !papers.has(p.id)) return bad();
  return p;
}
export const CRAFTING = validateCrafting(craftingRaw);
export const HEARTH_RECIPES = CRAFTING.hearthRecipes ?? [];
export function hearthRecipe(id: string): Recipe | undefined {
  return HEARTH_RECIPES.find((r) => r.id === id);
}
export const PROJECTS = validateProjects(projectsRaw);
