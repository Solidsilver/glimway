import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cooldownSeconds } from '../src/ui/cooldown.ts'
import { WILDS_CLAIM_ERRORS, wildsClaimError } from '../src/content/wilds-errors.ts'
import { MAP_LABELS } from '../src/content/open-map.ts'
import { isConfirmOwnedShortcut } from '../src/ui/confirm-keys.ts'
import { parse } from 'svelte/compiler'
import { BLOCKS, blocked, layersUp, type LayerFlags } from '../src/ui/layers.ts'
import './helpers/svelte-runes.ts'

test('desktop and touch cooldown badges disappear at expiry, including after another cast', () => {
  for (const file of ['Hud.svelte', 'TouchControls.svelte']) {
    const source = readFileSync(new URL(`../src/ui/${file}`, import.meta.url), 'utf8')
    const gates: string[] = []
    // Evaluate the actual template condition enclosing each badge, rather than
    // only testing the rounding helper or looking for the badge's class.
    function walk(node: any, gate?: any): void {
      if (!node || typeof node !== 'object') return
      if (node.type === 'IfBlock') gate = node.test
      if (node.type === 'RegularElement' && node.attributes.some((a: any) => a.name === 'class' && a.value?.some((v: any) => v.data === 'cooldown-time'))) {
        assert.ok(gate, `${file}: badge must have a visibility condition`)
        gates.push(source.slice(gate.start, gate.end))
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach((child) => walk(child, gate))
        else if (value && typeof value === 'object') walk(value, gate)
      }
    }
    walk(parse(source, { modern: true }).fragment)
    assert.equal(gates.length, 2, `${file}: ability and roll badges both covered`)
    for (const gate of gates) {
      const visible = new Function('st', 'ui', 'cooldownNow', `return (${gate})`)
      for (const [readyAt, now, expected] of [[0, 0, false], [1000, 0, true], [1000, 999, true], [1000, 1000, false], [1000, 1250, false], [3000, 1250, true], [3000, 3000, false]] as const) {
        assert.equal(visible({ readyAt }, { roll: { readyAt } }, now), expected, `${file}: ${gate} at ${now}, ready at ${readyAt}`)
      }
    }
  }
})

test('pending Wilds writes preserve uncertainty and malformed requests get refusal copy', () => {
  assert.ok(WILDS_CLAIM_ERRORS.pending, 'pending must not point to an absent transport entry')
  assert.match(wildsClaimError('pending'), /may have gone through/)
  assert.match(wildsClaimError('pending'), /nothing will be taken twice/)
  assert.doesNotMatch(wildsClaimError('pending'), /Nothing was taken/)
  for (const code of ['busy', 'superseded', 'offline', 'resolved']) {
    assert.ok(WILDS_CLAIM_ERRORS[code], `missing copy for ${code}`)
    assert.notEqual(wildsClaimError(code), WILDS_CLAIM_ERRORS.unknown)
  }
  for (const code of ['invalid-claim', 'lantern-id-required']) {
    assert.equal(wildsClaimError(code), WILDS_CLAIM_ERRORS['invalid-request'])
  }
})

test('mounted confirms block App shortcuts even when focus is outside, and release ownership on close', async () => {
  const dialog = readFileSync(new URL('../src/ui/ConfirmDialog.svelte', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8')
  assert.match(dialog, /use:ownConfirm/, 'ownership must be tied to the mounted dialog')
  assert.match(dialog, /else if \(isConfirmOwnedShortcut\(e\.code\)\)\s*\{\s*e\.preventDefault\(\)\s*e\.stopPropagation\(\)/, 'the dialog must still consume its local shortcuts')
  assert.match(app, /confirm: confirms\.open > 0/, 'App must include mounted confirms in its layers')
  assert.match(app, /blocked\(layers, BLOCKS\.appKeys\)/, 'App must honor the layer')
  const { confirms, ownConfirm } = await import('../src/ui/confirm.svelte.ts')
  const { effectRoot, flushEffects } = await import('./helpers/svelte-runes.ts')
  const { user_effect } = await import('svelte/internal/client')
  let appKeysBlocked = false
  const stop = await effectRoot(() => {
    user_effect(() => {
      const flags = { panel: true, confirm: confirms.open > 0 } as LayerFlags
      appKeysBlocked = blocked(layersUp(flags), BLOCKS.appKeys)
    })
  })
  try {
    assert.equal(appKeysBlocked, false, 'the menu alone allows panel shortcuts')
    const first = ownConfirm({} as HTMLElement)
    await flushEffects()
    assert.equal(appKeysBlocked, true, 'does not depend on event target or focus')
    const second = ownConfirm({} as HTMLElement)
    first.destroy()
    await flushEffects()
    assert.equal(appKeysBlocked, true, 'another mounted confirm still owns shortcuts')
    second.destroy()
    await flushEffects()
    assert.equal(appKeysBlocked, false, 'closing the final confirm restores panel shortcuts')
  } finally {
    stop()
    confirms.open = 0
  }
})

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
  for (const code of ['already-lit', 'lantern-not-found', 'beyond-border', 'beyond-sight', 'entity-not-found', 'world-access-denied', 'epoch-ended', 'invalid-request']) {
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
