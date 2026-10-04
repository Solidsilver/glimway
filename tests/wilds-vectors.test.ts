import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serializeWildsVectors } from '../scripts/wilds-vectors.ts';

test('committed wilds parity vectors match the real TypeScript functions', () => {
  assert.equal(
    readFileSync(new URL('../content/vectors/wilds.json', import.meta.url), 'utf8'),
    serializeWildsVectors(),
    'Run npm run vectors:wilds after intentional generator changes',
  );
});
