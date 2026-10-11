/**
 * Where the main thread's long tasks go, from a Chrome DevTools trace
 * (Performance panel → Save profile, a .json or .json.gz; or the walk's
 * PERF_TRACE=1). docs/testing.md, "Performance", says how to record one.
 *
 *   node --max-old-space-size=8000 scripts/trace-hotspots.mjs <trace> [options]
 *
 * Prints:
 *   - the long tasks on the main thread (over --long ms, default 50);
 *   - self and total time per function inside those tasks, per thread
 *     (--all: over the whole trace instead);
 *   - with --callers <fn>: who calls <fn>, as chains of the game's own
 *     frames (Phaser's and Vite's chunks skipped), by time;
 *   - with --share <fn>: <fn>'s share of the main thread in time buckets
 *     (--bucket seconds, default 5), beside the busy share. A climbing share
 *     is a leak (tweens left running, say).
 *
 * <fn> matches a frame's function name, or "name file.ts:line" by prefix.
 * The user timing spans of ?perf=1 (src/game/perf.ts, `fs:<stage>`) are
 * listed per long task when the trace has them.
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--') && !isOptionValue(a))
function isOptionValue(a) {
  const i = args.indexOf(a)
  return i > 0 && ['--long', '--callers', '--share', '--bucket', '--top'].includes(args[i - 1])
}
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
if (!file) {
  console.error('usage: node --max-old-space-size=8000 scripts/trace-hotspots.mjs <trace.json[.gz]> [--long 50] [--all] [--top 25] [--callers <fn>] [--share <fn>] [--bucket 5]')
  process.exit(2)
}
const LONG_MS = Number(opt('--long', 50))
const TOP = Number(opt('--top', 25))
const CALLERS = opt('--callers', null)
const SHARE = opt('--share', null)
const BUCKET_US = Number(opt('--bucket', 5)) * 1e6
const ALL = args.includes('--all')

// ------------------------------------------------------------ reading

const buf = fs.readFileSync(file)
const text = (file.endsWith('.gz') || (buf[0] === 0x1f && buf[1] === 0x8b) ? zlib.gunzipSync(buf) : buf).toString()
const raw = JSON.parse(text)
const events = Array.isArray(raw) ? raw : raw.traceEvents
const threadOf = (e) => `${e.pid}:${e.tid}`
const threadNames = new Map(events.filter((e) => e.name === 'thread_name').map((e) => [threadOf(e), e.args.name]))
// The page's main thread: the renderer main thread with the most long tasks (a trace can hold several renderers).
const runTasks = events.filter((e) => e.name === 'RunTask' && e.ph === 'X')
const mains = [...threadNames].filter(([, n]) => n === 'CrRendererMain').map(([t]) => t)
const mainThread = mains.sort((a, b) => busy(b) - busy(a))[0]
function busy(t) {
  return runTasks.filter((e) => threadOf(e) === t).reduce((s, e) => s + e.dur, 0)
}
if (!mainThread) {
  console.error('no renderer main thread in this trace')
  process.exit(1)
}
const t0 = events.filter((e) => e.ts > 0).reduce((m, e) => Math.min(m, e.ts), Infinity)
const longTasks = runTasks.filter((e) => threadOf(e) === mainThread && e.dur > LONG_MS * 1000).sort((a, b) => a.ts - b.ts)

// CPU profiles, one per thread that was sampled.
const profiles = new Map()
for (const e of events) {
  if (e.name === 'Profile') profiles.set(e.id, { thread: threadOf(e), start: e.args.data.startTime, nodes: new Map(), samples: [], deltas: [] })
  if (e.name === 'ProfileChunk') {
    const p = profiles.get(e.id)
    if (!p) continue
    const d = e.args.data
    for (const n of d.cpuProfile?.nodes ?? []) p.nodes.set(n.id, n)
    p.samples.push(...(d.cpuProfile?.samples ?? []))
    p.deltas.push(...(d.timeDeltas ?? []))
  }
}
for (const p of profiles.values()) {
  for (const n of p.nodes.values()) for (const c of n.children ?? []) {
    const child = p.nodes.get(c)
    if (child && child.parent === undefined) child.parent = n.id
  }
  let t = p.start
  p.times = p.deltas.map((d) => (t += d))
}

const frameKey = (cf) => (cf ? `${cf.functionName || '(anonymous)'} ${(cf.url || '').split('/').pop().split('?')[0]}:${(cf.lineNumber ?? -1) + 1}` : '(?)')
const matches = (key, fn) => key === fn || key.startsWith(`${fn} `) || key.startsWith(fn)
/** The stack of a sample, innermost first. */
function stackOf(p, id) {
  const out = []
  for (let n = p.nodes.get(id); n; n = p.nodes.get(n.parent)) out.push(frameKey(n.callFrame))
  return out
}
const insideLong = (ts) => longTasks.some((k) => ts >= k.ts && ts <= k.ts + k.dur)
const ms = (us) => (us / 1000).toFixed(1)

// ------------------------------------------------------------ long tasks

const spans = events.filter((e) => e.cat?.includes('blink.user_timing') && typeof e.name === 'string' && e.name.startsWith('fs:'))
// User timing measures come as async begin/end pairs (ph b/e) or complete events.
const measures = []
{
  const open = new Map()
  for (const e of spans) {
    if (e.ph === 'X') measures.push({ name: e.name.slice(3), ts: e.ts, dur: e.dur })
    else if (e.ph === 'b') open.set(`${e.name}:${e.id ?? e.id2?.local}`, e)
    else if (e.ph === 'e') {
      const k = `${e.name}:${e.id ?? e.id2?.local}`
      const b = open.get(k)
      if (b) measures.push({ name: e.name.slice(3), ts: b.ts, dur: e.ts - b.ts })
      open.delete(k)
    }
  }
}
console.log(`${file}\nmain thread ${threadNames.get(mainThread)} (${mainThread}); ${longTasks.length} long tasks over ${LONG_MS} ms, ${ms(longTasks.reduce((s, e) => s + e.dur, 0))} ms in all`)
for (const k of longTasks) {
  const inside = new Map()
  for (const m of measures) {
    const overlap = Math.min(k.ts + k.dur, m.ts + m.dur) - Math.max(k.ts, m.ts)
    if (overlap > 0) inside.set(m.name, (inside.get(m.name) ?? 0) + overlap)
  }
  const named = [...inside].sort((a, b) => b[1] - a[1]).map(([n, d]) => `${n} ${ms(d)}`).join(', ')
  console.log(`  ${((k.ts - t0) / 1e6).toFixed(2).padStart(8)}s ${ms(k.dur).padStart(7)} ms${named ? `  [${named}]` : ''}`)
}

// ------------------------------------------------------------ self and total per function

for (const p of profiles.values()) {
  if (!p.samples.length) continue
  const self = new Map()
  const total = new Map()
  let n = 0
  for (let i = 0; i < p.samples.length; i++) {
    const dt = (p.times[i + 1] ?? p.times[i]) - p.times[i]
    if (!ALL && !insideLong(p.times[i])) continue
    const stack = stackOf(p, p.samples[i])
    if (!stack.length || stack[0].startsWith('(idle)')) continue
    n += dt
    self.set(stack[0], (self.get(stack[0]) ?? 0) + dt)
    for (const k of new Set(stack)) total.set(k, (total.get(k) ?? 0) + dt)
  }
  if (n < 1000) continue
  console.log(`\n== ${threadNames.get(p.thread) ?? p.thread} (${p.thread}): ${ms(n)} ms busy ${ALL ? 'over the whole trace' : 'inside the main thread\'s long tasks'}`)
  const top = (m, label) => {
    console.log(`-- ${label}`)
    for (const [f, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`${ms(v).padStart(9)} ${((100 * v) / n).toFixed(1).padStart(5)}%  ${f}`)
  }
  top(self, 'self')
  top(total, 'total')
}

// ------------------------------------------------------------ callers and share (main thread)

const main = [...profiles.values()].find((p) => p.thread === mainThread && p.samples.length)
if ((CALLERS || SHARE) && !main) console.log('\n(no CPU profile for the main thread: record with JavaScript samples on)')

if (CALLERS && main) {
  const chains = new Map()
  let all = 0
  for (let i = 0; i < main.samples.length; i++) {
    const dt = (main.times[i + 1] ?? main.times[i]) - main.times[i]
    if (!ALL && !insideLong(main.times[i])) continue
    const stack = stackOf(main, main.samples[i])
    const at = stack.findIndex((s) => matches(s, CALLERS))
    if (at < 0) continue
    all += dt
    const ours = stack.slice(at + 1).filter((s) => !s.includes('phaser.js') && !s.includes('chunk-')).slice(0, 3).join(' < ')
    chains.set(ours, (chains.get(ours) ?? 0) + dt)
  }
  console.log(`\n== callers of ${CALLERS}: ${ms(all)} ms ${ALL ? 'over the whole trace' : 'inside long tasks'}`)
  for (const [c, v] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`${ms(v).padStart(9)} ${((100 * v) / all).toFixed(1).padStart(5)}%  ${c || '(nothing of ours)'}`)
}

if (SHARE && main) {
  const buckets = new Map()
  const start = main.times[0]
  for (let i = 0; i < main.samples.length; i++) {
    const dt = (main.times[i + 1] ?? main.times[i]) - main.times[i]
    const stack = stackOf(main, main.samples[i])
    const b = Math.floor((main.times[i] - start) / BUCKET_US)
    const r = buckets.get(b) ?? { busy: 0, fn: 0 }
    if (stack.length && !stack[0].startsWith('(idle)')) r.busy += dt
    if (stack.some((s) => matches(s, SHARE))) r.fn += dt
    buckets.set(b, r)
  }
  console.log(`\n== ${SHARE}: share of the main thread per ${BUCKET_US / 1e6} s\n  bucket  busy%  ${SHARE}%`)
  for (const [b, r] of [...buckets].sort((a, c) => a[0] - c[0])) console.log(`${String((b * BUCKET_US) / 1e6).padStart(7)}s ${((100 * r.busy) / BUCKET_US).toFixed(0).padStart(5)} ${((100 * r.fn) / BUCKET_US).toFixed(1).padStart(7)}`)
}
