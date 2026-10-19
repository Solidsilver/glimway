import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const script = resolve('scripts/ci-changes.sh')

/** A throwaway repository with one commit; `change` makes the next one. */
function repo(t: test.TestContext, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-changes-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim()
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  git('init', '-q', '-b', 'main')
  for (const [path, text] of Object.entries(files)) write(path, text)
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  const before = git('rev-parse', 'HEAD')
  return {
    write,
    move(from: string, to: string) {
      mkdirSync(dirname(join(dir, to)), { recursive: true })
      renameSync(join(dir, from), join(dir, to))
    },
    /** Commits the change and classifies it as a push from the first commit. */
    classify(event = 'push', from = before) {
      git('add', '-A')
      git('commit', '-q', '-m', 'second')
      const output = execFileSync('sh', [script, event, from, git('rev-parse', 'HEAD')], { cwd: dir, encoding: 'utf8' })
      return { code: output.trim().split('\n').at(-1), output }
    },
  }
}

const source = 'export const game = 1\n'.repeat(20)

test('moving a source file into docs/ counts as code (review R1)', (t) => {
  const r = repo(t, { 'src/game.ts': source, 'docs/a.md': 'a\n' })
  r.move('src/game.ts', 'docs/game.md')
  const { code, output } = r.classify()
  assert.equal(code, 'code=true', output)
  assert.match(output, /^src\/game\.ts$/m, 'the deleted source path is listed')
})

test('renaming a source file to .md elsewhere counts as code', (t) => {
  const r = repo(t, { 'src/game.ts': source })
  r.move('src/game.ts', 'notes/game.md')
  assert.equal(r.classify().code, 'code=true')
})

test('a docs-only push skips the browser jobs', (t) => {
  const r = repo(t, { 'src/game.ts': source, 'docs/a.md': 'a\n', 'README.md': 'r\n' })
  r.write('docs/a.md', 'b\n')
  r.write('README.md', 's\n')
  r.move('docs/a.md', 'docs/moved/a.md')
  assert.equal(r.classify().code, 'code=false')
})

test('CHANGELOG.md counts as code: the build reads it', (t) => {
  const r = repo(t, { 'CHANGELOG.md': 'a\n' })
  r.write('CHANGELOG.md', 'b\n')
  assert.equal(r.classify().code, 'code=true')
})

test('a source change counts as code', (t) => {
  const r = repo(t, { 'src/game.ts': source })
  r.write('src/game.ts', source + 'x\n')
  assert.equal(r.classify().code, 'code=true')
})

test('anything in doubt counts as code', (t) => {
  for (const [event, before] of [['push', ''], ['push', '0'.repeat(40)], ['push', 'f'.repeat(40)], ['pull_request', ''], ['workflow_dispatch', '']]) {
    const r = repo(t, { 'docs/a.md': 'a\n' })
    r.write('docs/a.md', 'b\n')
    assert.equal(r.classify(event, before).code, 'code=true', `${event}:${before}`)
  }
})
