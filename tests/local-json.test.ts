import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJson, stringList, writeJson } from '../src/lib/local-json.ts';

const g = globalThis as { localStorage?: unknown };

function withStorage(storage: unknown, run: () => void): void {
  const before = g.localStorage;
  g.localStorage = storage;
  try {
    run();
  } finally {
    g.localStorage = before;
  }
}

function memory(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed));
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
  };
}

test('readJson: stored values go through the parser', () => {
  withStorage(memory({ k: '["a", 1, "b"]' }), () => {
    assert.deepEqual(readJson('k', stringList, []), ['a', 'b']);
  });
});

test('readJson: missing, empty, damaged or rejected records give the fallback', () => {
  withStorage(memory({ empty: '', bad: '{nope', odd: '7' }), () => {
    assert.deepEqual(readJson('missing', stringList, ['x']), ['x']);
    assert.deepEqual(readJson('empty', stringList, ['x']), ['x']);
    assert.deepEqual(readJson('bad', stringList, ['x']), ['x']);
    assert.deepEqual(readJson('odd', (v) => { if (typeof v !== 'string') throw new Error('no'); return v; }, 'fb'), 'fb');
    assert.deepEqual(readJson('odd', stringList, ['x']), []);
  });
});

test('readJson and writeJson never throw when storage is blocked or absent', () => {
  const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  withStorage(blocked, () => {
    assert.deepEqual(readJson('k', stringList, ['fb']), ['fb']);
    assert.equal(writeJson('k', ['a']), false);
  });
  withStorage(undefined, () => {
    assert.deepEqual(readJson('k', stringList, ['fb']), ['fb']);
    assert.equal(writeJson('k', ['a']), false);
  });
});

test('writeJson stores JSON that readJson reads back', () => {
  const m = memory();
  withStorage(m, () => {
    assert.equal(writeJson('k', { a: 1 }), true);
    assert.equal(m.items.get('k'), '{"a":1}');
    assert.deepEqual(readJson('k', (v) => v, null), { a: 1 });
  });
});
