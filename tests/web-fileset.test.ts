import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkWebFileset } from '../scripts/check-web-fileset.ts'

test('Nix filtered web sources contain local build imports', () => {
  assert.deepEqual(checkWebFileset(process.cwd()), [])
})
test('the fileset check detects a missing generated animation or crafts manifest', () => {
  const nix = readFileSync('nix/web.nix', 'utf8')
  for (const path of ['open-map-pass/animations.json', 'crafts-pass/manifest.json']) {
    const filtered = nix.split('\n').filter((line) => !line.includes(path)).join('\n')
    assert.ok(checkWebFileset(process.cwd(), filtered).some((error) => error.includes(path)), path)
  }
})

test('the fileset check reads styles, CSS url() and import.meta.glob', () => {
  const root = mkdtempSync(join(tmpdir(), 'web-fileset-'))
  try {
    const files: Record<string, string> = {
      'src/Imports.svelte': "<script>let a = 1</script>\n<style>@import '../assets/x.css';</style>",
      'src/Url.svelte': '<style>.a { background: url(../assets/y.png) }</style>',
      'src/Inside.svelte': "<style>@import './local.css'; .b { background: url('#mask') }</style>",
      'src/local.css': ".c { background: url('./dot.png') } .d { background: url(data:image/png;base64,AA==) }",
      'src/dot.png': '',
      'src/far.css': ".e { background: url('../assets/z.png') }",
      'src/glob-out.ts': "export const m = import.meta.glob('../assets/*.json')",
      'src/glob-in.ts': "export const m = import.meta.glob(['./*.css', '!./far.css'])",
      'src/glob-root.ts': "export const m = import.meta.glob('/assets/**/*.json')",
      'src/glob-dynamic.ts': 'const p = "../assets/*.json"; export const m = import.meta.glob(p)',
      'assets/x.css': '', 'assets/y.png': '', 'assets/z.png': '', 'assets/a.json': '{}',
    }
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    const failures = checkWebFileset(root, 'fileset = lib.fileset.unions [ ../src ]')
    const failed = (file: string) => failures.filter((f) => f.startsWith(`${file}:`)).length
    assert.equal(failed('src/Imports.svelte'), 1, 'a Svelte <style> @import')
    assert.ok(failed('src/Url.svelte') >= 1, 'a Svelte <style> url()')
    assert.ok(failed('src/far.css') >= 1, 'a CSS url()')
    assert.equal(failed('src/glob-out.ts'), 1, 'a relative glob outside the fileset')
    assert.equal(failed('src/glob-root.ts'), 1, 'a root glob outside the fileset')
    assert.equal(failed('src/glob-dynamic.ts'), 1, 'a non-literal glob')
    for (const fine of ['src/Inside.svelte', 'src/local.css', 'src/glob-in.ts']) assert.equal(failed(fine), 0, `${fine}: ${failures.join('; ')}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
