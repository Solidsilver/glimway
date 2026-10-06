import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ITEM_ART_FALLBACK,
  ITEMS_ART_PREFIX,
  ITEMS_PACKED_KEY,
  ITEMS_PASS_BASE,
  ITEMS_PASS_MANIFEST_KEY,
  createItemsPass,
  initItemsManifest,
  installItemsPass,
  itemIcon,
  itemWorldArt,
  itemsArtKey,
  itemsFrame,
  preloadItemsPass,
  type ItemsPassManifest,
} from '../src/game/items-pass.ts'
import { COMMONS_DECORATION_IDS } from '../src/game/atlas-plan.ts'
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts'

const PUBLIC_DIR = fileURLToPath(new URL('../public/assets/fingersnap/items-pass/', import.meta.url))
const SOURCE_DIR = fileURLToPath(new URL('../assets/generated/items-pass/', import.meta.url))

const manifest = JSON.parse(readFileSync(`${PUBLIC_DIR}manifest.json`, 'utf8')) as ItemsPassManifest
initItemsManifest(manifest)

const frameByKey = new Map(manifest.frames.map((f) => [f.key, f]))

function pngHeader(path: string): { width: number; height: number; colorType: number } {
  const data = readFileSync(path)
  assert.equal(data.subarray(0, 8).toString('binary'), '\x89PNG\r\n\x1a\n', `${path} is not a PNG`)
  assert.equal(data.subarray(12, 16).toString('binary'), 'IHDR', 'missing IHDR')
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), colorType: data.readUInt8(25) }
}

test('items-pass exposes its loader and load keys', () => {
  assert.equal(typeof preloadItemsPass, 'function')
  assert.equal(typeof createItemsPass, 'function')
  assert.equal(typeof installItemsPass, 'function')
  assert.equal(typeof itemIcon, 'function')
  assert.equal(ITEMS_PASS_MANIFEST_KEY, 'fingersnap-items-pass')
  assert.equal(ITEMS_PASS_BASE, '/assets/fingersnap/items-pass/')
  assert.equal(ITEMS_ART_PREFIX, 'items-art:')
  assert.equal(ITEMS_PACKED_KEY, 'packed-items')
  assert.equal(ITEM_ART_FALLBACK, 'items-art:fallback')
  assert.equal(itemsArtKey('item-bench-axe-whole'), 'items-art:item-bench-axe-whole')
})

test('the manifest’s 12 source sheets are delivered as transparent RGBA PNGs of the stated size', () => {
  assert.equal(manifest.sources.length, 12)
  for (const s of manifest.sources) {
    const h = pngHeader(`${SOURCE_DIR}${s.file}`)
    assert.deepEqual([h.width, h.height], [s.width, s.height], s.file)
    assert.equal(h.colorType, 6, `${s.file} is RGBA`)
  }
})

test('every frame has a measured source rect inside its sheet and a destination inside its native canvas', () => {
  assert.equal(manifest.frames.length, 170)
  assert.equal(frameByKey.size, manifest.frames.length, 'frame keys are unique')
  const sources = new Map(manifest.sources.map((s) => [s.key, s]))
  const rects = new Set<string>()
  for (const f of manifest.frames) {
    const src = sources.get(f.source)!
    assert.ok(src, `${f.key}: unknown source ${f.source}`)
    const s = f.sourceRect
    assert.ok(s.x >= 0 && s.y >= 0 && s.w > 0 && s.h > 0 && s.x + s.w <= src.width && s.y + s.h <= src.height, `${f.key}: sourceRect inside ${src.file}`)
    const d = f.destinationRect
    assert.ok(d.x >= 0 && d.y >= 0 && d.w > 0 && d.h > 0 && d.x + d.w <= f.width && d.y + d.h <= f.height, `${f.key}: destinationRect inside ${f.width}x${f.height}`)
    assert.ok(f.origin.every((o) => o >= 0 && o <= 1), `${f.key}: origin`)
    rects.add(`${f.source}:${s.x},${s.y}`)
  }
  assert.equal(rects.size, manifest.frames.length)
})

test('inventory icons have role inventory-icon and native dimensions', () => {
  const icons = manifest.frames.filter((f) => f.role === 'inventory-icon')
  assert.equal(icons.length, 110)
  for (const icon of icons) {
    assert.ok(icon.key.startsWith('item-'), `${icon.key} has item- prefix`)
    assert.ok(icon.width > 0 && icon.height > 0)
    assert.ok(icon.itemId, `${icon.key} has itemId`)
  }
})

test('Tolley mill frames match expected native sizes and origins', () => {
  const house = frameByKey.get('mill-house')!
  assert.ok(house, 'mill-house exists')
  assert.deepEqual([house.width, house.height, ...house.origin], [64, 64, 0.5, 1])

  const hopper = frameByKey.get('mill-hopper')!
  assert.ok(hopper, 'mill-hopper exists')
  assert.deepEqual([hopper.width, hopper.height, ...hopper.origin], [16, 20, 0.5, 1])

  for (let i = 0; i < 4; i++) {
    const w = frameByKey.get(`mill-wheel-${i}`)!
    assert.ok(w, `mill-wheel-${i} exists`)
    assert.deepEqual([w.width, w.height, ...w.origin], [32, 32, 0.5, 0.5])

    const wm = frameByKey.get(`mill-wheel-mended-${i}`)!
    assert.ok(wm, `mill-wheel-mended-${i} exists`)
    assert.deepEqual([wm.width, wm.height, ...wm.origin], [32, 32, 0.5, 0.5])
  }

  for (let i = 0; i < 2; i++) {
    const froth = frameByKey.get(`mill-froth-${i}`)!
    assert.ok(froth, `mill-froth-${i} exists`)
    assert.deepEqual([froth.width, froth.height, ...froth.origin], [14, 6, 0.5, 0.5])
  }
})

test('only the three authored mill animations loop', () => {
  assert.equal(manifest.animations.length, 3)
  const anims = new Map(manifest.animations.map((a) => [a.key, a]))

  const wheel = anims.get('mill-wheel')!
  assert.deepEqual(wheel.frames, ['mill-wheel-0', 'mill-wheel-1', 'mill-wheel-2', 'mill-wheel-3'])
  assert.equal(wheel.frameRate, 4)
  assert.equal(wheel.repeat, -1)

  const mended = anims.get('mill-wheel-mended')!
  assert.deepEqual(mended.frames, ['mill-wheel-mended-0', 'mill-wheel-mended-1', 'mill-wheel-mended-2', 'mill-wheel-mended-3'])
  assert.equal(mended.frameRate, 4)
  assert.equal(mended.repeat, -1)

  const froth = anims.get('mill-froth')!
  assert.deepEqual(froth.frames, ['mill-froth-0', 'mill-froth-1'])
  assert.equal(froth.frameRate, 6)
  assert.equal(froth.repeat, -1)
})

test('state groups describe discrete variants, not animations', () => {
  assert.equal(manifest.stateGroups.length, 31)
  for (const group of manifest.stateGroups) {
    assert.match(group.selection, /never auto-loop/i, `${group.key} must never auto-loop`)
    for (const frame of group.frames) {
      assert.ok(frameByKey.has(frame), `${frame} in ${group.key} exists`)
    }
  }
})

test('commons aliases resolve to commons-art textures without duplicating them', () => {
  const commonsAliases = Object.entries(manifest.aliases).filter(([_, target]) => target.startsWith('commons:'))
  assert.equal(commonsAliases.length, 9)
  const expectedCommons = [
    ['timber', 'commons:icon-timber'],
    ['woodpile', 'commons:woodpile'],
    ['candle-hulls', 'commons:candle-hull-0'],
    ['carting-bunting', 'commons:bunting'],
    ['whittled-fox', 'commons:icon-whittled-fox'],
    ['river-glass-bead', 'commons:icon-river-glass-bead'],
    ['tin-whistle', 'commons:icon-tin-whistle'],
    ['beeswax-candle', 'commons:icon-beeswax-candle'],
    ['spare-bootlace', 'commons:icon-spare-bootlace'],
  ]
  assert.deepEqual(commonsAliases.sort(), expectedCommons.sort())

  for (const [id, target] of expectedCommons) {
    const icon = itemIcon(id)
    assert.equal(icon, 'commons-art:' + target.slice('commons:'.length), `${id} resolves to existing commons-art`)
  }
})

test('itemIcon resolves item IDs, discrete states, and fallbacks', () => {
  // Default resolution via aliases
  assert.equal(itemIcon('bench-axe'), 'items-art:item-bench-axe-whole')
  assert.equal(itemIcon('bench-pick'), 'items-art:item-bench-pick-whole')
  assert.equal(itemIcon('watering-can'), 'items-art:item-watering-can')

  // Explicit state resolution
  assert.equal(itemIcon('bench-axe', 'whole'), 'items-art:item-bench-axe-whole')
  assert.equal(itemIcon('bench-axe', 'worn'), 'items-art:item-bench-axe-worn')
  assert.equal(itemIcon('brack-felling-axe', 'blunt'), 'items-art:item-brack-felling-axe-blunt')
  assert.equal(itemIcon('carters-lantern', 'lit'), 'items-art:item-carters-lantern-lit')
  assert.equal(itemIcon('carters-lantern', 'unlit'), 'items-art:item-carters-lantern-unlit')
  assert.equal(itemIcon('turncap-jar', 'dried-out'), 'items-art:item-turncap-jar-dried-out')

  // Fallback for items with no art
  assert.equal(itemIcon('unknown-item'), ITEM_ART_FALLBACK)
  assert.equal(itemIcon('nonexistent-potion'), ITEM_ART_FALLBACK)
  assert.equal(itemIcon('unknown-item', undefined, 'custom-fallback'), 'custom-fallback')

  // Fallback for nonexistent state on known item
  assert.equal(itemIcon('bench-axe', 'broken'), ITEM_ART_FALLBACK)
})

test('itemsFrame queries frame metadata for delivered keys and aliases', () => {
  const f1 = itemsFrame('bench-axe')
  assert.ok(f1)
  assert.equal(f1.key, 'item-bench-axe-whole')
  assert.equal(f1.itemId, 'bench-axe')
  assert.equal(f1.state, 'whole')

  const f2 = itemsFrame('item-bench-axe-worn')
  assert.ok(f2)
  assert.equal(f2.state, 'worn')

  // Commons aliases return null from itemsFrame (they live in commons-pass)
  assert.equal(itemsFrame('timber'), null)
})

test('itemWorldArt resolves placed pieces to their world sprites', () => {
  assert.equal(itemWorldArt('writing-desk'), 'items-art:world-writing-desk')
  assert.equal(itemWorldArt('gate-shelf'), 'items-art:world-gate-shelf-empty')
  assert.equal(itemWorldArt('empty-chair'), 'items-art:world-empty-chair')
  assert.equal(itemWorldArt('window-lamp', 'unlit-pane'), 'items-art:world-window-lamp-unlit-pane')
  // Without a state: the first delivered world sprite of the item wins.
  assert.equal(itemWorldArt('window-lamp'), 'items-art:world-window-lamp-unlit-pane')
  // No world sprite for an unknown item, and no invented art.
  assert.equal(itemWorldArt('unknown-item'), null)
  // A commons alias stands in when there's no world sprite (the placed
  // woodpile draws the commons pass's pile).
  assert.equal(itemWorldArt('woodpile'), 'commons-art:woodpile')
  assert.equal(itemWorldArt('candle-hulls'), 'commons-art:candle-hull-0')
  assert.equal(itemWorldArt('carting-bunting'), 'commons-art:bunting')
})

test('every home good resolves to art: runtime deco, world sprite or commons alias', () => {
  for (const it of HOMESTEAD_DATA.items) {
    const ok = COMMONS_DECORATION_IDS.has(it.id) || itemWorldArt(it.id) !== null
    assert.ok(ok, `${it.id} has no deco key, world sprite or commons alias`)
  }
})
