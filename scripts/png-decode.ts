/**
 * Decode a PNG to straight (unpremultiplied) RGBA in Node, exactly as stored:
 * 8-bit greyscale, RGB, palette, grey+alpha or RGBA, not interlaced (what
 * the delivered sheets are). The atlas build measures figures from these
 * texels (src/game/figures.ts), and tests read the same sheets.
 */
import { inflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

export interface DecodedPng {
  w: number
  h: number
  /** RGBA, row-major. */
  data: Uint8Array
}

export function decodePng(buf: Buffer): DecodedPng {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let w = 0, h = 0, depth = 0, type = 0, interlace = 0
  let palette: Buffer | null = null
  let trns: Buffer | null = null
  const idat: Buffer[] = []
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at)
    const kind = buf.toString('latin1', at + 4, at + 8)
    const body = buf.subarray(at + 8, at + 8 + len)
    if (kind === 'IHDR') {
      w = body.readUInt32BE(0)
      h = body.readUInt32BE(4)
      depth = body[8]
      type = body[9]
      interlace = body[12]
    } else if (kind === 'PLTE') palette = body
    else if (kind === 'tRNS') trns = body
    else if (kind === 'IDAT') idat.push(body)
    else if (kind === 'IEND') break
    at += 12 + len
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG: depth ${depth}, interlace ${interlace}`)
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type]
  if (!channels) throw new Error(`unsupported PNG colour type ${type}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const rows = new Uint8Array(h * stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = rows.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= channels ? prev[i - channels] : 0
      let v = src[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`)
      out[i] = v & 255
    }
  }
  const data = new Uint8Array(w * h * 4)
  for (let p = 0; p < w * h; p++) {
    const s = p * channels
    const o = p * 4
    if (type === 6) data.set(rows.subarray(s, s + 4), o)
    else if (type === 2) {
      data.set(rows.subarray(s, s + 3), o)
      data[o + 3] = 255
    } else if (type === 0 || type === 4) {
      data[o] = data[o + 1] = data[o + 2] = rows[s]
      data[o + 3] = type === 4 ? rows[s + 1] : 255
    } else {
      const i = rows[s]
      data[o] = palette![i * 3]
      data[o + 1] = palette![i * 3 + 1]
      data[o + 2] = palette![i * 3 + 2]
      data[o + 3] = trns && i < trns.length ? trns[i] : 255
    }
  }
  return { w, h, data }
}

export const readPng = (path: string): DecodedPng => decodePng(readFileSync(path))
