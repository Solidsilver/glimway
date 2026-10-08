import test from 'node:test';
import assert from 'node:assert/strict';
import { ReportBook } from '../src/lib/api/reports.ts';

/** The report book (design server-first 2.2 "Reports", 2.4 "Tab and report ownership"). */

const village = { area: 'village', x: 400, y: 300 };

function bound(): ReportBook {
  const book = new ReportBook();
  book.reset(3);
  book.bind('client', 'gen-1', 0, 'gen-1');
  return book;
}

test('reports coalesce: casts sum, the latest place and vitals win', () => {
  const book = bound();
  book.note(village, 40, 30);
  book.cast();
  book.note({ ...village, x: 410 }, 35, 12);
  book.cast(2);
  const c = book.capture()!;
  assert.deepEqual(c, { client: 'client', generation: 'gen-1', seq: 1, basis: 3, place: { area: 'village', x: 410, y: 300 }, hp: 35, mana: 12, casts: 3 });
  assert.equal(book.capture(), c, 'a captured report is immutable: a retry sends exactly it');
});

test('a lost sequence keeps its casts: they never move into its successor', () => {
  const book = bound();
  book.note(village, 40, 30);
  book.cast(2);
  const first = book.capture()!;
  book.cast(1);
  // The answer to the first is a duplicate or never comes; the next report only carries what came after.
  assert.ok(book.ack({ ...first, accepted: false, staleBasis: false, casts: 0, placeIgnored: false }));
  const second = book.capture()!;
  assert.equal(second.seq, 2);
  assert.equal(second.casts, 1);
});

test('nothing new, nothing sent; a barrier forces a fresh acknowledgment', () => {
  const book = bound();
  book.note(village, 40, 30);
  const c = book.capture()!;
  book.ack({ ...c, accepted: true, staleBasis: false, casts: 0, placeIgnored: false });
  assert.equal(book.capture(), null);
  book.note(village, 40, 30);
  assert.equal(book.capture(), null, 'the same place and vitals are not news');
  assert.equal(book.capture(true)?.seq, 2);
  assert.deepEqual(book.barrier(), { client: 'client', generation: 'gen-1', seq: 1 });
});

test('an answer for another report retires nothing', () => {
  const book = bound();
  book.note(village, 40, 30);
  const c = book.capture()!;
  assert.equal(book.ack({ ...c, seq: 9, accepted: true, staleBasis: false, casts: 0, placeIgnored: false }), null);
  assert.equal(book.ack({ ...c, generation: 'other', accepted: true, staleBasis: false, casts: 0, placeIgnored: false }), null);
  assert.equal(book.captured, c);
});

test('the sequence survives a reload; a new generation starts over and drops the captured report', () => {
  const book = bound();
  book.note(village, 40, 30);
  book.capture();
  const again = new ReportBook(structuredClone(book.stored()));
  // Same tab, same lease: the generation resumes, and the server may have seen more than this page wrote down.
  again.bind('client', 'gen-1', 4, 'gen-1');
  assert.equal(again.captured?.seq, 1, 'the unanswered report is kept for its retry');
  again.ack({ ...again.captured!, accepted: true, staleBasis: false, casts: 0, placeIgnored: false });
  again.note({ ...village, x: 1 }, 40, 30);
  assert.equal(again.capture()?.seq, 5);
  const fresh = new ReportBook(structuredClone(again.stored()));
  fresh.bind('client', 'gen-2', 7, 'gen-1');
  assert.equal(fresh.captured, null, 'a captured report is never rebound to a new generation');
  fresh.note({ ...village, x: 2 }, 40, 30);
  assert.equal(fresh.capture()?.seq, 1);
});

test('a fall is a boundary: earlier combat is void and the next report waits for its answer', () => {
  const book = bound();
  book.note(village, 10, 5);
  book.cast(3);
  book.fall(7, { area: 'village', x: 400, y: 300 }, { hp: 13, mana: 15 });
  assert.deepEqual([book.next.place, book.next.hp, book.next.mana], [{ area: 'village', x: 400, y: 300 }, 13, 15], 'the recovery is written with the boundary');
  assert.equal(book.capture(), null, 'no basis for after the fall yet');
  book.cast();
  book.release(7, 9);
  const c = book.capture()!;
  assert.equal(c.basis, 9);
  assert.equal(c.casts, 1, 'only what happened after the fall');
});

test('a server vitals write (a rest) starts over from its basis', () => {
  const book = bound();
  book.note(village, 10, 5);
  book.cast(2);
  book.reset(6);
  book.note(village, 50, 30);
  const c = book.capture()!;
  assert.equal(c.basis, 6);
  assert.equal(c.casts, 0);
});

test('no report before the lease names a generation', () => {
  const book = new ReportBook();
  book.note(village, 1, 1);
  assert.equal(book.capture(true), null);
});
