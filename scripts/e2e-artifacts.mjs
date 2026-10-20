import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

// The run's report, and a second pass's (scripts/e2e-changed.ts: the smoke
// tier after a lane's specs) in its own folder.
const reportPaths = [['test-results/e2e-results.json', 'e2e-results.json'], ['test-results/smoke/e2e-results.json', 'smoke-e2e-results.json']]
const outDir = '.e2e-artifacts'
const traceDir = join(outDir, 'traces')
const traceMaxCount = Number(process.env.E2E_TRACE_FILES) || 3
const traceMaxBytes = (Number(process.env.E2E_TRACE_MB) || 50) * 1024 * 1024
const reportMaxBytes = 10 * 1024 * 1024
const diagnosticsMaxBytes = 2 * 1024 * 1024
const diagnosticStringMaxBytes = 16 * 1024
const diagnosticMaxItems = 50
const reportPolicy = { maximumBytes: reportMaxBytes, copiedPath: null, copiedPaths: [], note: '' }
// e2e/helpers.ts HELPER_RETRY: an action a helper pressed or sent again
// inside one attempt. The test passes, so Playwright never calls it flaky.
const helperRetryType = 'helper retry'

// Keep structured errors and output even when the original report is too large.
// Bound individual values and the combined diagnostic payload; say when cut.
function diagnosticCollector() {
  let remaining = diagnosticsMaxBytes
  let truncated = false
  const cut = () => { truncated = true; return '[truncated]' }
  const bounded = (value, depth = 0) => {
    if (value === undefined) return undefined
    if (remaining < 32) { truncated = true; return undefined }
    if (depth > 8) { remaining -= 13; return cut() }
    if (typeof value === 'string') {
      const bytes = Buffer.from(value)
      // JSON escaping can expand one input byte to six output bytes. Leave
      // room for the marker, quotes and a partial UTF-8 character as well.
      const limit = Math.min(diagnosticStringMaxBytes - 16, Math.floor((remaining - 16) / 6))
      const kept = bytes.subarray(0, limit).toString('utf8')
      const result = bytes.length > limit ? `${kept}${cut()}` : kept
      remaining -= Buffer.byteLength(JSON.stringify(result))
      return result
    }
    if (value && typeof value === 'object') {
      const entries = Array.isArray(value) ? value : Object.entries(value)
      if (entries.length > diagnosticMaxItems) truncated = true
      remaining -= 2
      const result = Array.isArray(value) ? [] : {}
      for (const entry of entries.slice(0, diagnosticMaxItems)) {
        const [key, item] = Array.isArray(value) ? [null, entry] : entry
        const overhead = key === null ? 1 : Buffer.byteLength(JSON.stringify(key)) + 2
        if (remaining < overhead + 32) { truncated = true; break }
        remaining -= overhead
        const kept = bounded(item, depth + 1)
        if (kept === undefined) continue
        if (Array.isArray(result)) result.push(kept)
        else Object.defineProperty(result, key, { value: kept, enumerable: true })
      }
      return result
    }
    remaining -= Buffer.byteLength(JSON.stringify(value))
    return value
  }
  return { bounded, wasTruncated: () => truncated }
}

function walk(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      return entry.isDirectory() ? walk(path) : [path]
    })
  } catch {
    return []
  }
}

/** Each pass's report that exists, copied when within the cap; the first is required. */
function readReports() {
  const reports = []
  const notes = []
  for (const [i, [path, copy]] of reportPaths.entries()) {
    let raw
    try {
      raw = readFileSync(path)
    } catch (error) {
      if (i === 0) throw error
      continue
    }
    reports.push(JSON.parse(raw.toString('utf8')))
    if (raw.length <= reportMaxBytes) {
      reportPolicy.copiedPaths.push(copy)
      writeFileSync(join(outDir, copy), raw)
      notes.push(`${copy}: the original Playwright JSON report, including every attempt and diagnostic.`)
    } else {
      notes.push(`${path} (${raw.length} bytes) exceeds the byte cap; bounded diagnostics remain in the summary.`)
    }
  }
  reportPolicy.copiedPath = reportPolicy.copiedPaths[0] ?? null
  reportPolicy.note = notes.join(' ')
  return reports
}

/**
 * A test's helper retries, from the unbounded report (every attempt's; an
 * older report without per-attempt annotations has them on the test).
 */
function helperRetriesOf(test) {
  const pick = (notes) => (notes ?? []).filter((n) => n?.type === helperRetryType).map((n) => String(n.description ?? ''))
  const perAttempt = (test.results ?? []).flatMap((result) => pick(result.annotations))
  return perAttempt.length ? perAttempt : pick(test.annotations)
}

/** Stats of several passes: counts and duration added, the first start. */
function mergeStats(all) {
  const stats = all.filter(Boolean)
  if (stats.length <= 1) return stats[0] ?? null
  const out = { ...stats[0] }
  for (const s of stats.slice(1))
    for (const [k, v] of Object.entries(s)) if (typeof v === 'number' && typeof out[k] === 'number') out[k] += v
  return out
}

function summarizeReport() {
  try {
    const reports = readReports()
    const diagnostics = diagnosticCollector()
    const errors = diagnostics.bounded(reports.flatMap((r) => r.errors ?? []))
    const tests = []
    const visit = (suite, parent = []) => {
      const titles = [...parent, suite.title].filter(Boolean)
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          tests.push({
            title: [...titles, spec.title].filter(Boolean).join(' › '),
            file: spec.file,
            projectName: test.projectName,
            status: test.status,
            expectedStatus: test.expectedStatus,
            annotations: diagnostics.bounded(test.annotations ?? []),
            helperRetries: helperRetriesOf(test),
            attempts: (test.results ?? []).map((result) => ({
              status: result.status, retry: result.retry, durationMs: result.duration,
              error: diagnostics.bounded(result.error),
              errors: diagnostics.bounded(result.errors ?? []),
              annotations: diagnostics.bounded(result.annotations ?? []),
              stdout: diagnostics.bounded(result.stdout ?? []),
              stderr: diagnostics.bounded(result.stderr ?? []),
              attachments: diagnostics.bounded(result.attachments ?? []),
            }))
          })
        }
      }
      for (const child of suite.suites ?? []) visit(child, titles)
    }
    for (const report of reports) for (const suite of report.suites ?? []) visit(suite)
    return {
      available: true, stats: mergeStats(reports.map((r) => r.stats)), passes: reports.length, errors, tests,
      diagnosticsTruncated: diagnostics.wasTruncated(),
      diagnosticPolicy: { maximumBytes: diagnosticsMaxBytes, maximumStringBytes: diagnosticStringMaxBytes, maximumItems: diagnosticMaxItems },
    }
  } catch (error) {
    reportPolicy.note = `Original report unavailable: ${String(error)}`
    return { available: false, error: String(error), stats: null, tests: [] }
  }
}

mkdirSync(traceDir, { recursive: true })
const candidates = walk('test-results')
  .filter((path) => path.endsWith('.zip') && /trace/i.test(basename(path)))
  .map((path) => ({ path, size: statSync(path).size }))
  .sort((a, b) => b.size - a.size)
const traces = []
let bytes = 0
for (const candidate of candidates) {
  if (traces.length >= traceMaxCount || bytes + candidate.size > traceMaxBytes) continue
  const target = join(traceDir, `${traces.length + 1}-${basename(candidate.path)}`)
  copyFileSync(candidate.path, target)
  traces.push({ path: relative(outDir, target), source: candidate.path, sizeBytes: candidate.size })
  bytes += candidate.size
}

/**
 * What a reader of the run needs without opening a log (review T4/T5): how
 * many tests passed only on their retry, which failed both attempts, and the
 * ten slowest tests (every attempt's time added: what the run paid for them),
 * and the helper retries (review R2): presses and sends a helper repeated
 * inside a passing test, which the flaky count can't see.
 */
function health(report) {
  // A spec file's own suite is titled with its file name: say it once.
  const name = (t) => [t.file ?? '?', ...t.title.split(' › ').filter((part, i) => !(i === 0 && part === t.file))].join(' › ')
  const flaky = report.tests.filter((t) => t.status === 'flaky').map(name)
  const hard = report.tests.filter((t) => t.status === 'unexpected').map(name)
  const slowest = report.tests
    .map((t) => ({ test: name(t), durationMs: t.attempts.reduce((sum, a) => sum + (a.durationMs ?? 0), 0), attempts: t.attempts.length }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10)
  const helperRetries = report.tests
    .filter((t) => t.helperRetries?.length)
    .map((t) => ({ test: name(t), count: t.helperRetries.length, notes: t.helperRetries }))
  const helperRetryCount = helperRetries.reduce((sum, t) => sum + t.count, 0)
  return { flaky, hard, slowest, helperRetryCount, helperRetries }
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`
const cell = (text) => text.replace(/\|/g, '\\|')

/** The health as Markdown, for the job's step summary. */
function healthMarkdown(report, h) {
  const title = process.env.E2E_SUMMARY_TITLE || 'E2E'
  if (!report.available) return `### ${title}\n\nNo Playwright report: ${report.error}\n`
  const passed = report.tests.filter((t) => t.status === 'expected').length
  const lines = [`### ${title}`, '', `**${passed} passed, ${h.flaky.length} flaky, ${h.hard.length} failed, ${h.helperRetryCount} helper ${h.helperRetryCount === 1 ? 'retry' : 'retries'}**${report.stats?.duration ? ` in ${(report.stats.duration / 60000).toFixed(1)} min` : ''}. Flaky: failed, then passed on the retry. Helper retry: a helper pressed or sent again inside a test that passed.`, '']
  for (const [label, list] of [['Failed', h.hard], ['Flaky', h.flaky]]) {
    if (!list.length) continue
    lines.push(`**${label}:**`, '', ...list.map((t) => `- ${t}`), '')
  }
  if (h.helperRetries.length) {
    lines.push('**Helper retries:**', '', ...h.helperRetries.flatMap((t) => [`- ${t.test} (${t.count})`, ...t.notes.map((n) => `  - ${n}`)]), '')
  }
  if (h.slowest.length) {
    lines.push('**Slowest tests** (all attempts):', '', '| Test | Time | Attempts |', '|---|---:|---:|')
    for (const t of h.slowest) lines.push(`| ${cell(t.test)} | ${seconds(t.durationMs)} | ${t.attempts} |`)
    lines.push('')
  }
  return lines.join('\n')
}

const report = summarizeReport()
const runHealth = health(report)
const markdown = healthMarkdown(report, runHealth)
writeFileSync(join(outDir, 'summary.md'), markdown)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n')
console.log(markdown)

writeFileSync(join(outDir, 'summary.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  report,
  health: runHealth,
  reportPolicy,
  tracePolicy: {
    maximumFiles: traceMaxCount,
    maximumBytes: traceMaxBytes,
    copiedFiles: traces,
    note: 'CI traces are recorded on the first retry (unless E2E_TRACE says otherwise). A retained trace can show the successful retry; the summary retains bounded original failure diagnostics and the original JSON report is included when within its byte cap.'
  }
}, null, 2))
