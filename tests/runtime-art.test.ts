import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  RUNTIME_ART_BASE,
  RUNTIME_ART_MANIFEST_KEY,
  RUNTIME_ART_SOURCE_KEYS,
  createRuntimeArt,
  installRuntimeAliases,
  preloadRuntimeArt,
  type RuntimeArtManifest,
} from '../src/game/runtime-art.ts'

const RUNTIME_PASS_DIR = fileURLToPath(
  new URL('../assets/generated/runtime-pass/', import.meta.url),
)
const PUBLIC_DIR = fileURLToPath(
  new URL('../public/assets/fingersnap/runtime-pass/', import.meta.url),
)

const manifest = JSON.parse(
  readFileSync(`${RUNTIME_PASS_DIR}manifest.json`, 'utf8'),
) as RuntimeArtManifest

const EXPECTED_SOURCE_FILES: Record<string, string> = {
  'fingersnap-npcs': 'fingersnap-npcs.png',
  'fingersnap-guardian': 'fingersnap-guardian.png',
  'fingersnap-class-effects': 'fingersnap-class-effects.png',
}

const EXPECTED_FRAME_KEYS = [
  'mara-idle-0',
  'mara-idle-1',
  'pip-idle-0',
  'pip-idle-1',
  'orrin-idle-0',
  'orrin-idle-1',
  'guardian-idle',
  'guardian-windup',
  'guardian-lunge',
  'guardian-hurt',
  'guardian-defeat',
  'cleave-0',
  'cleave-1',
  'cleave-2',
  'cleave-3',
  'magic-bolt-0',
  'magic-bolt-1',
  'magic-bolt-2',
  'magic-bolt-3',
  'dash-trail-0',
  'dash-trail-1',
  'dash-trail-2',
  'dash-trail-3',
  'healing-pulse-0',
  'healing-pulse-1',
  'healing-pulse-2',
  'healing-pulse-3',
]

const EXPECTED_ANIMATIONS = [
  {
    key: 'effect-cleave',
    frames: ['cleave-0', 'cleave-1', 'cleave-2', 'cleave-3'],
    frameRate: 12,
    repeat: 0,
  },
  {
    key: 'effect-magic-bolt',
    frames: ['magic-bolt-0', 'magic-bolt-1', 'magic-bolt-2', 'magic-bolt-3'],
    frameRate: 12,
    repeat: -1,
  },
  {
    key: 'effect-dash-trail',
    frames: ['dash-trail-0', 'dash-trail-1', 'dash-trail-2', 'dash-trail-3'],
    frameRate: 12,
    repeat: 0,
  },
  {
    key: 'effect-healing-pulse',
    frames: [
      'healing-pulse-0',
      'healing-pulse-1',
      'healing-pulse-2',
      'healing-pulse-3',
    ],
    frameRate: 12,
    repeat: 0,
  },
  {
    key: 'mara-breathing',
    frames: ['mara-idle-0', 'mara-idle-1'],
    frameRate: 1.5,
    repeat: -1,
  },
  {
    key: 'pip-breathing',
    frames: ['pip-idle-0', 'pip-idle-1'],
    frameRate: 1.5,
    repeat: -1,
  },
  {
    key: 'orrin-breathing',
    frames: ['orrin-idle-0', 'orrin-idle-1'],
    frameRate: 1.5,
    repeat: -1,
  },
]

const EXPECTED_ALIASES: Record<string, string> = {
  mara: 'mara-idle-0',
  pip: 'pip-idle-0',
  orrin: 'orrin-idle-0',
  guardian0: 'guardian-idle',
  guardian1: 'guardian-lunge',
  slash: 'cleave-2',
  bolt: 'magic-bolt-0',
}

const EFFECT_NATIVE_SIZE: Record<string, [number, number]> = {
  'cleave-': [18, 18],
  'magic-bolt-': [8, 8],
  'dash-trail-': [18, 18],
  'healing-pulse-': [32, 32],
}

function pngHeader(path: string): {
  width: number
  height: number
  colorType: number
} {
  const data = readFileSync(path)
  assert.equal(
    data.subarray(0, 8).toString('binary'),
    '\x89PNG\r\n\x1a\n',
    `${path} is not a PNG`,
  )
  assert.equal(data.subarray(12, 16).toString('binary'), 'IHDR', 'missing IHDR')
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    colorType: data.readUInt8(25),
  }
}

test('runtime-art exposes the agreed helper exports and load keys', () => {
  assert.equal(typeof preloadRuntimeArt, 'function')
  assert.equal(typeof createRuntimeArt, 'function')
  assert.equal(typeof installRuntimeAliases, 'function')
  assert.equal(RUNTIME_ART_MANIFEST_KEY, 'glimway-runtime-art')
  assert.equal(RUNTIME_ART_BASE, '/assets/fingersnap/runtime-pass/')
  assert.deepEqual(
    [...RUNTIME_ART_SOURCE_KEYS],
    Object.keys(EXPECTED_SOURCE_FILES),
  )
})

test('manifest header matches the runtime base URL and source sheets', () => {
  assert.equal(manifest.version, 1)
  assert.equal(manifest.baseUrl, RUNTIME_ART_BASE)
  assert.equal(manifest.specSource, 'docs/runtime-asset-spec.md')
  assert.deepEqual(
    manifest.sources.map((source) => source.key).sort(),
    Object.keys(EXPECTED_SOURCE_FILES).sort(),
  )
  for (const source of manifest.sources) {
    assert.equal(
      source.file,
      EXPECTED_SOURCE_FILES[source.key],
      `${source.key} is ${source.key}.png (the atlas build reads it by key)`,
    )
    const png = pngHeader(`${RUNTIME_PASS_DIR}${source.file}`)
    assert.equal(png.width, source.width, `${source.file} width drift`)
    assert.equal(png.height, source.height, `${source.file} height drift`)
    assert.equal(png.colorType, 6, `${source.file} must keep an alpha channel`)
  }
})

test('all 27 frames use measured rects inside their sheets and native canvases', () => {
  assert.equal(manifest.frames.length, 27)
  const frameKeys = manifest.frames.map((frame) => frame.key)
  assert.deepEqual([...frameKeys].sort(), [...EXPECTED_FRAME_KEYS].sort())
  assert.equal(new Set(frameKeys).size, frameKeys.length, 'duplicate frame key')

  const sources = new Map(
    manifest.sources.map((source) => [source.key, source]),
  )

  for (const frame of manifest.frames) {
    const source = sources.get(frame.source)
    assert.ok(source, `${frame.key} references unknown source ${frame.source}`)

    const s = frame.sourceRect
    assert.ok(s.w > 0 && s.h > 0, `${frame.key} sourceRect must be nonempty`)
    assert.ok(s.x >= 0 && s.y >= 0, `${frame.key} sourceRect origin out of sheet`)
    assert.ok(
      s.x + s.w <= source.width && s.y + s.h <= source.height,
      `${frame.key} sourceRect exceeds ${frame.source} bounds`,
    )

    const d = frame.destinationRect
    assert.ok(d.w > 0 && d.h > 0, `${frame.key} destinationRect must be nonempty`)
    assert.ok(d.x >= 0 && d.y >= 0, `${frame.key} destinationRect out of canvas`)
    assert.ok(
      d.x + d.w <= frame.width && d.y + d.h <= frame.height,
      `${frame.key} destinationRect exceeds ${frame.width}x${frame.height} canvas`,
    )

    if (frame.role === 'effect') {
      const prefix = Object.keys(EFFECT_NATIVE_SIZE).find((candidate) =>
        frame.key.startsWith(candidate),
      )
      assert.ok(prefix, `${frame.key} has no effect size rule`)
      const [width, height] = EFFECT_NATIVE_SIZE[prefix]
      assert.equal(frame.width, width, `${frame.key} native width`)
      assert.equal(frame.height, height, `${frame.key} native height`)
      assert.deepEqual(frame.origin, [0.5, 0.5], `${frame.key} center anchor`)
      assert.deepEqual(
        d,
        { x: 0, y: 0, w: width, h: height },
        `${frame.key} effect must fill its canvas`,
      )
    } else {
      const size = frame.role === 'npc' ? 16 : 24
      assert.equal(frame.width, size, `${frame.key} native width`)
      assert.equal(frame.height, size, `${frame.key} native height`)
      assert.deepEqual(frame.origin, [0.5, 1], `${frame.key} foot anchor`)
      assert.equal(
        d.y + d.h,
        frame.height,
        `${frame.key} must sit on the canvas foot baseline`,
      )
    }
  }
})

test('animation definitions reference frame keys with the agreed timing', () => {
  assert.equal(manifest.animations.length, EXPECTED_ANIMATIONS.length)
  const byKey = new Map(
    manifest.animations.map((definition) => [definition.key, definition]),
  )
  for (const expected of EXPECTED_ANIMATIONS) {
    const definition = byKey.get(expected.key)
    assert.ok(definition, `missing animation ${expected.key}`)
    assert.deepEqual(definition.frames, expected.frames, `${expected.key} frames`)
    assert.equal(definition.frameRate, expected.frameRate, `${expected.key} fps`)
    assert.equal(definition.repeat, expected.repeat, `${expected.key} repeat`)
    for (const frameKey of definition.frames) {
      assert.ok(
        EXPECTED_FRAME_KEYS.includes(frameKey),
        `${expected.key} references unknown frame ${frameKey}`,
      )
    }
  }
})

test('compatibility aliases map onto delivered frames', () => {
  assert.deepEqual(manifest.aliases, EXPECTED_ALIASES)
  for (const [alias, frameKey] of Object.entries(manifest.aliases)) {
    assert.ok(
      EXPECTED_FRAME_KEYS.includes(frameKey),
      `${alias} references unknown frame ${frameKey}`,
    )
  }
})

test('the public copy ships only the manifest (the frames come packed)', () => {
  assert.deepEqual(readdirSync(PUBLIC_DIR), ['manifest.json'])
  assert.ok(
    readFileSync(`${PUBLIC_DIR}manifest.json`).equals(readFileSync(`${RUNTIME_PASS_DIR}manifest.json`)),
    'public manifest is the delivered one',
  )
})
