/**
 * Compare two sets of screenshots pixel by pixel (the walk's look check,
 * perf/walk.perf.ts): every PNG in <a> against the one of the same name in
 * <b>. Prints, per image, how many pixels differ and by how much at most,
 * and writes <out>/<name>.png: the image greyed, differing pixels red.
 *
 *   node scripts/png-diff.ts <dir a> <dir b> [out dir]
 */
import { deflateSync, crc32 } from 'node:zlib'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { decodePng } from './png-decode.ts'

const [a, b, out] = process.argv.slice(2)
if (!a || !b) {
  console.error('usage: node scripts/png-diff.ts <dir a> <dir b> [out dir]')
  process.exit(2)
}
if (out) mkdirSync(out, { recursive: true })

function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const chunk = (kind: string, body: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const kb = Buffer.concat([Buffer.from(kind, 'latin1'), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(kb) >>> 0)
    return Buffer.concat([len, kb, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

let worst = 0
for (const name of readdirSync(a).filter((n) => n.endsWith('.png')).sort()) {
  let pb
  try {
    pb = decodePng(readFileSync(`${b}/${name}`))
  } catch {
    console.log(`${name.padEnd(24)} missing in ${b}`)
    continue
  }
  const pa = decodePng(readFileSync(`${a}/${name}`))
  if (pa.w !== pb.w || pa.h !== pb.h) {
    console.log(`${name.padEnd(24)} sizes differ: ${pa.w}×${pa.h} against ${pb.w}×${pb.h}`)
    continue
  }
  const diff = new Uint8Array(pa.data.length)
  let differ = 0
  let max = 0
  for (let i = 0; i < pa.data.length; i += 4) {
    const d = Math.max(Math.abs(pa.data[i]! - pb.data[i]!), Math.abs(pa.data[i + 1]! - pb.data[i + 1]!), Math.abs(pa.data[i + 2]! - pb.data[i + 2]!))
    const grey = Math.round((pa.data[i]! + pa.data[i + 1]! + pa.data[i + 2]!) / 6)
    if (d > 0) {
      differ++
      max = Math.max(max, d)
      diff.set([255, 0, 0, 255], i)
    } else diff.set([grey, grey, grey, 255], i)
  }
  worst = Math.max(worst, differ)
  const share = ((100 * differ) / (pa.w * pa.h)).toFixed(3)
  console.log(`${name.padEnd(24)} ${String(differ).padStart(8)} px differ (${share}%), largest channel change ${max}`)
  if (out) writeFileSync(`${out}/${name}`, encodePng(pa.w, pa.h, diff))
}
process.exitCode = worst > 0 ? 1 : 0
