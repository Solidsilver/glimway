/** A scripted town walk follows open tiles, including the garden's rail gap. */
export function townPath(from: { tx: number; ty: number }, to: { tx: number; ty: number }, solid: (tx: number, ty: number) => boolean): { tx: number; ty: number }[] | null {
  const key = (t: { tx: number; ty: number }) => `${t.tx},${t.ty}`
  if (solid(to.tx, to.ty)) return null
  const queue = [from], previous = new Map<string, { tx: number; ty: number } | null>([[key(from), null]])
  for (let i = 0; i < queue.length && i < 72 * 72; i++) {
    const t = queue[i]!
    if (key(t) === key(to)) {
      const path = [t]
      let p = previous.get(key(t))
      while (p) { path.push(p); p = previous.get(key(p)) }
      return path.reverse().slice(1)
    }
    for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      const n = { tx: t.tx + dx!, ty: t.ty + dy! }
      if (Math.abs(n.tx - from.tx) > 72 || Math.abs(n.ty - from.ty) > 72 || previous.has(key(n)) || solid(n.tx, n.ty)) continue
      previous.set(key(n), t); queue.push(n)
    }
  }
  return null
}
