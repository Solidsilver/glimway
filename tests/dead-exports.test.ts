import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No export in src/ that nothing reads (review F9): the identifier scan the
 * step-back reviews ran by hand, kept in `npm test` so the pile doesn't grow
 * back. An export counts as read when its name appears anywhere else in
 * src/, tests/, e2e/ or scripts/ (generated code aside); a re-export
 * (`export { X }`, `export { X as Y } from …`) when its exported name appears
 * in another file. Each kept-anyway export says why below.
 *
 * It is a word scan, not a type checker, so it errs towards "read": a name
 * mentioned in a comment or a string counts as a use, and so does the same
 * name exported from somewhere else. `export default` isn't checked (an
 * importer names it as it likes; src/main.ts's is the only one).
 */
const KEPT: Record<string, string> = {
  // The client's mirror of rules.Unlocked: the craft-table vectors (server review 15) replay it.
  unlockedAbilities: 'src/lib/abilities.ts',
  // The settled Echo camp's line: written for the camp, not yet shown anywhere (see the 0.5 cleanup report).
  ECHO_SETTLED_LINE: 'src/content/echoes.ts',
  // The expansion pack's manifest, as the loader reads it (documents the JSON).
  GlimwayExpansionManifest: 'src/game/expansion.ts',
};

const root = new URL('..', import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const rel = join(dir, name);
    if (name === 'gen' || name === 'node_modules') continue;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|svelte|mjs|js)$/.test(name)) out.push(rel);
  }
  return out;
}

test('every export in src/ is read somewhere (or kept on purpose)', () => {
  // This file names the kept exports: it doesn't count as reading them.
  const files = ['src', 'tests', 'e2e', 'scripts'].flatMap((d) => walk(d)).filter((f) => f !== 'tests/dead-exports.test.ts');
  const text = new Map(files.map((f) => [f, readFileSync(join(root, f), 'utf8')]));
  const uses = new Map<string, number>();
  for (const t of text.values()) for (const w of t.match(/[A-Za-z_$][\w$]*/g) ?? []) uses.set(w, (uses.get(w) ?? 0) + 1);
  const unread: string[] = [];
  for (const [f, t] of text) {
    if (!f.startsWith('src/')) continue;
    for (const m of t.matchAll(/^export (?:declare )?(?:async )?(?:type|interface|function|const|class|enum|let) ([A-Za-z_$][\w$]*)/gm)) {
      if (uses.get(m[1]) === 1 && KEPT[m[1]] !== f) unread.push(`${f}: ${m[1]}`);
    }
    // Re-exports name things declared elsewhere, so only another file's mention reads them.
    const here = new Map<string, number>();
    for (const w of t.match(/[A-Za-z_$][\w$]*/g) ?? []) here.set(w, (here.get(w) ?? 0) + 1);
    for (const m of t.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
      for (const item of m[1].split(',')) {
        const name = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
        if (name && (uses.get(name) ?? 0) - (here.get(name) ?? 0) === 0 && KEPT[name] !== f) unread.push(`${f}: ${name} (re-export)`);
      }
    }
  }
  assert.deepEqual(unread, [], 'exports nothing reads: delete them, or say in KEPT why they stay');
  for (const [name, f] of Object.entries(KEPT)) assert.equal(uses.get(name), 1, `${name} (${f}) is read now: take it out of KEPT`);
});
