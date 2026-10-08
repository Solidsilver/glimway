import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compareVersions, latestRelease, parseChangelog, parseSeen, releasesSince, whatsNewOnStart } from '../src/lib/changelog.ts'

const SAMPLE = `# Changelog

Intro with a [link](https://example.com).

## [Unreleased]

### For players

- Fishing at the mill pond.

### Technical

- Not for players.

## [0.2.0] - 2026-11-01

A short intro paragraph.

### For players

- Rooms are places now: walk into Hazel's kitchen
  and up to Finn's loft.
- The **Quests** tab, with [a pinned goal](docs/quests.md) and \`code\` words.

### Technical

- The interactions path.

## [0.1.0] - 2026-10-07

### For players

- Walk the old lantern road.

### Technical

- Svelte 5.
`

test('each release keeps only its players’ lines, joined and plain', () => {
  const releases = parseChangelog(SAMPLE)
  assert.deepEqual(
    releases.map((r) => [r.version, r.date]),
    [['Unreleased', null], ['0.2.0', '2026-11-01'], ['0.1.0', '2026-10-07']]
  )
  assert.deepEqual(releases[1].players, [
    'Rooms are places now: walk into Hazel\'s kitchen and up to Finn\'s loft.',
    'The Quests tab, with a pinned goal and code words.'
  ])
  assert.deepEqual(releases[0].players, ['Fishing at the mill pond.'])
  assert.deepEqual(releases[2].players, ['Walk the old lantern road.'])
})

test('versions compare as numbers, and only released ones count', () => {
  assert.ok(compareVersions('0.10.0', '0.9.3') > 0)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  const releases = parseChangelog(SAMPLE)
  assert.deepEqual(releasesSince(releases, '0.1.0', '0.2.0').map((r) => r.version), ['0.2.0'])
  assert.deepEqual(releasesSince(releases, '0.0.9', '0.2.0').map((r) => r.version), ['0.2.0', '0.1.0'])
  assert.deepEqual(releasesSince(releases, '0.0.9', '0.1.5').map((r) => r.version), ['0.1.0'], 'never a release newer than this build')
  assert.equal(latestRelease(releases, '0.2.0')?.version, '0.2.0')
  assert.equal(latestRelease(releases, '0.0.1'), null)
})

test('a pre-release comes before its release, and shows the releases before it', () => {
  assert.ok(compareVersions('0.3.0-alpha.1', '0.3.0') < 0)
  assert.ok(compareVersions('0.3.0-alpha.1', '0.2.0') > 0)
  assert.ok(compareVersions('0.3.0-alpha.10', '0.3.0-alpha.2') > 0)
  assert.equal(compareVersions('0.3.0-alpha.2', '0.3.0-alpha.2'), 0)
  const releases = parseChangelog(SAMPLE)
  assert.deepEqual(releasesSince(releases, '0.1.0', '0.3.0-alpha.1').map((r) => r.version), ['0.2.0'])
  assert.deepEqual(releasesSince(releases, '0.2.0-alpha.3', '0.2.0').map((r) => r.version), ['0.2.0'])
})

test('the card shows after an update, once, and never to a device that has nothing to catch up from', () => {
  const releases = parseChangelog(SAMPLE)
  const now = { version: '0.2.0', build: 'abc123' }
  assert.deepEqual(whatsNewOnStart(null, now, releases), { show: [], remember: now }, 'first time: catch up quietly')
  assert.deepEqual(whatsNewOnStart(now, now, releases), { show: [], remember: null }, 'same build: nothing')
  const after = whatsNewOnStart({ version: '0.1.0', build: 'old' }, now, releases)
  assert.deepEqual(after.show.map((r) => r.version), ['0.2.0'])
  assert.deepEqual(after.remember, now)
  assert.deepEqual(whatsNewOnStart({ version: '0.2.0', build: 'old' }, now, releases), { show: [], remember: now }, 'a new build of the same version')
})

test('a stored record is read defensively', () => {
  assert.deepEqual(parseSeen({ version: '0.1.0', build: 'x' }), { version: '0.1.0', build: 'x' })
  assert.equal(parseSeen('0.1.0'), null)
  assert.equal(parseSeen({ version: 1, build: 'x' }), null)
})

test('the real changelog parses: every release has players’ lines', () => {
  const releases = parseChangelog(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'))
  const released = releases.filter((r) => r.version !== 'Unreleased')
  assert.ok(released.length >= 1)
  for (const r of released) assert.ok(r.players.length > 0, `${r.version} has no "For players" lines`)
  for (const r of releases) for (const line of r.players) assert.doesNotMatch(line, /\]\(|`|\*\*/, 'markdown left in a line')
})
