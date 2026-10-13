import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

const reportPath = 'test-results/e2e-results.json'
const outDir = '.e2e-artifacts'
const traceDir = join(outDir, 'traces')
const traceMaxCount = 3
const traceMaxBytes = 50 * 1024 * 1024
const reportMaxBytes = 10 * 1024 * 1024
const diagnosticsMaxBytes = 2 * 1024 * 1024
const diagnosticStringMaxBytes = 16 * 1024
const diagnosticMaxItems = 50
const reportPolicy = { maximumBytes: reportMaxBytes, copiedPath: null, note: '' }

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

function summarizeReport() {
  try {
    const raw = readFileSync(reportPath)
    const report = JSON.parse(raw.toString('utf8'))
    if (raw.length <= reportMaxBytes) {
      reportPolicy.copiedPath = 'e2e-results.json'
      writeFileSync(join(outDir, reportPolicy.copiedPath), raw)
      reportPolicy.note = 'Original Playwright JSON report, including every attempt and diagnostic.'
    } else {
      reportPolicy.note = `Original report (${raw.length} bytes) exceeds the byte cap; bounded diagnostics remain in the summary.`
    }
    const diagnostics = diagnosticCollector()
    const errors = diagnostics.bounded(report.errors ?? [])
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
    for (const suite of report.suites ?? []) visit(suite)
    return {
      available: true, stats: report.stats ?? null, errors, tests,
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

writeFileSync(join(outDir, 'summary.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  report: summarizeReport(),
  reportPolicy,
  tracePolicy: {
    maximumFiles: traceMaxCount,
    maximumBytes: traceMaxBytes,
    copiedFiles: traces,
    note: 'CI traces are recorded on the first retry. A retained trace can show the successful retry; the summary retains bounded original failure diagnostics and the original JSON report is included when within its byte cap.'
  }
}, null, 2))
