/** Authoring blockout from docs/design/one-town.md §1; never run by the game.
 * Revisions are cache identities: bump both manifest and layout after shipping.
 * T4 replaces the plots placeholder with world-seeded land and home overlays.
 */
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import type { LayoutObject } from '../src/lib/gen/glimway/content/v1/layout_pb.ts';

type ObjectData = Omit<Partial<LayoutObject>, '$typeName'>;
const rules = (rest: string, ride = true) => ({ safe: true, ride, sync: true, rest });
const tile = (tx: number, ty: number) => ({ tx, ty });
const origin = tile(-24, 24);
const anchors: { id: string; tx: number; ty: number }[] = [];
for (const [id, x, y] of [
  ['spawn', 4, 60], ['well', 11, 62], ['arch', 2, 26], ['east-road', 42, 62],
  ['south-gate', 9, 92], ['west-gate', -22, 69], ['bakery-door', -11, 59],
  ['library-door', -11, 77], ['yard-door', 34, 35], ['mill-door', 29, 77],
] as const) anchors.push({ id, tx: x - origin.tx, ty: y - origin.ty });
for (let g = 0; g < 8; g++) anchors.push({ id: `lot:${g}`, tx: -60 + (g % 2) * 24 - origin.tx, ty: 44 + Math.floor(g / 2) * 24 - origin.ty });
const places = {
  fixed: [
    { id: 'hearthwick', name: 'Hearthwick', kind: 'layout', layout: 'hearthwick', revision: 1, origin, cx: -1, cy: 1, width: 3, height: 3, rules: rules('village'),
      zones: [{ id: 'town-walk', place: 'hearthwick', tx: 0, ty: 20, w: 69, h: 49, rules: rules('village', false) }], anchors },
    { id: 'homestead-lots', name: 'Homestead Lane', kind: 'plots', layout: 'homestead-lots', revision: 2, origin: tile(-72, 24), cx: -3, cy: 1, width: 2, height: 4, rules: rules('home'),
      zones: Array.from({ length: 8 }, (_, g) => ({ id: `lot-${g}`, place: `lot:${g}`, tx: (g % 2) * 24, ty: Math.floor(g / 2) * 24, w: 24, h: 24, rules: rules('home') })), anchors: [] },
  ], generated: { safe: false, ride: true, sync: false, rest: 'none' },
  spaces: { woodland: { safe: false, ride: true, sync: false, rest: 'none' }, ruin: { safe: false, ride: true, sync: false, rest: 'none' } },
};
const palette = { '.': 'grass_a', ',': 'grass_b', '*': 'flowers', '=': 'cobble', '+': 'cobble_moss', ':': 'path_a', '~': 'water_b', 's': 'sand', 'r': 'roof', 'h': 'wall_house', 'd': 'door', 'w': 'window', 'f': 'fence' };
const ground = Array.from({ length: 72 }, () => Array<string>(72).fill('.'));
const solid = Array.from({ length: 72 }, () => Array<string>(72).fill('.'));
const objects: ObjectData[] = [];
function rect(x0: number, y0: number, x1: number, y1: number, char: string, blocks = false): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    ground[y - 24]![x + 24] = char; solid[y - 24]![x + 24] = blocks ? '#' : '.';
  }
}
function object(id: string, kind: string, x: number, y: number, extra: ObjectData = {}): void {
  objects.push({ id, kind, tx: x + 24, ty: y - 24, ...(['scenery', 'well', 'board'].includes(kind) ? { art: { ox: 8, oy: 16 } as LayoutObject['art'] } : {}), ...extra });
}
function prop(id: string, variant: string, x: number, y: number, h = 24, light = ''): void {
  object(id, light ? 'lamp' : 'prop', x, y, { variant, prop: { h, bodyW: 10, bodyH: 6, light } as LayoutObject['prop'] });
  solid[y - 24]![x + 24] = '#';
}
function piece(id: string, variant: string, x: number, y: number): void {
  object(id, 'scenery', x, y, { variant });
  solid[y - 24]![x + 24] = '#';
}
function fence(x0: number, y0: number, x1: number, y1: number): void {
  rect(x0, y0, x1, y1, '.', true);
  object(`fence:${x0},${y0}`, 'scenery', x0, y1, { variant: x0 === x1 ? `fence-v-${y1 - y0 + 1}` : `fence-h-${x1 - x0 + 1}`, art: { ox: 0, oy: 16, originLeft: true } as LayoutObject['art'] });
}
function house(id: string, variant: string, x: number, y: number, w: number, doorX: number, windowX?: number): void {
  rect(x, y, x + w - 1, y + 1, 'r', true);
  rect(x, y + 2, x + w - 1, y + 3, 'h', true);
  rect(doorX, y + 3, doorX, y + 3, 'd', true);
  if (windowX !== undefined) rect(windowX, y + 2, windowX, y + 2, 'w', true);
  object(id, 'scenery', x, y + 3, { variant, tw: w, th: 4, art: { ox: w * 8, oy: 16 } as LayoutObject['art'] });
}
// Outer woods: every edge is closed except the authored road mouths.
rect(-24, 24, 47, 25, ',', true); rect(-24, 93, 47, 95, ',', true);
rect(-24, 24, -22, 95, ',', true); rect(45, 24, 47, 95, ',', true);
// Six-tile roads, narrowing only at boundary posts.
rect(1, 24, 3, 24, ':'); rect(0, 25, 5, 43, '=');
rect(-24, 44, 25, 49, '='); rect(-24, 48, -22, 49, ',', true);
rect(-6, 44, -1, 84, '='); rect(20, 34, 25, 84, ':');
rect(-6, 79, 25, 84, ':'); rect(7, 85, 12, 92, ':'); rect(8, 93, 10, 95, ':');
rect(-24, 66, -7, 71, '='); rect(-24, 66, -22, 67, ',', true);
rect(26, 57, 44, 62, '='); rect(45, 58, 47, 60, '=');
rect(-10, 30, 16, 43, '+'); rect(0, 30, 5, 43, '=');
rect(1, 55, 18, 68, '='); rect(8, 50, 10, 54, ':'); rect(-1, 59, 1, 60, ':'); rect(19, 59, 20, 59, ':');
// Buildings and their approaches; indoor IDs remain unchanged in rooms.json.
house('house-west', 'p1:house-west', -14, 55, 6, -11, -9);
house('house-middle', 'p1:house-middle', 1, 50, 7, 4);
house('library', 'commons-art:hearthwick-library', -13, 73, 5, -11, -10);
house('house-ada', 'p1:house-ada', 28, 50, 6, 30, 32);
house('mill', 'mill-house', 28, 73, 4, 29, 30);
for (const [x, y] of [[-11, 59], [-11, 77], [29, 77], [30, 54]]) rect(x!, y!, x!, y!, ':');
// Silas's fenced yard, with a walk-through west entrance off Mill Way.
rect(27, 29, 41, 44, ':');
fence(27, 29, 41, 29); fence(41, 30, 41, 44); fence(27, 44, 40, 44);
fence(27, 30, 27, 34); fence(27, 37, 27, 43); rect(26, 35, 28, 36, ':');
house('cottage-silas', 'cottage-silas', 32, 31, 6, 34);
piece('sawhorse', 'sawhorse', 29, 35); prop('toolbox', 'tool-crate', 39, 36);
piece('firebox', 'firebox', 39, 39); piece('timber-stack', 'timber-stack', 35, 40);
piece('skids', 'skids', 32, 40); piece('woodpile', 'woodpile', 29, 41);
// Town Square: one lantern, well and board.
prop('hearth', 'lantern-post', 10, 60, 32, 'village');
prop('patched-bench', 'patched-bench', 8, 61, 18);
prop('trail-sign', 'trail-sign', 16, 59, 24);
prop('bread-basket', 'bread-basket', -13, 59, 12);
rect(12, 60, 13, 61, 'h', true);
object('town-well', 'well', 12, 61, { variant: 'commons-well', art: { ox: 16, oy: 16 } as LayoutObject['art'] }); rect(12, 56, 12, 56, '.', true);
object('town-board', 'board', 12, 56, { variant: 'notice-board' });
object('gate-hame', 'scenery', 0, 43, { variant: 'gatepost-small' });
piece('camp-pack', 'commons-art:wilds-pack', 7, 26); piece('camp-fire', 'commons-art:wilds-fire-ring', 7, 28);
// Pip's garden is open through the fallen-rail gap.
fence(6, 71, 12, 71); fence(6, 72, 6, 76); fence(12, 72, 12, 76);
fence(7, 76, 8, 76); fence(10, 76, 11, 76); rect(9, 76, 9, 78, ':');
// Mill pond: 24 pond tiles plus the three-tile race, with all banks dry.
rect(33, 73, 38, 76, '~', true); rect(32, 74, 32, 76, '~', true);
rect(33, 72, 39, 72, 's'); rect(39, 73, 39, 76, 's'); rect(32, 77, 40, 77, 's');
object('mill-hopper', 'scenery', 27, 76, { variant: 'mill-hopper' }); rect(27, 76, 27, 76, '.', true);
for (const [id, spot, x, y] of [['mara', '', 14, 61], ['orrin', '', 17, 57], ['pip', '', 10, 75], ['hazel', 'square', 11, 63], ['finn', 'door', 30, 77], ['ada', 'window', 32, 55], ['elara', 'camp', 6, 27], ['silas', 'yard', 29, 36]] as const)
  object(`npc:${id}`, 'npc-post', x, y, { npc: id, ...(spot ? { spot } : {}) });
for (const [id, x, y] of [['well-rope', 12, 60], ['village-lamp', 10, 60], ['bench-slat', 8, 61], ['fence-rail', 9, 76], ['library-roof', -11, 76], ['gate-hame', 0, 43]] as const)
  object(`repair:${id}`, 'repair', x, y, { target: id });
for (const [target, festival, coords] of [
  ['bloom-patch', 'Bloom', [[11,37],[12,37],[13,37],[11,38],[12,38]]],
  ['freshet-shore', 'Mudrise', [[34,72],[36,72],[38,72]]],
  ['pond-ice', 'Quiet', [[34,73],[37,73],[38,75]]],
] as const) for (const [i, [x,y]] of coords.entries()) object(`gather:${target}:${i}`, 'gather', x, y, { target, festival, label: target === 'bloom-patch' ? 'Pick Bloom flowers' : target === 'pond-ice' ? 'Break the pond ice' : 'Sweep the freshet shore', variant: target === 'pond-ice' ? 'pond-ice' : target === 'bloom-patch' ? 'wildflowers' : 'tangle-decor', ...(target === 'freshet-shore' ? { frame: `pebbles-${i}` } : {}), art: { ox: 8, oy: 16, depthY: true, tile: true } as LayoutObject['art'] });
// The only curated outdoor portal: Brackenwood. All four roads are walks.
object('exit:woodland', 'exit', 41, 64, { tw: 3, th: 1, label: 'Brackenwood & Ashwatch', exit: { to: 'woodland', entryTx: 2, entryTy: 15 } as LayoutObject['exit'] });
for (const [id, x, y, label] of [['north',1,25,'Beyond the arch: the Tangle.'], ['east',44,57,'Beyond the posts: the Eastern Reaches.'], ['south',7,92,'Beyond the posts: the Southern Mere.'], ['west',-23,67,'Homestead Lane & the Western Drift.']] as const)
  object(`boundary:${id}`, 'scenery', x, y, { variant: 'gatepost-small', label });
for (const [id, x, y] of [['north',4,26], ['east',44,61], ['south',11,92], ['west',-21,72]] as const) prop(`lamp:${id}`, 'lantern-post', x, y, 32, 'village');
for (const [id, variant, x, y] of [['madder-stall','stall-a',-5,35],['stall-b','stall-b',-1,38],['stall-c','stall-c',9,33],['bunting','bunting-96',2,31]] as const)
  object(id, 'scenery', x, y, { variant, festival: 'Carting Day', ...(id === 'bunting' ? { art: { ox: 8, oy: 16, depth: 5000 } as LayoutObject['art'] } : {}) });
// Wood silhouettes occupy only solid boundary tiles; no object blocks a mouth.
for (let y = 24; y <= 95; y += 3) for (const x of [-24,47]) if (solid[y - 24]![x + 24] === '#') object(`tree:${x},${y}`, 'tree', x, y, { variant: 'oak-canopy', width: 48 });
const town = { id: 'hearthwick', revision: 1, tx: 0, ty: 0, width: 72, height: 72, palette, ground: ground.map(r => r.join('')), solid: solid.map(r => r.join('')), objects };
// T4 placeholder: public spine/cross-lanes and doorstep paths are dry.
const lotGround = Array.from({ length: 96 }, () => Array<string>(48).fill(','));
const lotSolid = Array.from({ length: 96 }, () => Array<string>(48).fill('#'));
for (let g = 0; g < 8; g++) {
  const ox = (g % 2) * 24, oy = Math.floor(g / 2) * 24;
  for (let y = 1; y <= 18; y++) for (let x = 3; x <= 20; x++) { lotGround[oy + y]![ox + x] = '.'; lotSolid[oy + y]![ox + x] = '.'; }
  for (let y = 8; y <= 19; y++) for (const x of [11,12]) { lotGround[oy + y]![ox + x] = ':'; lotSolid[oy + y]![ox + x] = '.'; }
  for (let y = 20; y < 24; y++) for (let x = 0; x < 24; x++) { lotGround[oy + y]![ox + x] = ':'; lotSolid[oy + y]![ox + x] = '.'; }
}
for (let y = 0; y < 96; y++) for (let x = 22; x <= 25; x++) {
  lotGround[y]![x] = ':'; lotSolid[y]![x] = '.';
}
// Only the middle cross-lane opens the western boundary into the Wilds.
for (let y = 0; y < 96; y++) for (const x of [0, 1, 46, 47])
  if (!(x < 2 ? [44, 45, 46, 47] : [20, 21, 22, 23, 44, 45, 46, 47]).includes(y)) lotSolid[y]![x] = '#';
for (const y of [0, 1, 94, 95]) for (let x = 0; x < 48; x++) if (x < 22 || x > 25) lotSolid[y]![x] = '#';
const lotObjects: LayoutObject[] = [];
for (let gate = 0; gate < 8; gate++) {
  const x = gate % 2 * 24, y = Math.floor(gate / 2) * 24;
  for (const [id, kind, tx, ty] of [['gate', 'gate', 11, 19], ['sign', 'sign', 9, 20], ['shelf', 'shelf', 14, 20]] as const)
    lotObjects.push({ id: `lot:${gate}:${id}`, kind, tx: x + tx, ty: y + ty, gate, ...(kind === 'gate' ? { side: gate % 2 ? 'east' : 'west', tw: 2, th: 1, target: 'lot-entry' } : {}) } as LayoutObject);
  for (const tx of [2, 14]) lotObjects.push({ id: `lot:${gate}:fence:${tx}`, kind: 'scenery', tx: x + tx, ty: y + 19, variant: 'fence-h-8', art: { ox: 0, oy: 16, originLeft: true } } as LayoutObject);
}
const plots = { id:'homestead-lots', revision:2, tx:0, ty:0, width:48, height:96, palette, ground:lotGround.map(r=>r.join('')), solid:lotSolid.map(r=>r.join('')), objects:lotObjects };
for (const [path, doc] of [['content/places.json',places],['content/layouts/hearthwick.json',town],['content/layouts/homestead-lots.json',plots]] as const)
  writeFileSync(path, JSON.stringify(doc,null,2)+'\n');
if (existsSync('content/layouts/commons.json')) unlinkSync('content/layouts/commons.json');
