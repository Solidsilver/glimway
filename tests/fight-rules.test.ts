import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENEMY_TUNING,
  KNOCK,
  boltReaches,
  boltSpawn,
  cleaveStrike,
  contactThreat,
  hitOutcome,
  knockFrom,
  knockInterrupts,
  mendStrike,
  slashStrike,
  snapstrike,
  strikeCrits,
  strikeHits,
  touchOutcome,
  wardMends,
  type EnemyPhase,
  type EnemyState,
  type Strike
} from '../src/game/entities/fight-rules.ts';
import { STAND_MARGIN } from '../src/lib/combat-moves.ts';
import { COMBAT_TUNING } from '../src/lib/combat-timing.ts';
import { ENEMY_TUNING as CONTENT_ENEMIES, KNOCK as CONTENT_KNOCK } from '../src/lib/enemies.ts';
import { fightCritRoll } from '../src/lib/fight-math.ts';
import vectors from '../content/vectors/fights.json' with { type: 'json' };

/**
 * The fight's rules apart from Phaser (shared-fights.md, lane F-A). Each
 * "as before" case replays the inline code these rules replaced in
 * hero.ts and enemies.ts (kept here as the oracle, with its literal numbers)
 * over many seeded spots, so moving the rules, and their numbers into
 * content (lane F-B), changed no fight. The one change is deliberate: a
 * strike's crit is one roll shared by every enemy it reaches (contract 10).
 * The shared vectors (content/vectors/fights.json) then drive the game's own
 * path, not only fight-math.
 */

type Kind = EnemyState['type'];
const enemy = (type: Kind, x: number, y: number, state: EnemyPhase = 'chase', id = `${type}-${x}-${y}`): EnemyState => ({
  id,
  type,
  x,
  y,
  hp: ENEMY_TUNING[type].hp,
  maxHp: ENEMY_TUNING[type].hp,
  state,
  dead: false
});

/** A small seeded generator (mulberry32), so the sweeps are the same every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const unit = (x: number, y: number) => {
  const l = Math.hypot(x, y);
  return { x: x / l, y: y / l };
};
const kit = { meleeDamage: 7.25, critChance: 0.3 };

test('the tuning is the content: fight-rules keeps no copy of its own', () => {
  assert.equal(ENEMY_TUNING, CONTENT_ENEMIES);
  assert.equal(KNOCK, CONTENT_KNOCK);
});

test('a slash reaches 26 px round, 14 ahead and 7 up (12 along a vertical facing); a tool swings at half, at least 1', () => {
  const s = slashStrike({ x: 100, y: 200 }, { x: 0, y: 1 }, kit, false);
  assert.deepEqual(s, { kind: 'slash', x: 100, y: 205, reach: 26, damage: 7.25, critChance: 0.3, swing: { feet: { x: 100, y: 200 }, facing: { x: 0, y: 1 } } });
  const t = slashStrike({ x: 100, y: 200 }, { x: 1, y: 0 }, kit, true);
  assert.deepEqual(t, { kind: 'tool', x: 114, y: 193, reach: 26, damage: 7.25, critChance: 0.3, swing: { feet: { x: 100, y: 200 }, facing: { x: 1, y: 0 } } });
  const near = enemy('wisp', 114, 199);
  assert.equal(strikeHits(t, [near], false)[0].amount, 4);
  assert.equal(strikeHits(t, [near], true)[0].amount, 8);
  const weak = slashStrike({ x: 0, y: 0 }, { x: 1, y: 0 }, { meleeDamage: 1, critChance: 0 }, true);
  assert.equal(strikeHits(weak, [enemy('wisp', 14, -1)], false)[0].amount, 1);
});

test('the signatures: Cleave further out and wide, Shadowstep at the feet (wider after a real dash, crits doubled), Mend all round; Cleave and Mend never crit', () => {
  assert.deepEqual(cleaveStrike({ x: 50, y: 50 }, { x: -1, y: 0 }, 11), { kind: 'cleave', x: 28, y: 44, reach: 40, damage: 11, critChance: 0 });
  assert.deepEqual(snapstrike({ x: 50, y: 50 }, true, 11, 0.2), { kind: 'snapstrike', x: 50, y: 44, reach: 34, damage: 11, critChance: 0.4 });
  assert.equal(snapstrike({ x: 50, y: 50 }, false, 11, 0.2).reach, 22);
  assert.deepEqual(mendStrike({ x: 50, y: 50 }, 9), { kind: 'mend', x: 50, y: 42, reach: 70, damage: 9, critChance: 0 });
});

test('a signature hits what its circle reaches, measured to the middle (6 px above the feet), strictly inside', () => {
  const s: Strike = { kind: 'cleave', x: 0, y: 0, reach: 10, damage: 5, critChance: 0 };
  const inside = enemy('wisp', 0, 15.9); // middle 9.9 away
  const edge = enemy('wisp', 10, 6); // middle exactly 10 away: not hit
  const far = enemy('beetle', 30, 6);
  const hits = strikeHits(s, [far, inside, edge], false);
  assert.deepEqual(hits.map((h) => h.enemy.id), [inside.id]);
  assert.deepEqual(hits[0], { enemy: inside, amount: 5, crit: false });
});

test('crits: one roll per strike, shared by every enemy it reaches (strictly under the chance); a crit doubles; a blow that cannot crit never does', () => {
  const s: Strike = { kind: 'snapstrike', x: 0, y: 0, reach: 10, damage: 4, critChance: 0.5 };
  assert.equal(strikeCrits(s, 0.49), true);
  assert.equal(strikeCrits(s, 0.5), false);
  assert.equal(strikeCrits({ ...s, critChance: 0 }, 0), false);
  const a = enemy('wisp', 0, 6, 'chase', 'a');
  const b = enemy('wisp', 1, 6, 'chase', 'b');
  const c = enemy('wisp', 500, 6, 'chase', 'c');
  assert.deepEqual(strikeHits(s, [a, c, b], true).map((h) => [h.enemy.id, h.amount, h.crit]), [['a', 8, true], ['b', 8, true]]);
  assert.deepEqual(strikeHits(s, [a, c, b], false).map((h) => [h.enemy.id, h.amount, h.crit]), [['a', 4, false], ['b', 4, false]]);
});

test('strikes land as before: the old inline reach and crit checks agree over seeded spots', () => {
  const rnd = seeded(7);
  for (let i = 0; i < 400; i++) {
    const feet = { x: rnd() * 200, y: rnd() * 200 };
    const dir = unit(rnd() - 0.5, rnd() - 0.5);
    const tool = rnd() < 0.3;
    const enemies = Array.from({ length: 6 }, (_, k) => enemy(k % 2 ? 'wisp' : 'beetle', feet.x + (rnd() - 0.5) * 140, feet.y + (rnd() - 0.5) * 140, 'chase', `e${k}`));
    // The old code rolled once per enemy reached; a strike now rolls once
    // for all of them. Fed one roll for the whole strike, they must agree.
    const roll = rnd();
    const rolls = Array.from({ length: 6 }, () => roll);
    const travelled = rnd() < 0.5;

    // The old hero.ts, verbatim but for Phaser: [enemy id, damage, crit] per hit.
    const old: Record<string, [string, number, boolean][]> = { slash: [], cleave: [], snap: [], mend: [] };
    let r = 0;
    const sx = feet.x + dir.x * 14;
    const sy = feet.y - 7 + dir.y * 12;
    for (const e of enemies) {
      const dx = e.x - sx;
      const dy = e.y - 6 - sy;
      if (dx * dx + dy * dy < 26 * 26) {
        const crit = rolls[r++] < kit.critChance;
        const base = tool ? Math.max(1, Math.round(kit.meleeDamage * 0.5)) : kit.meleeDamage;
        old.slash.push([e.id, crit ? base * 2 : base, crit]);
      }
    }
    const cx = feet.x + dir.x * 22;
    const cy = feet.y - 6 + dir.y * 18;
    for (const e of enemies) {
      const dx = e.x - cx;
      const dy = e.y - 6 - cy;
      if (dx * dx + dy * dy < 40 * 40) old.cleave.push([e.id, 11, false]);
    }
    r = 0;
    for (const e of enemies) {
      const dx = e.x - feet.x;
      const dy = e.y - 6 - (feet.y - 6);
      const reach = travelled ? 34 : 22;
      if (dx * dx + dy * dy < reach * reach) {
        const crit = rolls[r++] < kit.critChance * 2;
        old.snap.push([e.id, crit ? 11 * 2 : 11, crit]);
      }
    }
    for (const e of enemies) {
      const dx = e.x - feet.x;
      const dy = e.y - 6 - (feet.y - 8);
      if (dx * dx + dy * dy < 70 * 70) old.mend.push([e.id, 11, false]);
    }

    // As the hero's land() does it.
    const now = (s: Strike) => strikeHits(s, enemies, strikeCrits(s, roll)).map((h): [string, number, boolean] => [h.enemy.id, h.amount, h.crit]);
    assert.deepEqual(now(slashStrike(feet, dir, kit, tool)), old.slash);
    assert.deepEqual(now(cleaveStrike(feet, dir, 11)), old.cleave);
    assert.deepEqual(now(snapstrike(feet, travelled, 11, kit.critChance)), old.snap);
    assert.deepEqual(now(mendStrike(feet, 11)), old.mend);
  }
});

test('bolts as before: the old spawn and hit checks agree over seeded spots', () => {
  const rnd = seeded(5);
  for (let i = 0; i < 400; i++) {
    const feet = { x: rnd() * 200, y: rnd() * 200 };
    const dir = unit(rnd() - 0.5, rnd() - 0.5);
    // The old hero.ts and projectiles.ts.
    assert.deepEqual(boltSpawn(feet, dir), { x: feet.x + dir.x * 10, y: feet.y - 7 });
    const bolt = { x: feet.x + (rnd() - 0.5) * 40, y: feet.y + (rnd() - 0.5) * 40 };
    const e = enemy('wisp', feet.x + (rnd() - 0.5) * 40, feet.y + (rnd() - 0.5) * 40);
    const dx = e.x - bolt.x;
    const dy = e.y - 6 - bolt.y;
    assert.equal(boltReaches(bolt, e), dx * dx + dy * dy < 14 * 14);
  }
});

test('the shared vectors drive the game’s path: a slash’s and a bolt’s reach, a hit’s damage (a tool’s share, a crit, a dazed beetle), the crit and the bolt’s spawn', () => {
  for (const v of vectors.reach) {
    const e = enemy('wisp', v.enemyX, v.enemyY);
    const hit = v.kind === 'slash'
      ? strikeHits(slashStrike({ x: v.x, y: v.y }, { x: v.facingX, y: v.facingY }, kit, false), [e], false).length === 1
      : boltReaches({ x: v.x, y: v.y }, e);
    assert.equal(hit, v.hit, JSON.stringify(v));
  }
  for (const v of vectors.damage) {
    // A wisp straight ahead of the slash, or a dazed beetle there.
    const e = v.stunnedMultiplier === 1 ? enemy('wisp', 14, -1) : enemy('beetle', 14, -1, 'stunned');
    if (v.stunnedMultiplier !== 1) assert.equal(v.stunnedMultiplier, ENEMY_TUNING.beetle.stunnedTakes);
    const s = slashStrike({ x: 0, y: 0 }, { x: 1, y: 0 }, { meleeDamage: v.base, critChance: 0.5 }, v.tool);
    const [h] = strikeHits(s, [e], v.crit);
    assert.equal(hitOutcome(e, h.amount, h.crit)?.amount, v.damage, JSON.stringify(v));
  }
  for (const v of vectors.crit) {
    const s = slashStrike({ x: 0, y: 0 }, { x: 1, y: 0 }, { meleeDamage: 5, critChance: v.chance }, false);
    assert.equal(strikeCrits(s, fightCritRoll(v.seed, v.swingCounter)), v.crit, JSON.stringify(v));
  }
  for (const v of vectors.boltSpawn) assert.deepEqual(boltSpawn({ x: v.x, y: v.y }, { x: v.facingX, y: 0 }), { x: v.spawnX, y: v.spawnY });
  assert.equal(COMBAT_TUNING.attack.enemyYOffset, 6, 'the signatures measure to the same middle');
});

test('what a hit does: the warden only clinks; a dazed beetle takes 1.5× and shows as a crit; the rest as dealt', () => {
  assert.equal(hitOutcome(enemy('guardian', 0, 0), 9, true), null);
  assert.deepEqual(hitOutcome(enemy('beetle', 0, 0, 'stunned'), 4, false), { amount: 6, crit: true });
  assert.deepEqual(hitOutcome(enemy('beetle', 0, 0, 'lunge'), 4, false), { amount: 4, crit: false });
  assert.deepEqual(hitOutcome(enemy('wisp', 0, 0, 'recover'), 4, true), { amount: 4, crit: true });
});

test('the shove: away from the blow, half as much vertically from the hero; none for a charging beetle or a lunging warden', () => {
  const facing = { x: 0, y: 1 };
  assert.deepEqual(knockFrom(enemy('wisp', 10, 0), 0, { y: 0, facing }), { x: KNOCK.small, y: 0 });
  const k = knockFrom(enemy('wisp', 0, 20), 0, { y: 0, facing })!;
  assert.ok(Math.abs(k.x) < 1e-9 && Math.abs(k.y - KNOCK.small) < 1e-9);
  // On top of the blow: straight along the hero's facing.
  assert.deepEqual(knockFrom(enemy('beetle', 5, 7), 5, { y: 7, facing: { x: -1, y: 0 } }), { x: -KNOCK.small, y: 0 });
  assert.deepEqual(knockFrom(enemy('guardian', 10, 0, 'telegraph'), 0, { y: 0, facing }), { x: KNOCK.guardian, y: 0 });
  assert.equal(knockFrom(enemy('beetle', 10, 0, 'lunge'), 0, { y: 0, facing }), null);
  assert.equal(knockFrom(enemy('guardian', 10, 0, 'lunge'), 0, { y: 0, facing }), null);
  assert.notEqual(knockFrom(enemy('wisp', 10, 0, 'lunge'), 0, { y: 0, facing }), null, 'a hopping wisp is knocked out of its hop');
});

test('shoves as before: the old Vector2 shove agrees over seeded spots', () => {
  const rnd = seeded(11);
  const kinds: Kind[] = ['wisp', 'beetle', 'guardian'];
  const phases: EnemyPhase[] = ['chase', 'telegraph', 'lunge', 'recover', 'stunned', 'sweep'];
  for (let i = 0; i < 500; i++) {
    const e = enemy(kinds[i % 3], rnd() * 60, rnd() * 60, phases[Math.floor(rnd() * phases.length)]);
    const fromX = rnd() < 0.1 ? e.x : rnd() * 60;
    const hero = { y: rnd() < 0.1 ? e.y : rnd() * 60, facing: unit(rnd() - 0.5, rnd() - 0.5) };
    // The old knockEnemy, with Phaser's Vector2 written out.
    let old: { x: number; y: number } | null = null;
    if (!((e.type === 'beetle' || e.type === 'guardian') && e.state === 'lunge')) {
      let x = e.x - fromX;
      let y = (e.y - hero.y) * 0.5;
      if (x * x + y * y < 0.01) [x, y] = [hero.facing.x, hero.facing.y];
      let len = x * x + y * y;
      if (len > 0) {
        len = 1 / Math.sqrt(len);
        x *= len;
        y *= len;
      }
      const speed = e.type === 'guardian' ? KNOCK.guardian : KNOCK.small;
      old = { x: x * speed, y: y * speed };
    }
    assert.deepEqual(knockFrom(e, fromX, hero), old);
  }
});

test('a knock interrupts only a wisp winding up or hopping', () => {
  assert.equal(knockInterrupts(enemy('wisp', 0, 0, 'telegraph')), true);
  assert.equal(knockInterrupts(enemy('wisp', 0, 0, 'lunge')), true);
  assert.equal(knockInterrupts(enemy('wisp', 0, 0, 'chase')), false);
  assert.equal(knockInterrupts(enemy('beetle', 0, 0, 'telegraph')), false);
});

const SWEEP = { reach: 30, damage: 2 };

test('touching: attacks hit hard over their own reach, a bump stings, a dazed beetle and a recovering warden are safe', () => {
  assert.deepEqual(contactThreat(enemy('wisp', 0, 0, 'lunge'), SWEEP), { reach: 14, damage: 2 });
  assert.deepEqual(contactThreat(enemy('wisp', 0, 0, 'telegraph'), SWEEP), { reach: 12, damage: 1 });
  assert.deepEqual(contactThreat(enemy('beetle', 0, 0, 'lunge'), SWEEP), { reach: 15, damage: 3 });
  assert.deepEqual(contactThreat(enemy('beetle', 0, 0, 'stunned'), SWEEP), { reach: 12, damage: 0 });
  assert.deepEqual(contactThreat(enemy('guardian', 0, 0, 'lunge'), SWEEP), { reach: 18, damage: 3 });
  assert.deepEqual(contactThreat(enemy('guardian', 0, 0, 'sweep'), SWEEP), SWEEP);
  assert.deepEqual(contactThreat(enemy('guardian', 0, 0, 'recover'), SWEEP), { reach: 12, damage: 0 });
});

test('a lunge meeting a planted hero staggers (a little further out than it would hurt); the warden never staggers', () => {
  const hop = enemy('wisp', 0, 0, 'lunge');
  const threat = contactThreat(hop, SWEEP);
  assert.equal(touchOutcome(hop, threat, threat.reach + STAND_MARGIN - 0.1, true), 'stagger');
  assert.equal(touchOutcome(hop, threat, threat.reach + STAND_MARGIN - 0.1, false), null);
  assert.equal(touchOutcome(hop, threat, threat.reach - 0.1, false), 'hurt');
  const warden = enemy('guardian', 0, 0, 'lunge');
  assert.equal(touchOutcome(warden, contactThreat(warden, SWEEP), 10, true), 'hurt');
  const dazed = enemy('beetle', 0, 0, 'stunned');
  assert.equal(touchOutcome(dazed, contactThreat(dazed, SWEEP), 0, false), null);
});

test('touching as before: the old contact chain in EnemySystem.update agrees over every kind, phase and distance', () => {
  const kinds: Kind[] = ['wisp', 'beetle', 'guardian'];
  const phases: EnemyPhase[] = ['chase', 'telegraph', 'lunge', 'sweep', 'recover', 'stunned'];
  for (const type of kinds) {
    for (const state of phases) {
      for (const planted of [false, true]) {
        for (let dist = 0; dist < 40; dist += 0.5) {
          // The old chain, verbatim.
          let reach: number = ENEMY_TUNING[type].reach;
          let dmg: number = ENEMY_TUNING[type].contact;
          if (type === 'guardian' && state === 'lunge') [reach, dmg] = [ENEMY_TUNING.guardian.lungeReach, ENEMY_TUNING.guardian.lunge];
          else if (type === 'guardian' && state === 'sweep') [reach, dmg] = [SWEEP.reach, SWEEP.damage];
          else if (type === 'guardian' && state === 'recover') dmg = 0;
          else if (type === 'wisp' && state === 'lunge') [reach, dmg] = [ENEMY_TUNING.wisp.hopReach, ENEMY_TUNING.wisp.hop];
          else if (type === 'beetle' && state === 'lunge') [reach, dmg] = [ENEMY_TUNING.beetle.chargeReach, ENEMY_TUNING.beetle.charge];
          else if (type === 'beetle' && state === 'stunned') dmg = 0;
          let old: [string, number] | null = null;
          if (dmg > 0 && planted && type !== 'guardian' && state === 'lunge' && dist < reach + STAND_MARGIN) old = ['stagger', 0];
          else if (dmg > 0 && dist < reach) old = ['hurt', dmg];

          const e = enemy(type, 0, 0, state);
          const threat = contactThreat(e, SWEEP);
          const now = touchOutcome(e, threat, dist, planted);
          assert.deepEqual(now === null ? null : [now, now === 'hurt' ? threat.damage : 0], old, `${type} ${state} at ${dist}${planted ? ', planted' : ''}`);
        }
      }
    }
  }
});

test('a Ward-light pulse mends a hero inside its circle (the edge counts), not one resting at 0 HP, and not with no heal', () => {
  const pulse = { x: 100, y: 100, r: 20, heal: 3 };
  assert.equal(wardMends({ x: 110, y: 110 }, 5, pulse), true);
  assert.equal(wardMends({ x: 120, y: 100 }, 5, pulse), true);
  assert.equal(wardMends({ x: 121, y: 100 }, 5, pulse), false);
  assert.equal(wardMends({ x: 100, y: 100 }, 0, pulse), false);
  assert.equal(wardMends({ x: 100, y: 100 }, 5, { ...pulse, heal: 0 }), false);
});
