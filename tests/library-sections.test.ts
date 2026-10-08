import test from 'node:test';
import assert from 'node:assert/strict';
import papersJson from '../content/papers.json' with { type: 'json' };
import { LIBRARY_SECTIONS, openingSection, sectionForStyle, sectionOf } from '../src/content/library.ts';
import { PAPERS } from '../src/content/papers.ts';
import { KEEPER, keeperTalk, LIBRARY_ACTION, KNOCK_LINES } from '../src/content/residents.ts';

test('every paper kind has a default section, and every paper its own section in the shared catalog', () => {
  const styles = new Set(PAPERS.map((p) => p.style));
  for (const style of styles) assert.equal(LIBRARY_SECTIONS.filter((s) => s.styles.includes(style)).length, 1, style);
  assert.deepEqual(LIBRARY_SECTIONS.map((s) => s.label), ['Stories', 'Histories', 'Recipes', 'Field notes']);
  for (const s of LIBRARY_SECTIONS) assert.ok(PAPERS.some((p) => sectionOf(p) === s.id), `${s.label} has papers`);
  // content/papers.json carries each paper's section (the server reads it too).
  const bySection = new Map(papersJson.papers.map((p) => [p.id, p.section]));
  for (const p of PAPERS) assert.equal(bySection.get(p.id), p.section, p.id);
});

test('sections are exact where a kind would shelve a paper wrongly', () => {
  const section = (title: string) => PAPERS.find((p) => p.title.startsWith(title))!.section;
  assert.equal(section('Recipe Card'), 'recipes');
  assert.equal(section('Remedies of the Oaker Hills'), 'recipes', 'a printed page, but remedies');
  assert.equal(section('The Brackenwood Cutter'), 'recipes');
  assert.equal(section('“Principia Memoria”'), 'field-notes', 'a printed page, but a treatise');
  assert.equal(section('The Ashwatch Skipping Game'), 'stories', 'a notebook page, but a rhyme');
  assert.equal(section('Field Notes of E. Quill'), 'field-notes');
  assert.equal(section('The Boy Who Ran'), 'stories');
  // Everything else follows its kind.
  const overridden = PAPERS.filter((p) => p.section !== sectionForStyle(p.style));
  assert.ok(overridden.length > 0 && overridden.length < PAPERS.length / 3);
});

test('a section opens on itself once something in it is shelved; else the whole collection', () => {
  const card = PAPERS.find((p) => p.section === 'recipes')!;
  const song = PAPERS.find((p) => p.style === 'song')!;
  assert.equal(openingSection('recipes', [song]), null, 'nothing on the Recipes shelves yet');
  assert.equal(openingSection('recipes', [song, card]), 'recipes');
  assert.equal(openingSection('stories', [song]), 'stories');
  assert.equal(openingSection(null, [song]), null);
  assert.equal(openingSection('nonsense', [song]), null);
});

test('Elara at the library: her lines, the shelves and Donate, and the rest of her talk kept', () => {
  const base = { speaker: 'Elara', lines: ['A greeting.'], choices: [{ text: 'Heard anything?', reply: ['…'], replay: true }, { text: 'Hear it again', replay: true }, { text: 'Be on my way', dismiss: true }] };
  const d = keeperTalk(base, false);
  assert.deepEqual(d.lines, [...KEEPER.lines]);
  assert.deepEqual(d.choices!.map((c) => c.text), [KEEPER.shelves.text, KEEPER.donate.text, 'Heard anything?', 'Not yet']);
  assert.equal(d.choices![0].action, `${LIBRARY_ACTION}shelf`);
  assert.equal(d.choices![1].action, `${LIBRARY_ACTION}donate`);
  // The first time: her introduction, then the room's line.
  const first = keeperTalk({ speaker: 'Elara', lines: ['Mind the jars.'] }, true);
  assert.deepEqual(first.lines, ['Mind the jars.', KEEPER.firstLine]);
  assert.ok(KNOCK_LINES.elara);
  assert.match(KEEPER.away, /Donations wait for me/);
});
