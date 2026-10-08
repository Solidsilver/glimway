import test from 'node:test'
import assert from 'node:assert/strict'
import { BLOCKS, blocked, layersUp, type Layer, type LayerFlags } from '../src/ui/layers.ts'

const LAYERS: Layer[] = ['gate', 'lease', 'move', 'confirm', 'logout', 'naming', 'leave-deed', 'panel', 'ending', 'dialogue', 'cinematic', 'placement', 'link-notice', 'banner', 'reloading']

/**
 * The five predicates as App.svelte wrote them out by hand before the layer
 * table (src/App.svelte at 7d3bb12), in its own state names.
 */
function before(f: LayerFlags) {
  const panel = f.panel, gate = f.gate, leaseBlock = f.lease, moving = f.move, confirm = f.confirm, confirmLogout = f.logout
  const namePrompt = f.naming, leaveAsk = f['leave-deed'], endingOpen = f.ending, dialogueOpen = f.dialogue, cinematic = f.cinematic
  const placement = f.placement, linkNotice = f['link-notice'], bannerUp = f.banner, reloading = f.reloading
  return {
    worldInput: panel || endingOpen || gate || leaseBlock || namePrompt || leaveAsk || moving,
    appKeys: dialogueOpen || cinematic || confirm || gate || leaseBlock || moving || reloading || endingOpen,
    notices: !(
      !moving && !linkNotice && !panel && !cinematic && !dialogueOpen && !endingOpen && !leaseBlock && !gate && !confirm && !confirmLogout && !placement && !namePrompt && !leaveAsk && !bannerUp
    ),
    actionPrompt: !(!dialogueOpen && !panel && !cinematic && !endingOpen && !placement),
    homeBar: panel || dialogueOpen || cinematic || gate || leaseBlock
  }
}

test('the layer table blocks exactly what the hand-written lists did, in every combination', () => {
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
})
