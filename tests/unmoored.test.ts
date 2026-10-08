import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The drift's sway (src/game/entities/unmoored.ts) and the Turning
 * (src/game/scenes/world-turning.ts) outside Phaser: a stand-in scene with
 * an event emitter that, like Phaser's, survives the scene's restarts.
 */

// The session saves through window timers; hold them so nothing writes.
(globalThis as unknown as { window: unknown }).window = { setTimeout: () => 0, clearTimeout: () => {} };

const { bus, EV } = await import('../src/game/events.ts');
const { Session } = await import('../src/game/session.ts');
const { Unmoored } = await import('../src/game/entities/unmoored.ts');
const { Turning } = await import('../src/game/scenes/world-turning.ts');
const { createNewGame } = await import('../src/lib/state.ts');

/** A scene's event emitter: on/once/off/emit, with a count per event. */
class SceneEvents {
  private fns = new Map<string, (() => void)[]>();
  once(event: string, fn: () => void): this {
    const wrapped = () => {
      this.off(event, wrapped);
      fn();
    };
    (wrapped as { inner?: () => void }).inner = fn;
    this.fns.set(event, [...(this.fns.get(event) ?? []), wrapped]);
    return this;
  }
  off(event: string, fn: () => void): this {
    this.fns.set(event, (this.fns.get(event) ?? []).filter((f) => f !== fn && (f as { inner?: () => void }).inner !== fn));
    return this;
  }
  emit(event: string): void {
    for (const f of [...(this.fns.get(event) ?? [])]) f();
  }
  count(event: string): number {
    return this.fns.get(event)?.length ?? 0;
  }
}

const sceneWith = (events: SceneEvents) => ({ events, cameras: { main: null } }) as unknown as ConstructorParameters<typeof Unmoored>[0];
const journey = () => new Session(createNewGame());
const village = { areaId: 'village' } as ConstructorParameters<typeof Unmoored>[1]['world'];

/** One build of an area: the sway's controller, then the restart that ends it. */
function build(events: SceneEvents, session: InstanceType<typeof Session>) {
  return new Unmoored(sceneWith(events), { session, world: village, reducedMotion: true });
}

test('the clocks carry across an area restart within a journey', () => {
  const events = new SceneEvents();
  const a = journey();
  let u = build(events, a);
  u.trigger();
  u.update(0, 100); // 100 s in lamplight (the village is safe ground)
  assert.equal(u.now().active, true);
  events.emit('shutdown');
  u = build(events, a);
  assert.equal(u.now().active, true, 'still swaying in the next area');
  u.update(0, 21);
  assert.equal(u.now().active, false, 'the 120 s of lamplight counted across the restart');
  events.emit('shutdown');
});

test('a remedy keeps easing through a doorway', () => {
  const events = new SceneEvents();
  const a = journey();
  let u = build(events, a);
  u.trigger();
  bus.emit(EV.clearUnmoored, { instant: false });
  assert.deepEqual(u.now(), { active: true, easing: true });
  events.emit('shutdown');
  u = build(events, a);
  u.update(0, 1);
  assert.equal(u.now().active, true, 'the ease runs on; it does not end at the door');
  events.emit('shutdown');
});

test('another journey starts steady, its clocks at zero, and the HUD hears it', () => {
  const events = new SceneEvents();
  const a = journey();
  const u = build(events, a);
  u.trigger();
  u.update(0, 119);
  events.emit('shutdown');
  const heard: boolean[] = [];
  const on = (p: { active: boolean }) => heard.push(p.active);
  bus.on(EV.unmoored, on);
  const b = journey();
  const v = build(events, b);
  bus.off(EV.unmoored, on);
  assert.deepEqual(heard, [false], 'the HUD is told the new journey is steady');
  assert.equal(v.now().active, false);
  v.trigger();
  v.update(0, 2);
  assert.equal(v.now().active, true, 'the old journey’s 119 s of lamplight are not this one’s');
  events.emit('shutdown');
  // And the first journey's state is still its own.
  const w = build(events, a);
  assert.equal(w.now().active, true);
  events.emit('shutdown');
});

test('area after area, the controllers leave no listeners behind', () => {
  const events = new SceneEvents();
  const session = journey();
  for (let i = 0; i < 25; i++) {
    const unmoored = build(events, session);
    new Turning(sceneWith(events), {
      session,
      world: village,
      reducedMotion: true,
      hero: () => null as never,
      unmoored,
      moving: () => false,
      hold: () => {}
    });
    events.emit('shutdown');
  }
  assert.equal(events.count('shutdown'), 0);
  assert.equal(events.count('destroy'), 0, 'no destroy listener piles up across restarts');
  assert.equal(bus.listenerCount(EV.clearUnmoored), 0);
  assert.equal(bus.listenerCount(EV.turning), 0);
  assert.equal(bus.listenerCount(EV.clock), 0);
});
