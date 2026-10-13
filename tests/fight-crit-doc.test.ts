import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('the crit contract documents the distinct server-room and local roll sources', () => {
  const source = readFileSync(new URL('../src/game/entities/fight-rules.ts', import.meta.url), 'utf8')
  const declaration = source.indexOf('export function strikeCrits(')
  const comment = source.slice(source.lastIndexOf('/**', declaration), declaration)
  assert.match(comment, /[Ss]erver-room[\s\S]*seeded/)
  assert.match(comment, /local curated[\s\S]*Math\.random\(\)/)
})
