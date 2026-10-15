import test from 'node:test'
import assert from 'node:assert/strict'
import { shadePixels } from '../src/game/lot-shade.ts'

test('lot shade covers the fence margins as one mask with a smooth light edge', () => {
  const bounds = { x: 0, y: 1, w: 24, h: 22 }
  const pixels = shadePixels([{ x: 12, y: 7, radius: 7 }], bounds, 0.28)
  const width = bounds.w * 16
  const alpha = (x: number, y: number) => pixels[(y * width + x) * 4 + 3]!
  assert.equal(pixels.length, width * 352 * 4)
  for (const [x,y] of [[0,0],[383,0],[0,351],[383,351]]) assert.equal(alpha(x!,y!),71,'tint reaches every boundary corner')
  assert.equal(alpha(200,104),0,'the centre of the home light stays clear')
  const transition = Array.from({length:32},(_,i)=>alpha(292+i,104))
  assert.ok(new Set(transition).size>8,'light edge has sub-tile alpha values, not tile rectangles')
  for (let i=1;i<transition.length;i++) assert.ok(transition[i]!>=transition[i-1]!,'no alternating rectangle seams')
})
