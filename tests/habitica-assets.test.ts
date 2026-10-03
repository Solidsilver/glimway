import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG,
  companionSpriteNames,
  gearItemFor,
  gearStatsFor,
  isGifSprite,
  isNonePiece,
  isTwoHanded,
} from '../src/lib/habitica/gear.ts';
import {
  LOCAL_SPRITE_BASE,
  UPSTREAM_SPRITE_BASE,
  assetSourceFor,
  avatarLayerReport,
  avatarLayersFor,
  companionAssetFor,
  companionLayersFor,
  localSpriteUrl,
  spriteUrlFor,
  upstreamSpriteUrl,
  type AvatarProfileFull,
} from '../src/lib/habitica/avatar.ts';
import {
  loadCompanion,
  loadWorldAvatar,
} from '../src/game/avatar-render.ts';
import { effectiveStatsFor } from '../src/lib/habitica/mapping.ts';

function baseProfile(overrides: Partial<AvatarProfileFull> = {}): AvatarProfileFull {
  return {
    id: 'test-hero',
    name: 'Test Hero',
    class: 'warrior',
    level: 10,
    hp: 40,
    maxHp: 50,
    mp: 30,
    maxMp: 50,
    stats: { str: 5, int: 2, con: 3, per: 1 },
    equipped: {
      weapon: 'weapon_warrior_1',
      armor: 'armor_warrior_1',
      head: 'head_warrior_1',
      shield: 'shield_warrior_1',
      back: null,
      body: null,
      eyewear: null,
      headAccessory: null,
    },
    pets: ['Wolf-Base'],
    mounts: ['Wolf-Base'],
    appearance: {
      size: 'slim',
      shirt: 'blue',
      skin: '98461a',
      hairColor: 'black',
      hairStyle: 1,
      background: 'volcano',
    },
    selectedPet: 'Wolf-Base',
    selectedMount: 'Wolf-Base',
    ...overrides,
  };
}

const URL_SHAPE = /^(https:\/\/habitica-assets\.s3\.amazonaws\.com\/mobileApp\/images\/|\/assets\/habitica\/)/;

test('catalog provenance and completeness', () => {
  assert.equal(CATALOG.provenance.name, 'habitica-content-snapshot');
  assert.ok(CATALOG.provenance.sourceRevision.length >= 7);
  assert.equal(CATALOG.provenance.retrievedAt, '2026-10-03');
  assert.equal(Object.keys(CATALOG.gear).length, 1860);
  assert.equal(CATALOG.provenance.counts.gear, 1860);
  assert.ok(CATALOG.provenance.licenses.gearData.includes('GPL'));
  assert.ok(CATALOG.provenance.licenses.art.includes('CC BY-NC-SA'));
  assert.ok(CATALOG.provenance.auth.includes('no account credentials'));
});

test('gearStatsFor returns numeric stats for known keys', () => {
  const sword = gearStatsFor('weapon_warrior_1');
  assert.deepEqual(sword, {
    str: 3,
    int: 0,
    con: 0,
    per: 0,
    klass: 'warrior',
  });
  const rod = gearStatsFor('weapon_healer_2');
  assert.equal(rod?.int, 3);
  assert.equal(rod?.klass, 'healer');
});

test('gearStatsFor exposes specialClass for class-match gear', () => {
  const yeti = gearStatsFor('weapon_special_yeti');
  assert.equal(yeti?.str, 15);
  assert.equal(yeti?.klass, 'special');
  assert.equal(yeti?.specialClass, 'warrior');
  assert.equal(gearStatsFor('weapon_missing_9'), undefined);
  assert.equal(gearItemFor('nope')?.type, undefined);
});

test('gearStatsFor drives the class-match double contribution', () => {
  const equipped = { weapon: 'weapon_special_yeti' };
  const asWarrior = effectiveStatsFor(
    { str: 5, int: 0, con: 0, per: 0 },
    { str: 0, int: 0, con: 0, per: 0 },
    10,
    equipped,
    'warrior',
    gearStatsFor,
  );
  // base 5 + gear 15 + class bonus 15 + level 5
  assert.equal(asWarrior.str, 40);
  const asMage = effectiveStatsFor(
    { str: 5, int: 0, con: 0, per: 0 },
    { str: 0, int: 0, con: 0, per: 0 },
    10,
    equipped,
    'mage',
    gearStatsFor,
  );
  // no class-match bonus for a mage holding warrior-special gear
  assert.equal(asMage.str, 25);
});

test('none pieces and two-handed detection', () => {
  assert.equal(isNonePiece('armor_base_0'), true);
  assert.equal(isNonePiece('weapon_warrior_1'), false);
  assert.equal(isTwoHanded('weapon_wizard_1'), true);
  assert.equal(isTwoHanded('weapon_warrior_1'), false);
  assert.ok(CATALOG.spritelessGear.includes('weapon_base_0'));
  for (const key of CATALOG.spritelessGear) {
    assert.ok(key.endsWith('_base_0'), `unexpected spriteless key ${key}`);
  }
});

test('warrior layer stack follows official order', () => {
  const report = avatarLayerReport(baseProfile());
  const keys = report.layers.map((l) => l.key);
  const expected = [
    'Mount_Body_Wolf-Base',
    'skin_98461a',
    'slim_shirt_blue',
    'head_0',
    'slim_armor_warrior_1',
    'hair_base_1_black',
    'head_warrior_1',
    'shield_warrior_1',
    'weapon_warrior_1',
    'Mount_Head_Wolf-Base',
    'Pet-Wolf-Base',
  ];
  assert.deepEqual(keys, expected);
  assert.deepEqual(report.remoteOnly, []);
  assert.deepEqual(report.skipped.filter((s) => !s.includes('chair') && !s.includes('hair.')), []);
});

test('mage with two-handed staff hides the shield', () => {
  const profile = baseProfile({
    class: 'mage',
    appearance: {
      size: 'broad',
      shirt: 'yellow',
      skin: '915533',
      hairColor: 'brown',
      hairStyle: 2,
      background: '',
    },
    equipped: {
      weapon: 'weapon_wizard_1',
      armor: 'armor_wizard_1',
      head: 'head_wizard_1',
      shield: 'shield_warrior_1',
    },
  });
  const keys = avatarLayersFor(profile).map((l) => l.key);
  assert.ok(keys.includes('broad_armor_wizard_1'));
  assert.ok(keys.includes('hair_base_2_brown'));
  assert.ok(!keys.some((k) => k.startsWith('shield_')));
  const report = avatarLayerReport(profile);
  assert.ok(report.skipped.some((s) => s.includes('two-handed')));
});

test('costume drives visuals only when useCostume is set', () => {
  const costume = {
    weapon: 'weapon_wizard_1',
    armor: 'armor_wizard_1',
    head: 'head_wizard_1',
    shield: null,
  };
  const wearing = avatarLayersFor(
    baseProfile({ costume, useCostume: true }),
  ).map((l) => l.key);
  assert.ok(wearing.includes('weapon_wizard_1'));
  assert.ok(wearing.includes('slim_armor_wizard_1'));
  assert.ok(!wearing.includes('weapon_warrior_1'));

  const notWearing = avatarLayersFor(
    baseProfile({ costume, useCostume: false }),
  ).map((l) => l.key);
  assert.ok(notWearing.includes('weapon_warrior_1'));
  assert.ok(notWearing.includes('slim_armor_warrior_1'));
  assert.ok(!notWearing.includes('weapon_wizard_1'));
});

test('optional hair slots emit full hair stack in upstream order', () => {
  const keys = avatarLayersFor(
    baseProfile({
      appearance: {
        size: 'slim',
        shirt: 'blue',
        skin: '98461a',
        hairColor: 'black',
        hairStyle: 1,
        background: '',
        hairBangs: 1,
        hairMustache: 1,
        hairBeard: 1,
        hairFlower: 2,
      },
    }),
  ).map((l) => l.key);
  const hair = keys.filter((k) => k.startsWith('hair_'));
  assert.deepEqual(hair, [
    'hair_flower_2',
    'hair_bangs_1_black',
    'hair_base_1_black',
    'hair_mustache_1_black',
    'hair_beard_1_black',
    'hair_flower_2',
  ]);
});

test('missing and unknown pieces are skipped and reported', () => {
  const report = avatarLayerReport(
    baseProfile({
      equipped: { weapon: 'weapon_nothing_9', armor: 'armor_base_0', head: null },
      appearance: {
        size: 'gigantic',
        shirt: 'chartreuse',
        skin: 'sparkle',
        hairColor: 'black',
        hairStyle: 0,
        background: '',
      },
      selectedPet: 'NotAPet',
      selectedMount: 'Dragon-Nope',
    }),
  );
  const keys = report.layers.map((l) => l.key);
  assert.ok(keys.includes('head_0'));
  assert.ok(keys.includes('weapon_warrior_1') === false);
  assert.ok(!keys.some((k) => k.startsWith('Pet-')));
  assert.ok(!keys.some((k) => k.startsWith('Mount_')));
  const text = report.skipped.join('\n');
  assert.match(text, /weapon_nothing_9/);
  assert.match(text, /skin/);
  assert.match(text, /shirt/);
  assert.match(text, /NotAPet/);
  assert.match(text, /Dragon-Nope/);
});

test('companionAssetFor validates keys and returns null otherwise', () => {
  assert.deepEqual(companionAssetFor('Wolf-Base', 'pet'), {
    key: 'Pet-Wolf-Base',
    url: `${LOCAL_SPRITE_BASE}Pet-Wolf-Base.png`,
  });
  assert.equal(companionAssetFor('', 'pet'), null);
  assert.equal(companionAssetFor('NotAPet', 'pet'), null);
  assert.equal(companionAssetFor('Wolf-Nope', 'mount'), null);

  const body = companionAssetFor('Wolf-Base', 'mount');
  assert.equal(body?.key, 'Mount_Body_Wolf-Base');
  const layers = companionLayersFor('Wolf-Base', 'mount');
  assert.deepEqual(
    layers.map((l) => l.key),
    ['Mount_Body_Wolf-Base', 'Mount_Head_Wolf-Base'],
  );
  assert.deepEqual(companionSpriteNames('Wolf-Base', 'pet'), ['Pet-Wolf-Base']);
  assert.deepEqual(companionSpriteNames('zzz', 'mount'), []);
});

test('gif sprites resolve to .gif upstream, png locally', () => {
  assert.equal(isGifSprite('Pet-Wolf-Cerberus'), true);
  assert.equal(isGifSprite('Pet-Wolf-Base'), false);
  assert.match(upstreamSpriteUrl('Pet-Wolf-Cerberus'), /\.gif$/);
  assert.match(upstreamSpriteUrl('Pet-Wolf-Base'), /\.png$/);
  const cerberus = spriteUrlFor('Pet-Wolf-Cerberus');
  assert.match(cerberus ?? '', /\.gif$/);
});

test('urls are percent-encoded and carry no secrets', () => {
  assert.match(upstreamSpriteUrl('weird name/1'), /weird%20name%2F1\.png$/);
  assert.match(localSpriteUrl('hair_bangs_1_TRUred'), /hair_bangs_1_TRUred\.png$/);

  const profile = baseProfile({
    appearance: {
      size: 'slim',
      shirt: 'blue',
      skin: '98461a',
      hairColor: 'TRUred',
      hairStyle: 1,
      background: '',
    },
  });
  for (const layer of avatarLayersFor(profile)) {
    assert.match(layer.url, URL_SHAPE, `bad url shape: ${layer.url}`);
    assert.ok(!/\s/.test(layer.url), `unencoded space in ${layer.url}`);
    assert.ok(!/token|api[-_]?key|x-api|password|secret/i.test(layer.url));
    assert.ok(!layer.url.includes('?'));
    assert.ok(!layer.url.includes('#'));
    const encoded = layer.url.split('/').pop() ?? '';
    assert.equal(decodeURIComponent(encoded).includes(' '), false);
  }
});

test('local cache subset is same-origin and gif-free', () => {
  const names = Object.keys(CATALOG.localSprites);
  assert.equal(names.length, 41);
  for (const [name, ext] of Object.entries(CATALOG.localSprites)) {
    assert.equal(ext, 'png', `${name} should be png`);
    const url = localSpriteUrl(name);
    assert.ok(url.startsWith('/assets/habitica/'), url);
    assert.equal(assetSourceFor(name), 'local');
  }
  assert.ok(names.includes('Pet-Wolf-Base'));
  assert.ok(names.includes('Mount_Head_Wolf-Base'));
  assert.ok(names.includes('head_0'));
});

test('remote-only layers are flagged for the runtime', () => {
  const report = avatarLayerReport(
    baseProfile({
      appearance: {
        size: 'slim',
        shirt: 'convict',
        skin: 'bear',
        hairColor: 'aurora',
        hairStyle: 1,
        background: '',
      },
    }),
  );
  // bear skin / convict shirt / aurora hair are official but outside the cache
  assert.ok(report.remoteOnly.includes('skin_bear'));
  assert.ok(report.remoteOnly.includes('slim_shirt_convict'));
  assert.ok(report.remoteOnly.includes('hair_base_1_aurora'));
  assert.ok(report.layers.every((l) => l.url.startsWith(UPSTREAM_SPRITE_BASE) || l.url.startsWith(LOCAL_SPRITE_BASE)));
});

// ---------------------------------------------------------------------------
// avatar-render loader robustness (temporary snap_assets ownership).
// Phaser is imported type-only there, so these run under the Node runner with
// a fake scene: no DOM, no new deps.
// ---------------------------------------------------------------------------

interface FakeScene {
  scene: never;
  textures: { exists(k: string): boolean };
  load: {
    image(key: string, url: string): void;
    isReady(): boolean;
    start(): void;
    on(evt: string, fn: (...a: unknown[]) => void): void;
    off(evt: string, fn: (...a: unknown[]) => void): void;
  };
  events: {
    on(evt: string, fn: (...a: unknown[]) => void): void;
    off(evt: string, fn: (...a: unknown[]) => void): void;
  };
}

function fakeScene(opts: { failKeys?: string[] } = {}) {
  const textures = new Set<string>();
  const fail = new Set(opts.failKeys ?? []);
  const queued: string[] = [];
  let processing = false;
  let startCalls = 0;
  const lh: Record<string, Array<(...a: unknown[]) => void>> = { complete: [], loaderror: [] };
  const eh: Record<string, Array<(...a: unknown[]) => void>> = { shutdown: [], destroy: [] };
  const on = (bag: Record<string, Array<(...a: unknown[]) => void>>) => ({
    on(evt: string, fn: (...a: unknown[]) => void) { (bag[evt] ??= []).push(fn); },
    off(evt: string, fn: (...a: unknown[]) => void) {
      bag[evt] = (bag[evt] ?? []).filter((f) => f !== fn);
    },
  });
  const scene = {
    textures: { exists: (k: string) => textures.has(k) },
    load: {
      image(key: string, _url: string) { queued.push(key); },
      isReady: () => !processing,
      start() { startCalls += 1; processing = true; },
      ...on(lh),
    },
    events: on(eh),
  };
  return {
    scene: scene as unknown as FakeScene['scene'] extends never ? typeof scene : never,
    textures,
    queued,
    get startCalls() { return startCalls; },
    get listenerCount() {
      return lh.complete.length + lh.loaderror.length + eh.shutdown.length + eh.destroy.length;
    },
    finishLoad() {
      for (const key of queued.splice(0)) {
        if (fail.has(key)) for (const fn of [...lh.loaderror]) fn(key);
        else textures.add(key);
      }
      processing = false;
      for (const fn of [...lh.complete]) fn();
    },
    emitShutdown() {
      processing = false;
      for (const fn of [...eh.shutdown]) fn();
    },
  };
}

test('queueImages resolves from cache without starting the loader', async () => {
  const f = fakeScene();
  f.textures.add('fs-asset-Pet-Wolf-Base');
  const keys = await loadCompanion(f.scene as never, 'Wolf-Base', 'pet');
  assert.deepEqual(keys, ['fs-asset-Pet-Wolf-Base']);
  assert.equal(f.startCalls, 0);
  assert.equal(f.queued.length, 0);
});

test('load errors drop keys; only existing textures are returned', async () => {
  const f = fakeScene({ failKeys: ['fs-asset-Pet-Wolf-Base'] });
  const pending = loadCompanion(f.scene as never, 'Wolf-Base', 'pet');
  assert.equal(f.queued.length, 1);
  f.finishLoad();
  assert.equal(await pending, null); // nothing actually loaded -> null

  const f2 = fakeScene({ failKeys: ['fs-asset-head_warrior_1'] });
  const avatar = loadWorldAvatar(
    f2.scene as never,
    baseProfile({ equipped: { weapon: 'weapon_warrior_1', head: 'head_warrior_1', armor: null, shield: null } }),
    false,
  );
  f2.finishLoad();
  const loaded = await avatar;
  assert.equal(loaded.fallback, false);
  assert.ok(loaded.layerKeys.includes('fs-asset-weapon_warrior_1'));
  assert.ok(!loaded.layerKeys.includes('fs-asset-head_warrior_1'), 'failed key must be dropped');
  for (const k of loaded.layerKeys) assert.ok(f2.textures.has(k), `returned missing key ${k}`);
});

test('queueImages settles on scene shutdown instead of hanging', async () => {
  const f = fakeScene();
  const pending = loadWorldAvatar(f.scene as never, baseProfile(), false);
  assert.equal(f.startCalls, 1);
  f.emitShutdown(); // loader never completes
  const loaded = await pending; // must not hang (test would time out)
  assert.equal(loaded.fallback, true);
  assert.deepEqual(loaded.layerKeys, []);
  assert.equal(f.listenerCount, 0, 'listeners must detach on settle');
});

test('concurrent calls share one loader run and do not double-queue keys', async () => {
  const f = fakeScene();
  const a = loadCompanion(f.scene as never, 'Wolf-Base', 'pet');
  const b = loadCompanion(f.scene as never, 'Wolf-Base', 'pet');
  assert.equal(f.startCalls, 1, 'second call must join the in-flight run');
  assert.equal(f.queued.length, 1, 'same key must queue once across calls');
  f.finishLoad();
  assert.deepEqual(await a, ['fs-asset-Pet-Wolf-Base']);
  assert.deepEqual(await b, ['fs-asset-Pet-Wolf-Base']);
  assert.equal(f.listenerCount, 0, 'no stale listeners after settle');
});

test('duplicate layer entries keep output multiplicity but queue once', async () => {
  const f = fakeScene();
  const withFlower = baseProfile({
    appearance: {
      size: 'slim',
      shirt: 'blue',
      skin: '98461a',
      hairColor: 'black',
      hairStyle: 1,
      background: '',
      hairFlower: 2,
    },
  });
  const pending = loadWorldAvatar(f.scene as never, withFlower, false);
  const flowerQueues = () => f.queued.filter((k) => k === 'fs-asset-hair_flower_2').length;
  assert.equal(flowerQueues(), 1, 'duplicate layer entry queues the file once');
  f.finishLoad();
  const loaded = await pending;
  assert.equal(
    loaded.layerKeys.filter((k) => k === 'fs-asset-hair_flower_2').length,
    2,
    'upstream draws the flower twice; output keeps both',
  );
});

test('loadWorldAvatar falls back when zero textures actually load', async () => {
  const f = fakeScene({
    failKeys: [
      'fs-asset-skin_98461a',
      'fs-asset-slim_shirt_blue',
      'fs-asset-head_0',
      'fs-asset-hair_base_1_black',
      'fs-asset-weapon_warrior_1',
      'fs-asset-slim_armor_warrior_1',
      'fs-asset-head_warrior_1',
      'fs-asset-shield_warrior_1',
      'fs-asset-Pet-Wolf-Base',
      'fs-asset-Mount_Body_Wolf-Base',
      'fs-asset-Mount_Head_Wolf-Base',
    ],
  });
  const pending = loadWorldAvatar(f.scene as never, baseProfile(), true);
  f.finishLoad();
  const loaded = await pending;
  assert.deepEqual(loaded.layerKeys, []);
  assert.equal(loaded.fallback, true);
  assert.equal(f.listenerCount, 0);
});

test('mount layers ride along as body+head keys when cached', async () => {
  const f = fakeScene();
  const pending = loadWorldAvatar(f.scene as never, baseProfile(), true);
  f.finishLoad();
  const loaded = await pending;
  assert.ok(loaded.layerKeys.includes('fs-asset-Mount_Body_Wolf-Base'));
  assert.ok(loaded.layerKeys.includes('fs-asset-Mount_Head_Wolf-Base'));
  assert.equal(loaded.layerKeys[0], 'fs-asset-Mount_Body_Wolf-Base', 'official order kept');
});
