import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

const reportPath = 'test-results/e2e-results.json'
const outDir = '.e2e-artifacts'
const traceDir = join(outDir, 'traces')
const traceMaxCount = 3
const traceMaxBytes = 50 * 1024 * 1024

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
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    const tests = []
    const visit = (suite, parent = []) => {
      const titles = [...parent, suite.title].filter(Boolean)
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          tests.push({
            title: [...titles, spec.title].filter(Boolean).join(' › '),
            file: spec.file,
            status: test.status,
            expectedStatus: test.expectedStatus,
            attempts: (test.results ?? []).map((result) => ({ status: result.status, retry: result.retry, durationMs: result.duration }))
          })
        }
      }
      for (const child of suite.suites ?? []) visit(child, titles)
    }
    for (const suite of report.suites ?? []) visit(suite)
    return { available: true, stats: report.stats ?? null, tests }
  } catch (error) {
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
  tracePolicy: {
    maximumFiles: traceMaxCount,
    maximumBytes: traceMaxBytes,
    copiedFiles: traces,
    note: 'CI traces are recorded on the first retry. A retained trace can show the successful retry; the JSON report records every attempt, including the original failure.'
  }
}, null, 2))
