import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_CANVAS_RATIO, canvasZoomFor, screenCanvasRatio, snapScroll, zoomFor } from '../src/game/viewport.ts'
import { PHONE_SCREEN_SCALE, densityFor } from '../src/game/density.ts'
import { ART_DENSITY, PHONE_ART_DENSITY } from '../src/game/atlas-plan.ts'

test('zoomFor: phones at 2 CSS px per world px either way up, larger screens by height', () => {
  assert.equal(zoomFor(390, 844), 2)
  assert.equal(zoomFor(844, 390), 2)
  assert.equal(zoomFor(360, 780), PHONE_SCREEN_SCALE)
  assert.equal(zoomFor(1280, 800), 3)
  assert.equal(zoomFor(2560, 1440), 5)
})

test('canvasZoomFor: the same stretch of world at any canvas ratio', () => {
  for (const [w, h] of [[390, 844], [844, 390], [1280, 800], [412, 915]]) {
    for (const r of [1, 2, 2.625, 3]) {
      const cw = Math.round(w * r)
      const ch = Math.round(h * r)
      const z = canvasZoomFor(cw, ch, r)
      assert.equal(z, zoomFor(w, h) * r, `${w}×${h} at ${r}`)
      // World px across: what the camera shows (the canvas rounds to whole px).
      assert.ok(Math.abs(cw / z - w / zoomFor(w, h)) < 0.1, `${w}×${h} at ${r}: ${cw / z} world px across`)
    }
  }
  // A 3× phone: 6 canvas px a world px.
  assert.equal(canvasZoomFor(1170, 2532, 3), 6)
})

test('screenCanvasRatio: the device pixel ratio, from 1 up to the cap', () => {
  assert.equal(screenCanvasRatio(1), 1)
  assert.equal(screenCanvasRatio(2), 2)
  assert.equal(screenCanvasRatio(2.625), 2.625)
  assert.equal(screenCanvasRatio(3), 3)
  assert.equal(screenCanvasRatio(4), MAX_CANVAS_RATIO)
  assert.equal(screenCanvasRatio(0.5), 1)
  assert.equal(screenCanvasRatio(0), 1)
})

test('densityFor: phones keep the texels their canvas shows', () => {
  assert.equal(densityFor(false, true, 3), 1, 'no WebGL: density 1')
  assert.equal(densityFor(false, false, 1), 1)
  assert.equal(densityFor(true, false, 1), ART_DENSITY, 'a large screen: the whole art')
  assert.equal(densityFor(true, false, 2), ART_DENSITY)
  assert.equal(densityFor(true, true, 1), ART_DENSITY / 2, 'a 1× phone: 2 canvas px a world px, the packs box-filtered 2:1')
  assert.equal(densityFor(true, true, 1.25), PHONE_ART_DENSITY, 'a phone above 1×: more canvas px a world px than half the art')
  assert.equal(densityFor(true, true, 2), PHONE_ART_DENSITY, 'a 2× phone: 4 canvas px a world px')
  assert.equal(densityFor(true, true, 3), PHONE_ART_DENSITY, 'a 3× phone: 6 canvas px a world px')
  assert.ok(PHONE_ART_DENSITY <= ART_DENSITY, 'phones never keep more than the packs hold')
})

test('snapScroll: the world lands on whole canvas pixels at a fractional zoom, at most half a pixel from the eased scroll', () => {
  for (const zoom of [1.5, 2.5, 3, 2.25, 4.5]) {
    for (const origin of [400, 400.5, 683]) {
      for (let scroll = -20; scroll < 40; scroll += 0.37) {
        const s = snapScroll(scroll, origin, zoom)
        const px = (s + origin) * zoom
        assert.ok(Math.abs(px - Math.round(px)) < 1e-9, `zoom ${zoom} origin ${origin} scroll ${scroll}: ${px}`)
        assert.ok(Math.abs(s - scroll) * zoom <= 0.5 + 1e-9, 'never more than half a canvas pixel off')
      }
    }
  }
  assert.equal(snapScroll(12.5, 400, 0), 12.5, 'no zoom yet: left as it is')
})
