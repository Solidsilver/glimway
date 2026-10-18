import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync, ftruncateSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const script = resolve('scripts/e2e-artifacts.mjs')
const MiB = 1024 * 1024
function fixture(t: test.TestContext, report?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-evidence-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'test-results'))
  if (report !== undefined) writeFileSync(join(dir, 'test-results/e2e-results.json'), JSON.stringify(report))
  return {
    dir,
    collect() {
      execFileSync(process.execPath, [script], { cwd: dir })
      return JSON.parse(readFileSync(join(dir, '.e2e-artifacts/summary.json'), 'utf8'))
    },
  }
}

test('retry-assisted green evidence keeps original errors, annotations and lifecycle output', (t) => {
  const report = {
    stats: { flaky: 1 },
    errors: [{ message: 'global setup diagnostic', stack: 'global stack' }],
    suites: [{ title: 'onboarding', suites: [{ title: 'remember', specs: [{
      title: 'survives reload', file: 'e2e/onboarding.spec.ts', tests: [{
        projectName: 'chromium', status: 'flaky', expectedStatus: 'passed',
        annotations: [{ type: 'remembered record after reload', description: '{"present":false}' }],
        results: [
          { status: 'failed', retry: 0, duration: 20,
            error: { message: 'original assertion', stack: 'original stack', snippet: 'expect(remembered).toBe(true)' },
            errors: [{ message: 'focus escaped', location: { file: 'e2e/inventory.spec.ts', line: 128 } }],
            stdout: [{ text: 'first-paint measurement' }], stderr: [{ text: 'worker server unexpectedly exited, pid=42' }],
            annotations: [{ type: 'longest task (ms)', description: '401' }],
            attachments: [{ name: 'error-context', path: 'test-results/error-context.md', contentType: 'text/markdown' }],
          },
          { status: 'passed', retry: 1, duration: 10 },
        ],
      }],
    }] }] }],
  }
  const f = fixture(t, report)
  const summary = f.collect()
  const entry = summary.report.tests[0]
  assert.equal(entry.status, 'flaky')
  assert.equal(entry.projectName, 'chromium')
  assert.deepEqual(entry.annotations, report.suites[0].suites[0].specs[0].tests[0].annotations)
  assert.deepEqual(summary.report.errors, report.errors)
  const originalAttempt = report.suites[0].suites[0].specs[0].tests[0].results[0]
  for (const key of ['error', 'errors', 'stdout', 'stderr', 'annotations', 'attachments'] as const) {
    assert.deepEqual(entry.attempts[0][key], originalAttempt[key])
  }
  assert.equal(entry.attempts[1].status, 'passed')
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, '.e2e-artifacts', summary.reportPolicy.copiedPath), 'utf8')), report)
  assert.match(summary.tracePolicy.note, /successful retry/)
})

test('a lane run’s smoke pass adds its own report to the first pass’s, not over it', (t) => {
  const spec = (title: string, status: string) => ({ title, specs: [{ title, file: `e2e/${title}.spec.ts`, tests: [{ projectName: 'chromium', status, expectedStatus: 'passed', results: [{ status: status === 'expected' ? 'passed' : 'failed', retry: 0, duration: 5 }] }] }] })
  const f = fixture(t, { stats: { expected: 1, unexpected: 1, duration: 100, startTime: 'first' }, suites: [spec('lane', 'expected'), spec('wilds', 'unexpected')] })
  mkdirSync(join(f.dir, 'test-results/smoke'))
  const smoke = { stats: { expected: 5, unexpected: 0, duration: 30, startTime: 'second' }, suites: [spec('smoke', 'expected')] }
  writeFileSync(join(f.dir, 'test-results/smoke/e2e-results.json'), JSON.stringify(smoke))
  const summary = f.collect()
  assert.deepEqual(summary.report.tests.map((e: { title: string; status: string }) => `${e.title}:${e.status}`), ['lane › lane:expected', 'wilds › wilds:unexpected', 'smoke › smoke:expected'])
  assert.deepEqual(summary.report.stats, { expected: 6, unexpected: 1, duration: 130, startTime: 'first' })
  assert.equal(summary.report.passes, 2)
  assert.deepEqual(summary.reportPolicy.copiedPaths, ['e2e-results.json', 'smoke-e2e-results.json'])
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, '.e2e-artifacts/smoke-e2e-results.json'), 'utf8')), smoke)
})

test('setup failure with no tests retains report-level errors', (t) => {
  const errors = [{ message: 'web server failed to start', stack: 'setup stack' }]
  const summary = fixture(t, { suites: [], errors }).collect()
  assert.equal(summary.report.available, true)
  assert.deepEqual(summary.report.tests, [])
  assert.deepEqual(summary.report.errors, errors)
})

for (const invalid of [false, true]) {
  test(`collector produces a diagnostic when report is ${invalid ? 'invalid' : 'missing'}`, (t) => {
    const f = fixture(t)
    if (invalid) writeFileSync(join(f.dir, 'test-results/e2e-results.json'), '{invalid')
    const summary = f.collect()
    assert.equal(summary.report.available, false)
    assert.ok(summary.report.error)
    assert.deepEqual(summary.tracePolicy.copiedFiles, [])
  })
}

test('large report keeps bounded diagnostics and explicitly reports omissions', (t) => {
  const message = 'original failure ' + 'x'.repeat(11 * MiB)
  const f = fixture(t, { errors: [{ message }], suites: [{ specs: [{ tests: [{ results: Array.from({ length: 200 }, () => ({ stderr: [{ text: '\u0000'.repeat(16 * 1024) }] })) }] }] }] })
  const summary = f.collect()
  assert.match(summary.report.errors[0].message, /^original failure/)
  assert.ok(Buffer.byteLength(summary.report.errors[0].message) < 17 * 1024)
  assert.equal(summary.report.diagnosticsTruncated, true)
  assert.equal(summary.reportPolicy.copiedPath, null)
  assert.match(summary.reportPolicy.note, /exceeds/)
  assert.ok(statSync(join(f.dir, '.e2e-artifacts/summary.json')).size < 3 * MiB)
  const diagnostics = [summary.report.errors, summary.report.tests[0].annotations,
    ...summary.report.tests[0].attempts.flatMap((attempt: Record<string, unknown>) =>
      ['error', 'errors', 'stdout', 'stderr', 'annotations', 'attachments'].map((key) => attempt[key]))]
  const diagnosticBytes = diagnostics.reduce((sum: number, value: unknown) =>
    sum + (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value))), 0)
  assert.ok(diagnosticBytes <= 2 * MiB, `${diagnosticBytes} diagnostic bytes`)
})

test('trace evidence respects both count and 50 MiB caps', (t) => {
  for (const sizes of [[40, 20, 10, 5], [1, 1, 1, 1]]) {
    const f = fixture(t, { suites: [] })
    sizes.forEach((size, index) => {
      const fd = openSync(join(f.dir, 'test-results', `${index}-trace.zip`), 'w')
      ftruncateSync(fd, size * MiB)
      closeSync(fd)
    })
    writeFileSync(join(f.dir, 'test-results/unrelated.zip'), 'not a trace')
    const summary = f.collect()
    const traces = summary.tracePolicy.copiedFiles
    assert.equal(traces.length, sizes[0] === 40 ? 2 : 3)
    assert.ok(traces.reduce((sum: number, trace: { sizeBytes: number }) => sum + trace.sizeBytes, 0) <= 50 * MiB)
    for (const trace of traces) assert.equal(statSync(join(f.dir, '.e2e-artifacts', trace.path)).size, trace.sizeBytes)
  }
})
