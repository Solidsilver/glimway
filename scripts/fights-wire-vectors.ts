import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fromJson, toBinary, type JsonValue } from '@bufbuild/protobuf';
import { PresenceMessageSchema } from '../src/lib/gen/glimway/v2/presence_pb.js';

/**
 * Contract 10's wire cases (docs/proto-migration.md): each message's JSON,
 * its bytes, and whether protovalidate accepts it. Replayed by
 * tests/fights-wire.test.ts and server/internal/api/fights_contract_test.go,
 * which check the bytes and the verdict in both languages. Positions and
 * ticks are realistic: chunk (-2, 3) of 384 px chunks, a late-2026 tick.
 */

const TICK = 737762816; // floor(1791763200000 / 100) mod 2^32
const roomKey = { world: 'world-1', realm: 'wilds', layer: 0, cx: -2, cy: 3, epoch: 'still' };
const enemy = (index: number, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  enemy: index, id: `camp:-2:3:0/${index}`, kind: 'FIGHT_ENEMY_KIND_WISP', campId: 'camp:-2:3:0', maxHp: 10,
  x, y, state: 'FIGHT_ENEMY_STATE_CHASE', stateTick: TICK - 40, hp: 10, facing: 64, ...extra,
});
const swing = (extra: Record<string, unknown> = {}) => ({
  fightSwing: { kind: 'FIGHT_SWING_KIND_SLASH', x: -600.5, y: 1300.25, facing: { x: 0, y: 1 }, swingCounter: 12, seenTick: TICK, seenOffsetMs: 40, ...extra },
});
const join = (extra: Record<string, unknown> = {}) => ({
  fightJoin: { roomKey, room: 7, tick: TICK, enemies: [enemy(0, -600, 1290), enemy(1, -620, 1310)], critSeed: 2654435769, ...extra },
});
const delta = (extra: Record<string, unknown>) => ({ fightDelta: { room: 7, tick: TICK, ...extra } });
const event = (extra: Record<string, unknown>) => ({ fightEvent: { room: 7, tick: TICK, ...extra } });
const result = (extra: Record<string, unknown>) => ({ fightSwingResult: { swingCounter: 12, ...extra } });
const ability = (extra: Record<string, unknown>) => ({ ability: { ability: 'cleave', x: -600, y: 1300, ...extra } });
const patch = (index: number, dx: number) => ({ enemy: index, x: -600 + dx, y: 1290 - dx, facing: 32 + dx });

const cases: [string, unknown, boolean][] = [
  ['slash-zero', { fightSwing: { kind: 'FIGHT_SWING_KIND_SLASH', x: 0, y: 0, facing: { x: 0, y: -1 }, swingCounter: 0, seenTick: 0 } }, true],
  ['slash-predicted', swing({ predicted: [{ room: 7, enemy: 0 }, { room: 8, enemy: 0 }] }), true],
  ['slash-tool', swing({ tool: true, predicted: [{ room: 7, enemy: 1 }] }), true],
  ['bolt-max-counter', { fightSwing: { kind: 'FIGHT_SWING_KIND_BOLT', x: -400, y: 128, facing: { x: 0.6, y: 0.8 }, swingCounter: 4294967295, seenTick: 4294967295, seenOffsetMs: 99 } }, true],
  ['join', join(), true],
  ['empty-join', join({ enemies: [] }), true],
  ['delta-five-moving', delta({ changed: [0, 1, 2, 3, 4].map((i) => patch(i, i)) }), true],
  ['delta-one-moving', delta({ changed: [patch(0, 1)] }), true],
  ['delta-state', delta({ changed: [{ enemy: 1, state: 'FIGHT_ENEMY_STATE_TELEGRAPH', stateTick: TICK }] }), true],
  ['delta-hit', delta({ changed: [{ enemy: 0, hp: 5.5, x: -590 }] }), true],
  ['delta-spawn', delta({ spawned: [enemy(3, -580, 1300, { hp: 10, state: 'FIGHT_ENEMY_STATE_CHASE', stateTick: TICK })] }), true],
  ['delta-removed', delta({ removed: [0, 1, 2] }), true],
  ['delta-zero-index', delta({ changed: [{ enemy: 0, x: 0 }] }), true],
  ['event-windup_start', event({ kind: 'FIGHT_EVENT_KIND_WINDUP_START', enemy: 1, target: 'account-1' }), true],
  ['event-aim_lock', event({ tick: TICK + 3, offsetMs: 20, kind: 'FIGHT_EVENT_KIND_AIM_LOCK', enemy: 1, target: 'echo:account-1' }), true],
  ['event-death', event({ kind: 'FIGHT_EVENT_KIND_DEATH', enemy: 0 }), true],
  ['event-spawn', event({ kind: 'FIGHT_EVENT_KIND_SPAWN', enemy: 3 }), true],
  ['event-room_closed', event({ kind: 'FIGHT_EVENT_KIND_ROOM_CLOSED' }), true],
  ['result-hits', result({ crit: true, hits: [{ room: 7, enemy: 0, damage: 22 }, { room: 7, enemy: 1, refusedReason: 'FIGHT_REFUSED_REASON_OUT_OF_REACH' }, { room: 8, enemy: 2, damage: 16.5 }] }), true],
  ['result-unknown-and-dead', result({ hits: [{ room: 9, enemy: 0, refusedReason: 'FIGHT_REFUSED_REASON_UNKNOWN_ENEMY' }, { room: 7, enemy: 1, refusedReason: 'FIGHT_REFUSED_REASON_ALREADY_DEAD' }] }), true],
  ['result-no-hits', result({}), true],
  ['result-cooldown', result({ refusedReason: 'FIGHT_REFUSED_REASON_COOLDOWN' }), true],
  ['result-stale-counter', result({ swingCounter: 4294967295, refusedReason: 'FIGHT_REFUSED_REASON_STALE_COUNTER' }), true],
  ['ability-tick-zero', ability({ fight: { seenTick: 0, seenOffsetMs: 0, swingCounter: 0, facing: { x: 1, y: 0 }, predicted: [{ room: 7, enemy: 0 }] } }), true],
  ['ability-fingersnap', { ability: { ability: 'fingersnap', x: -600, y: 1300, fight: { seenTick: TICK, seenOffsetMs: 99, swingCounter: 4294967295, facing: { x: -0.6, y: 0.8 } } } }, true],
  ['ability-legacy', ability({}), true],

  ['missing-facing', { fightSwing: { kind: 'FIGHT_SWING_KIND_SLASH', x: 0, y: 0 } }, false],
  ['zero-facing', swing({ facing: { x: 0, y: 0 } }), false],
  ['unknown-swing', swing({ kind: 'FIGHT_SWING_KIND_UNSPECIFIED' }), false],
  ['swing-offset-100', swing({ seenOffsetMs: 100 }), false],
  ['tool-bolt', swing({ kind: 'FIGHT_SWING_KIND_BOLT', tool: true }), false],
  ['bolt-predicted', swing({ kind: 'FIGHT_SWING_KIND_BOLT', predicted: [{ room: 7, enemy: 0 }] }), false],
  ['predicted-duplicate', swing({ predicted: [{ room: 7, enemy: 0 }, { room: 7, enemy: 0 }] }), false],
  ['predicted-room-zero', swing({ predicted: [{ room: 0, enemy: 0 }] }), false],
  ['predicted-too-many', swing({ predicted: Array.from({ length: 17 }, (_, i) => ({ room: 7, enemy: i })) }), false],
  ['missing-room', { fightJoin: { room: 7, tick: 0, critSeed: 1 } }, false],
  ['join-room-zero', join({ room: 0 }), false],
  ['join-seed-zero', join({ critSeed: 0 }), false],
  ['join-duplicate-index', join({ enemies: [enemy(0, -600, 1290), { ...enemy(0, -620, 1310), id: 'camp:-2:3:0/1' }] }), false],
  ['join-duplicate-id', join({ enemies: [enemy(0, -600, 1290), { ...enemy(1, -620, 1310), id: 'camp:-2:3:0/0' }] }), false],
  ['hp-too-high', join({ enemies: [enemy(0, -600, 1290, { hp: 11 })] }), false],
  ['facing-256', join({ enemies: [enemy(0, -600, 1290, { facing: 256 })] }), false],
  ['empty-delta', delta({}), false],
  ['delta-room-zero', delta({ room: 0, removed: [1] }), false],
  ['patch-empty', delta({ changed: [{ enemy: 1 }] }), false],
  ['patch-state-without-tick', delta({ changed: [{ enemy: 1, state: 'FIGHT_ENEMY_STATE_LUNGE' }] }), false],
  ['patch-tick-without-state', delta({ changed: [{ enemy: 1, stateTick: TICK, x: 1 }] }), false],
  ['event-no-enemy', event({ kind: 'FIGHT_EVENT_KIND_DEATH' }), false],
  ['room-closed-with-enemy', event({ kind: 'FIGHT_EVENT_KIND_ROOM_CLOSED', enemy: 0 }), false],
  ['event-offset-100', event({ kind: 'FIGHT_EVENT_KIND_AIM_LOCK', enemy: 1, offsetMs: 100 }), false],
  ['refused-swing-with-rows', result({ refusedReason: 'FIGHT_REFUSED_REASON_COOLDOWN', hits: [{ room: 7, enemy: 0, refusedReason: 'FIGHT_REFUSED_REASON_OUT_OF_REACH' }] }), false],
  ['refused-swing-crit', result({ refusedReason: 'FIGHT_REFUSED_REASON_COOLDOWN', crit: true }), false],
  ['swing-refused-out-of-reach', result({ refusedReason: 'FIGHT_REFUSED_REASON_OUT_OF_REACH' }), false],
  ['row-cooldown', result({ hits: [{ room: 7, enemy: 0, refusedReason: 'FIGHT_REFUSED_REASON_COOLDOWN' }] }), false],
  ['refusal-with-damage', result({ hits: [{ room: 7, enemy: 0, damage: 3, refusedReason: 'FIGHT_REFUSED_REASON_ALREADY_DEAD' }] }), false],
  ['confirmed-without-damage', result({ hits: [{ room: 7, enemy: 0 }] }), false],
  ['ability-missing-facing', ability({ fight: { seenTick: TICK } }), false],
  ['ability-zero-facing', ability({ fight: { seenTick: TICK, facing: { x: 0, y: 0 } } }), false],
  ['ability-offset-100', ability({ fight: { seenTick: TICK, seenOffsetMs: 100, facing: { x: 1, y: 0 } } }), false],
  ['ability-predicted-duplicate', ability({ fight: { facing: { x: 1, y: 0 }, predicted: [{ room: 7, enemy: 0 }, { room: 7, enemy: 0 }] } }), false],
];

export function fightsWireVectors() {
  return cases.map(([name, json, valid]) => {
    const bytes = toBinary(PresenceMessageSchema, fromJson(PresenceMessageSchema, json as JsonValue));
    return { name, json, valid, binaryHex: Buffer.from(bytes).toString('hex') };
  });
}

export const serializeFightsWireVectors = () => JSON.stringify(fightsWireVectors(), null, 2) + '\n';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(new URL('../content/vectors/fights-wire.json', import.meta.url), serializeFightsWireVectors());
  for (const v of fightsWireVectors()) if (v.valid) console.log(`${v.name}: ${v.binaryHex.length / 2} bytes`);
}
