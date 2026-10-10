import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/game/session.ts';
import { createNewGame } from '../src/lib/state.ts';

// The session saves through window timers; hold them so nothing writes.
(globalThis as unknown as { window: unknown }).window = { setTimeout: () => 0, clearTimeout: () => {} };

/**
 * A session with no link (only tests make one: local play ended with 0.3)
 * takes a plain step on this device, and refuses a gated or giving one:
 * the gate and the grants are the server's.
 */
test('without a link, a plain step is taken here and a gated one is refused, nothing taken', async () => {
  const s = new Session({ ...createNewGame(), glims: 4, xpGlims: 4, area: 'in:village:library', quests: { signpost: 'light-first-lamp', 'seat-by-the-lamp': 'browse-shelf' } });
  // The lamp's oil is an glims gate: refused, and the glims stay.
  assert.equal(await s.reachStep('seat-by-the-lamp', 'oil-lamp'), 'needs-connection');
  assert.equal(s.state.quests['seat-by-the-lamp'], 'browse-shelf');
  assert.equal(s.state.glims, 4);
  assert.ok(!s.state.flags.includes('library:lamp'));
  // A plain step goes ahead on this device.
  assert.equal(await s.reachStep('signpost', 'meet-orrin'), 'not-next', 'already past it');
  const fresh = new Session(createNewGame());
  assert.equal(await fresh.reachStep('signpost', 'meet-orrin'), null);
  assert.equal(fresh.state.quests.signpost, 'meet-orrin');
});
