import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
