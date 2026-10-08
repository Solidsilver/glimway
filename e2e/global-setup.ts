import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'

/**
 * Build the Go server once per run, into this run's own directory
 * (.e2e-server/run-<pid>/), and hand that directory to the workers; each
 * worker then starts its own copy (e2e/server/backend.ts). Directories of
 * earlier runs whose process has ended are cleared; a run still going in
 * this worktree keeps its own.
 */
export default function globalSetup(): void {
  mkdirSync('.e2e-server', { recursive: true })
  for (const name of readdirSync('.e2e-server')) {
    const pid = /^run-(\d+)$/.exec(name)?.[1]
    if (pid && !alive(Number(pid))) rmSync(`.e2e-server/${name}`, { recursive: true, force: true })
  }
  const dir = `.e2e-server/run-${process.pid}`
  mkdirSync(dir, { recursive: true })
  // A dev build: -dev-clock and its clock route (moveServerClock in e2e/connected.ts).
  execFileSync('go', ['build', '-tags', 'dev', '-o', `${dir}/glimway-server`, './server/cmd/glimway-server'], { stdio: 'inherit' })
  rmSync('.e2e-server/latest', { force: true })
  symlinkSync(`run-${process.pid}`, '.e2e-server/latest')
  // Workers inherit the environment the global setup leaves.
  process.env.E2E_RUN_DIR = dir
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
