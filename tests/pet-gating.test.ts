import test from 'node:test';
import assert from 'node:assert/strict';
import { BELT_ORDER, type BeltKind } from '../src/lib/belt.ts';
import { petOnPrompt, petOnTap } from '../src/lib/pet-gating.ts';

/**
 * Pet gating (lane exp/empty-hands, the owner's playtest): the action button
 * offers the pet only with empty hands, so fighting never starts with a
 * heart; a click or a tap on the pet itself pets it whatever is in hand.
 * The rules are pure (src/lib/pet-gating.ts) so node --test can hold them to
 * it — src/game/entities/petting.ts has TS parameter properties, which
 * node's strip-only mode can't load.
 */

test('pet gating: the prompt and the action key offer the pet only with empty hands', () => {
  assert.equal(petOnPrompt('hands'), true);
  for (const kind of BELT_ORDER) {
    if (kind === 'hands') continue;
    assert.equal(petOnPrompt(kind as BeltKind), false, kind);
  }
});

test('pet gating: a click or a tap on the pet itself pets it, whatever is in hand', () => {
  for (const kind of BELT_ORDER) assert.equal(petOnTap(kind), true, kind);
});
