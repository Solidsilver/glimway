import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NOTHING, WARDROBE_SLOTS, choosesAny, cropFor, gearName, groupByClass, lookFor, matchesGear, piecesFor, readSlot, setPieces, tileProfile, withSlot, wornProfile } from '../src/lib/wardrobe.ts';
import { visualProfile } from '../src/game/avatar-render.ts';
import { avatarLayersFor } from '../src/lib/habitica/avatar.ts';
import { predictWardrobe } from '../src/lib/api/predict.ts';
import { WARDROBE_ERRORS, checkedLine, foundLine, wardrobeErrorText } from '../src/content/wardrobe.ts';
import { SERVER_ERROR_CODES } from '../src/lib/api/errors.ts';
import { PlayerStateSchema } from '../src/lib/gen/glimway/v1/state_pb.js';
import { create } from '@bufbuild/protobuf';
import type { HabiticaProfile } from '../src/lib/habitica/types.ts';

/** The wardrobe on the client (purse-and-wardrobe.md 4): the look, names, the picker and the prediction. */

type LookCase = { name: string; profile: { useCostume: boolean; equipped: Record<string, string>; costume: Record<string, string> }; chosen: Record<string, string>; look: Record<string, string | null> };
const vectors = JSON.parse(readFileSync(new URL('../content/vectors/wardrobe.json', import.meta.url), 'utf8')) as { slots: string[]; lookFor: LookCase[] };

const hero: HabiticaProfile = {
  id: 'u1',
  name: 'Tam',
  class: 'warrior',
  level: 12,
  hp: 50,
  maxHp: 50,
  mp: 30,
  maxMp: 30,
  stats: { str: 1, int: 1, con: 1, per: 1 },
  equipped: { weapon: 'weapon_warrior_1', shield: 'shield_warrior_1', armor: 'armor_warrior_1', head: 'head_warrior_1' },
  pets: [],
  mounts: [],
  appearance: { size: 'broad', shirt: 'blue', skin: '915533', hairColor: 'black', hairStyle: 1, background: '', hairBangs: 1 },
} as HabiticaProfile;

test('wardrobe: lookFor replays the shared lookFor vectors (rules.Look replays the same set)', () => {
  assert.ok(vectors.lookFor.length >= 6);
  for (const c of vectors.lookFor) {
    assert.deepEqual(lookFor(c.profile, c.chosen), c.look, c.name);
  }
});

test('wardrobe: the eight drawn slots are the vectors\' slots, weaponSpecial never among them', () => {
  assert.deepEqual([...WARDROBE_SLOTS].sort(), [...vectors.slots].sort());
  assert.ok(!(WARDROBE_SLOTS as readonly string[]).includes('weaponSpecial'));
});

test('wardrobe: nothing chosen draws Habitica\'s look exactly as before; a choice is drawn as the costume', () => {
  assert.equal(wornProfile(hero, {}), hero, 'the very same profile');
  assert.equal(wornProfile(hero, null), hero);
  assert.ok(!choosesAny({}));
  const worn = wornProfile(hero, { head: 'head_armoire_admiralsBicorne', shield: NOTHING });
  assert.equal(worn.useCostume, true);
  assert.equal(worn.costume?.head, 'head_armoire_admiralsBicorne');
  assert.equal(worn.costume?.shield, null);
  assert.equal(worn.costume?.armor, 'armor_warrior_1', 'the rest stays as on Habitica');
  assert.deepEqual(worn.equipped, hero.equipped, 'stats never change: equipped is untouched');
});

test('wardrobe: visualProfile draws the chosen look on the world avatar', () => {
  const names = (p: Parameters<typeof avatarLayersFor>[0]) => avatarLayersFor(p).map((l) => l.key);
  const before = names(visualProfile(hero, false));
  assert.ok(before.includes('head_warrior_1') && before.includes('shield_warrior_1'));
  const after = names(visualProfile(hero, false, { head: 'head_armoire_admiralsBicorne', shield: NOTHING }));
  assert.ok(after.includes('head_armoire_admiralsBicorne'));
  assert.ok(!after.includes('head_warrior_1'));
  assert.ok(!after.includes('shield_warrior_1'), 'Nothing draws nothing');
  // The avatar's own rule still holds: a two-handed weapon hides the shield.
  const two = names(visualProfile(hero, false, { weapon: 'weapon_wizard_1' }));
  assert.ok(two.includes('weapon_wizard_1') && !two.includes('shield_warrior_1'));
  assert.equal(visualProfile(hero, false, { head: 'head_armoire_admiralsBicorne' }).selectedPet, undefined, 'still no baked pet');
});

test('wardrobe: names come from the catalogue\'s text, with the key\'s words as a fallback', () => {
  assert.equal(gearName('armor_armoire_admiralsUniform'), 'Admiral\'s Uniform');
  assert.equal(gearName('head_armoire_futurePiece'), 'Future Piece');
  assert.ok(matchesGear('armor_armoire_admiralsUniform', 'admiral'));
  assert.ok(matchesGear('armor_armoire_admiralsUniform', 'armor_armoire'));
  assert.ok(!matchesGear('armor_armoire_admiralsUniform', 'wolf'));
});

test('wardrobe: a slot offers owned, catalogued pieces of its type, never a none-piece, in name order', () => {
  const owned = ['head_warrior_1', 'head_base_0', 'head_armoire_admiralsBicorne', 'armor_warrior_1', 'head_armoire_futurePiece', 'head_warrior_1'];
  assert.deepEqual(piecesFor(owned, 'head'), ['head_armoire_admiralsBicorne', 'head_warrior_1']);
  assert.deepEqual(piecesFor(owned, 'armor'), ['armor_warrior_1']);
  assert.deepEqual(piecesFor(owned, 'eyewear'), []);
});

test('wardrobe: the chips are the catalogue\'s classes, in order, with Habitica\'s names translated', () => {
  const groups = groupByClass(['head_armoire_admiralsBicorne', 'head_wizard_1', 'head_warrior_1', 'head_mystery_201402']);
  assert.deepEqual(groups.map((g) => g.label), ['Warrior', 'Mage', 'Armoire', 'Subscriber']);
  assert.deepEqual(groups[1].keys, ['head_wizard_1']);
});

test('wardrobe: Wear the whole set offers the set\'s other owned pieces, one a slot, those not already worn', () => {
  const owned = ['armor_armoire_admiralsUniform', 'head_armoire_admiralsBicorne', 'head_warrior_1'];
  assert.deepEqual(setPieces('armor_armoire_admiralsUniform', owned, {}), { head: 'head_armoire_admiralsBicorne' });
  assert.deepEqual(setPieces('armor_armoire_admiralsUniform', owned, { head: 'head_armoire_admiralsBicorne' }), {}, 'already worn');
  assert.deepEqual(setPieces('armor_armoire_admiralsUniform', ['armor_armoire_admiralsUniform'], {}), {}, 'nothing else owned');
  // What Habitica already shows counts as worn: the warrior's sword and armor aren't offered again.
  const warrior = ['weapon_warrior_1', 'armor_warrior_1', 'head_warrior_1', 'shield_warrior_1'];
  assert.deepEqual(setPieces('head_warrior_1', warrior, lookFor({ ...hero, equipped: { weapon: 'weapon_warrior_1', armor: 'armor_warrior_1' } }, { head: 'head_warrior_1' })), { shield: 'shield_warrior_1' });
});

test('wardrobe: a choice is the whole map; As on Habitica leaves the slot out', () => {
  const c = { head: 'head_warrior_1', shield: NOTHING };
  assert.deepEqual(withSlot(c, 'armor', 'armor_warrior_1'), { head: 'head_warrior_1', shield: NOTHING, armor: 'armor_warrior_1' });
  assert.deepEqual(withSlot(c, 'head', ''), { shield: NOTHING });
  assert.deepEqual(withSlot({ weaponSpecial: 'x' }, 'head', ''), {}, 'only the drawn slots are sent');
});

test('wardrobe: each slot reads As on Habitica (with what Habitica shows), a piece, or Nothing', () => {
  const c = { head: 'head_armoire_admiralsBicorne', shield: NOTHING };
  assert.deepEqual(readSlot(hero, c, 'head'), { kind: 'piece', key: 'head_armoire_admiralsBicorne' });
  assert.deepEqual(readSlot(hero, c, 'shield'), { kind: 'nothing' });
  assert.deepEqual(readSlot(hero, c, 'armor'), { kind: 'habitica', shows: 'armor_warrior_1' });
  assert.deepEqual(readSlot(hero, c, 'eyewear'), { kind: 'habitica', shows: null });
  assert.deepEqual(readSlot({ ...hero, equipped: { back: 'back_base_0' } }, {}, 'back'), { kind: 'habitica', shows: null }, 'a none-piece reads as none');
});

test('wardrobe: a tile is a plain figure (skin, shirt, bare head) in that one piece, cropped to the slot', () => {
  const keys = avatarLayersFor(tileProfile(hero, 'head', 'head_armoire_admiralsBicorne')).map((l) => l.key);
  assert.deepEqual(keys, ['skin_915533', 'broad_shirt_blue', 'head_0', 'head_armoire_admiralsBicorne']);
  assert.deepEqual(avatarLayersFor(tileProfile(hero, 'armor', null)).map((l) => l.key), ['skin_915533', 'broad_shirt_blue', 'head_0']);
  assert.deepEqual(WARDROBE_SLOTS.map(cropFor), ['head', 'head', 'head', 'torso', 'torso', 'whole', 'whole', 'whole']);
});

test('wardrobe prediction: the server\'s resolved choice, replaced whole by each unanswered choice', () => {
  const server = create(PlayerStateSchema, { wardrobe: { chosen: { head: 'head_warrior_1' } } });
  assert.deepEqual(predictWardrobe(server, []), { head: 'head_warrior_1' });
  assert.deepEqual(predictWardrobe(server, [{ kind: 'wardrobe', chosen: { armor: 'armor_warrior_1' } }, { kind: 'mark', mark: 'x' }]), { armor: 'armor_warrior_1' });
  assert.deepEqual(predictWardrobe(server, [{ kind: 'wardrobe', chosen: {} }]), {}, 'Wear Habitica\'s look');
  assert.deepEqual(predictWardrobe(null, []), {});
});

test('wardrobe copy: the check\'s lines, and every refusal is a code the server sends', () => {
  assert.equal(foundLine(0), 'Nothing new on Habitica.');
  assert.equal(foundLine(1), 'Found 1 new piece.');
  assert.equal(foundLine(2), 'Found 2 new pieces.');
  assert.equal(checkedLine(1000, 1000 + 3 * 86400 + 5), 'Gear checked with Habitica 3 days ago.');
  assert.equal(checkedLine(1000, 1010), 'Gear checked with Habitica just now.');
  const known = new Set<string>(SERVER_ERROR_CODES);
  assert.deepEqual(Object.keys(WARDROBE_ERRORS).filter((c) => !known.has(c)), []);
  assert.match(wardrobeErrorText('gear-not-owned'), /Check for new gear/);
  assert.match(wardrobeErrorText('offline'), /Needs a connection/);
});

test('the wardrobe icon is in the purse art pass (a test, not the loader)', () => {
  // WardrobeTab draws <ArtIcon art="wardrobe">; lane D's purse pack emits ui.artIcons from this manifest.
  // The "the key wardrobe is emitted" half lands once D and E merge together.
  const manifest = JSON.parse(readFileSync(new URL('../assets/generated/purse-pass/manifest.json', import.meta.url), 'utf8')) as { frames: Record<string, { file?: string }> };
  assert.ok(manifest.frames.wardrobe, 'the wardrobe frame is delivered');
  assert.ok(manifest.frames.wardrobe.file, 'with its own frame file');
});
