import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cooldownSeconds } from '../src/ui/cooldown.ts'
import { WILDS_CLAIM_ERRORS, wildsClaimError } from '../src/content/wilds-errors.ts'
import { MAP_LABELS } from '../src/content/open-map.ts'
import { isConfirmOwnedShortcut } from '../src/ui/confirm-keys.ts'

test('cooldown readout counts down in whole seconds and clamps at zero', () => {
  assert.equal(cooldownSeconds(3400, 1000), 3)
  assert.equal(cooldownSeconds(2000, 1000), 1)
  assert.equal(cooldownSeconds(1000, 1000), 0)
  assert.equal(cooldownSeconds(500, 1000), 0)
  for (const file of ['Hud.svelte', 'TouchControls.svelte']) {
    const component = readFileSync(new URL(`../src/ui/${file}`, import.meta.url), 'utf8')
    assert.match(component, /cooldown-time/)
    assert.match(component, /prefers-reduced-motion: reduce/)
  }
})

test('claim and relight refusals have domain copy, while unknown codes retain transport wording', () => {
  for (const code of ['already-lit', 'lantern-not-found', 'beyond-frontier', 'entity-not-found', 'world-access-denied', 'epoch-ended', 'invalid-request']) {
    assert.ok(WILDS_CLAIM_ERRORS[code], `missing copy for ${code}`)
    assert.notEqual(wildsClaimError(code), WILDS_CLAIM_ERRORS.unknown)
  }
  assert.match(wildsClaimError('unknown-server-code'), /didn’t answer/)
  assert.match(wildsClaimError('already-lit'), /already lit/)
})

test('confirm dialogs own the app panel shortcuts without consuming ordinary keys', () => {
  for (const code of ['KeyJ', 'KeyC', 'KeyI', 'KeyM']) assert.equal(isConfirmOwnedShortcut(code), true)
  for (const code of ['Escape', 'Tab', 'Enter', 'Space', 'KeyE']) assert.equal(isConfirmOwnedShortcut(code), false)
})

test('desktop map action bar follows map coverage and map prose lives in its copy module', () => {
  const hud = readFileSync(new URL('../src/ui/Hud.svelte', import.meta.url), 'utf8')
  const map = readFileSync(new URL('../src/ui/WorldMap.svelte', import.meta.url), 'utf8')
  assert.match(hud, /class="actionbar"[^>]*inert=\{covered\}/)
  assert.equal(MAP_LABELS.onMap, 'You’re on the map.')
  assert.equal(MAP_LABELS.noPlaces, 'none yet.')
  assert.equal(MAP_LABELS.foundByLegend, 'Found by…')
  assert.match(map, /MAP_LABELS\.onMap/)
  assert.match(map, /MAP_LABELS\.noPlaces/)
  assert.match(map, /MAP_LABELS\.foundByLegend/)
})
