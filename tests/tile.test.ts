import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TILE, tileAt, tileBottom, tileCenter, tileFeet, tileKey, tileMid } from '../src/lib/tile.ts';
import homestead from '../content/homestead.json' with { type: 'json' };

test('tile ↔ px conversions', () => {
  assert.equal(TILE, 16);
  assert.equal(tileMid(3), 3 * 16 + 8);
  assert.equal(tileBottom(3), 4 * 16);
  assert.deepEqual(tileCenter(2, 5), { x: 40, y: 88 });
  assert.deepEqual(tileFeet(2, 5), { x: 40, y: 96 });
  assert.equal(tileAt(31.9), 1);
  assert.equal(tileAt(32), 2);
  assert.equal(tileAt(-0.5), -1);
  assert.equal(tileKey(4, -2), '4,-2');
});

test('the server and the content use the same tile size', () => {
  assert.equal(homestead.commons.tileSize, TILE);
  const wilds = readFileSync(new URL('../server/internal/api/wilds.go', import.meta.url), 'utf8');
  assert.match(wilds, new RegExp(`wildsTileSize\\s*=\\s*${TILE}\\b`));
});
