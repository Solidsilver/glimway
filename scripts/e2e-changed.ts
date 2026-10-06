/**
 * npm run test:changed — run the Playwright specs related to what this branch
 * changed, by e2e/changed-map.json.
 *
 * Changed files: everything that differs from the merge base with the base
 * branch (E2E_BASE, default `expansion`), plus uncommitted and untracked
 * files. Then:
 *   - a changed spec runs itself;
 *   - a changed file under a mapped path runs that rule's specs (and the
 *     smoke tier, for rules marked `smoke`: the scene everything runs in);
 *   - shared test infrastructure (the map's `full` list) runs the full suite;
 *   - a changed source file no rule covers adds the smoke tier (and is named,
 *     so the map can learn it);
 *   - nothing relevant changed: nothing runs.
 *
 *   npm run test:changed                 # run them
 *   npm run test:changed -- --list       # only print the plan
 *   npm run test:changed -- --workers=2  # other args go to Playwright
 *   E2E_CHANGED=src/lib/wilds/gen-v1.ts npm run test:changed -- --list
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

type Map = { full: string[]; ignore: string[]; rules: { paths: string[]; specs: string[]; smoke?: boolean }[] }

const map = JSON.parse(readFileSync('e2e/changed-map.json', 'utf8')) as Map
const base = process.env.E2E_BASE || 'expansion'
const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const passThrough = args.filter((a) => a !== '--list')

const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8' }).split('\n').filter(Boolean)

/** A glob (`*` within a path segment, `**` across segments) as a RegExp. */
function glob(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*'
      i++
      if (pattern[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}
const matches = (file: string, patterns: string[]) => patterns.some((p) => glob(p).test(file))

// E2E_CHANGED="a.ts,b.ts" plans for that list instead of git (try the map).
const given = process.env.E2E_CHANGED?.split(',').map((f) => f.trim()).filter(Boolean)
let mergeBase = 'E2E_CHANGED'
if (!given) {
  try {
    mergeBase = git('merge-base', 'HEAD', base)[0]
  } catch {
    console.error(`test:changed: no merge base with "${base}" (set E2E_BASE to another branch)`)
    process.exit(2)
  }
}
const changed = (
  given ?? [
    ...new Set([
      ...git('diff', '--name-only', mergeBase),
      ...git('diff', '--name-only', '--cached'),
      ...git('ls-files', '--others', '--exclude-standard')
    ])
  ]
).sort()

const specs = new Set<string>()
const reasons: string[] = []
const unmapped: string[] = []
let full = false
let smoke = false

for (const file of changed) {
  if (matches(file, map.ignore)) continue
  if (matches(file, map.full)) {
    full = true
    reasons.push(`${file} → full suite (shared test infrastructure)`)
    continue
  }
  if (/^e2e\/[^/]+\.spec\.ts$/.test(file)) {
    if (existsSync(file)) {
      specs.add(file.slice('e2e/'.length))
      reasons.push(`${file} → itself`)
    }
    continue
  }
  const hits = map.rules.filter((r) => matches(file, r.paths))
  for (const r of hits) for (const s of r.specs) specs.add(s)
  if (hits.some((r) => r.smoke)) smoke = true
  if (hits.length) reasons.push(`${file} → ${[...new Set(hits.flatMap((r) => r.specs))].join(', ')}${hits.some((r) => r.smoke) ? ' + smoke' : ''}`)
  else if (/^(src|server|public|assets|e2e)\//.test(file) || file === 'index.html') {
    unmapped.push(file)
    smoke = true
  }
}

console.log(given ? `test:changed: ${changed.length} file(s) from E2E_CHANGED` : `test:changed: ${changed.length} file(s) changed since ${base} (${mergeBase.slice(0, 8)})`)
for (const r of reasons) console.log(`  ${r}`)
if (unmapped.length) {
  console.log('  not in e2e/changed-map.json (adds the smoke tier):')
  for (const f of unmapped) console.log(`    ${f}`)
}

let pw: string[]
if (full) {
  console.log('→ full suite')
  pw = []
} else {
  const files = [...specs].sort().map((s) => `e2e/${s}`)
  if (!files.length && !smoke) {
    console.log('→ nothing to run')
    process.exit(0)
  }
  // Smoke tests live in many specs: with a spec list, the grep would narrow
  // those specs instead, so the smoke tier runs as its own pass.
  pw = files
  console.log(`→ ${files.length ? files.join(' ') : ''}${smoke ? `${files.length ? ' + ' : ''}the smoke tier` : ''}`)
}
if (listOnly) process.exit(0)

const run = (extra: string[]) => spawnSync('npx', ['playwright', 'test', ...extra, ...passThrough], { stdio: 'inherit' }).status ?? 1
let status = 0
if (full || pw.length) status = run(pw)
if (!full && smoke) status = run(['--grep', '@smoke']) || status
process.exit(status)
