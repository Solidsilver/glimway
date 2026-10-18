import test from 'node:test'
import assert from 'node:assert/strict'
import { BLOCKS, blocked, layersUp, type Layer, type LayerFlags } from '../src/ui/layers.ts'

const LAYERS: Layer[] = ['gate', 'lease', 'move', 'confirm', 'logout', 'naming', 'leave-deed', 'panel', 'ending', 'dialogue', 'cinematic', 'placement', 'link-notice', 'banner', 'reloading']

/**
 * The five predicates as App.svelte wrote them out by hand before the layer
 * table (src/App.svelte at 7d3bb12), in its own state names, with what has
 * changed on purpose since:
 * - a confirm (nested in a panel, or the log-out one) holds everything a
 *   panel does, and App's keys too;
 * - a naming holds App's keys: the lamp naming has no text field, so J, C
 *   and I opened a panel under it that took its focus.
 */
function before(f: LayerFlags) {
  const panel = f.panel, gate = f.gate, leaseBlock = f.lease, moving = f.move, confirmLogout = f.logout, confirm = f.confirm
  const namePrompt = f.naming, leaveAsk = f['leave-deed'], endingOpen = f.ending, dialogueOpen = f.dialogue, cinematic = f.cinematic
  const placement = f.placement, linkNotice = f['link-notice'], bannerUp = f.banner, reloading = f.reloading
  return {
    worldInput: confirm || panel || endingOpen || gate || leaseBlock || namePrompt || leaveAsk || moving,
    appKeys: confirm || dialogueOpen || cinematic || gate || leaseBlock || moving || reloading || endingOpen || namePrompt,
    notices: !(
      !confirm && !moving && !linkNotice && !panel && !cinematic && !dialogueOpen && !endingOpen && !leaseBlock && !gate && !confirmLogout && !placement && !namePrompt && !leaveAsk && !bannerUp
    ),
    actionPrompt: !(!dialogueOpen && !panel && !cinematic && !endingOpen && !placement),
    homeBar: panel || dialogueOpen || cinematic || gate || leaseBlock
  }
}

test('the layer table blocks exactly what the hand-written lists did, with the changes since, in every combination', () => {
  for (let bits = 0; bits < 1 << LAYERS.length; bits++) {
    const flags = Object.fromEntries(LAYERS.map((l, i) => [l, (bits & (1 << i)) !== 0])) as LayerFlags
    const up = layersUp(flags)
    const want = before(flags)
    for (const key of Object.keys(BLOCKS) as (keyof typeof BLOCKS)[]) {
      if (blocked(up, BLOCKS[key]) !== want[key]) assert.fail(`${key} differs with ${up.join(', ') || 'nothing'} up`)
    }
  }
})

test('layers come out top first', () => {
  const none = Object.fromEntries(LAYERS.map((l) => [l, false])) as LayerFlags
  assert.deepEqual(layersUp({ ...none, banner: true, panel: true, gate: true }), ['gate', 'panel', 'banner'])
  assert.deepEqual(layersUp(none), [])
  const nested = layersUp({ ...none, panel: true, confirm: true })
  assert.deepEqual(nested, ['confirm', 'panel'])
  assert.equal(blocked(nested, BLOCKS.appKeys), true)
  assert.equal(blocked(nested, BLOCKS.worldInput), true)
  assert.equal(blocked(nested, BLOCKS.notices), true)
})

test('a naming holds App’s keys and the world’s, but not the homestead bar', () => {
  const none = Object.fromEntries(LAYERS.map((l) => [l, false])) as LayerFlags
  const naming = layersUp({ ...none, naming: true })
  assert.equal(blocked(naming, BLOCKS.appKeys), true, 'J, C and I open nothing under the naming')
  assert.equal(blocked(naming, BLOCKS.worldInput), true)
  assert.equal(blocked(naming, BLOCKS.homeBar), false)
})
