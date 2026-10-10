import test from 'node:test';
import assert from 'node:assert/strict';
import { elaraDeskState, hoistState, spongeBowlState } from '../src/game/prop-states.ts';
import { questById, type GateContext, type QuestRecord } from '../src/lib/quests.ts';

/** 2026-10-08 10:00 UTC: a whole hour, so the cycles start here. */
const HOUR = Date.UTC(2026, 9, 8, 10) / 1000;
const LIBRARY = 'in:village:library';

function gate(over: Partial<GateContext> = {}): GateContext {
  return { now: HOUR + 10 * 60, area: 'village', glims: 0, carrying: () => 0, gateAt: undefined, online: true, ...over };
}

// ---------------------------------------------------------------- the sponge bowl

test('the sponge bowl stays flat until the sponge has been set', () => {
  assert.equal(spongeBowlState({}, gate()), null, 'not started');
  const heard = { 'set-to-rise': 'hear-hazel' } as QuestRecord;
  assert.equal(spongeBowlState(heard, gate()), null, 'the sponge not set yet');
  const set = { 'set-to-rise': 'set-sponge' } as QuestRecord;
  // Just set: the wait (2 hours from `gate_at`) still has its left part.
  assert.equal(spongeBowlState(set, gate({ gateAt: HOUR + 10 * 60, now: HOUR + 30 * 60 })), null, 'the wait still on');
  assert.equal(spongeBowlState(set, gate({ gateAt: HOUR + 10 * 60, now: HOUR + 10 * 60 + 2 * 3600 + 5 })), 'risen', 'the wait run out');
});

test('the sponge bowl goes back to flat once the quest is done (Hazel has started another)', () => {
  const q = questById('set-to-rise')!;
  const finished = { 'set-to-rise': q.steps[q.steps.length - 1]!.id } as QuestRecord;
  assert.equal(finished['set-to-rise'], 'let-it-rise');
  assert.equal(spongeBowlState(finished, gate({ gateAt: HOUR, now: HOUR + 3 * 3600 })), null);
});

// ---------------------------------------------------------------- the hoist

test('the hoist works from the moment it is greased, and is seized otherwise', () => {
  assert.equal(hoistState({} as QuestRecord), 'seized', 'not started');
  for (const at of ['hear-finn', 'get-tallow', 'look-hoist']) assert.equal(hoistState({ 'stuck-hoist': at } as QuestRecord), 'seized', at);
  assert.equal(hoistState({ 'stuck-hoist': 'grease-hoist' } as QuestRecord), 'working');
  assert.equal(hoistState({ 'stuck-hoist': 'tell-finn' } as QuestRecord), 'working', 'until Finn has been told');
});

// ---------------------------------------------------------------- Elara's desk

test('Elara’s desk is drawn with her writing while her cycle has her at it', () => {
  assert.equal(elaraDeskState({ area: LIBRARY, spot: 'desk' }, LIBRARY), 'writing');
  assert.equal(elaraDeskState({ area: 'commons', spot: 'camp' }, LIBRARY), 'empty', 'out at her camp');
  assert.equal(elaraDeskState({ area: LIBRARY, spot: 'desk' }, 'in:village:bakery'), 'empty', 'another room (no desk of hers there)');
  assert.equal(elaraDeskState(null, LIBRARY), 'empty');
});
