<script lang="ts" module>
  import type { Plan } from './lab-view'

  /** A render drawn in the lab: its image, where it lies, and which panels it has (a diff: A, B, changed). */
  export interface Drawn {
    key: string
    plan: Plan
    bitmap: ImageBitmap
    panels: 1 | 3
    /** Image pixels of one panel. */
    panelW: number
    panelH: number
    at: number
  }
</script>

<script lang="ts">
  import { placement, tileAt, zoomAround, type Camera } from './lab-view'

  // One map pane of the world lab (WorldLab.svelte): draws the renders it
  // has under the camera, crisp, coarsest first, with the chunk grid, the
  // hero and the picked tile; drag or pinch to pan and zoom, tap a tile.
  let {
    drawn,
    panel,
    camera,
    chunkSize,
    hero,
    picked,
    label,
    busy,
    onCamera,
    onTap
  }: {
    drawn: Drawn[]
    /** Which panel of a diff this pane shows (0 for a plain render). */
    panel: 0 | 1 | 2
    camera: Camera
    chunkSize: number
    hero: { tx: number; ty: number } | null
    picked: { tx: number; ty: number } | null
    label: string
    busy: string | null
    onCamera: (c: Camera) => void
    onTap: (tx: number, ty: number, panel: 0 | 1 | 2) => void
  } = $props()

  let canvas = $state<HTMLCanvasElement | null>(null)
  let w = $state(0)
  let h = $state(0)
  let hover = $state<{ tx: number; ty: number } | null>(null)

  const order = { atlas: 0, region: 1, chunk: 2 } as const

  function draw(): void {
    const c = canvas
    if (!c || !w || !h) return
    const dpr = window.devicePixelRatio || 1
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr)
      c.height = Math.round(h * dpr)
    }
    const g = c.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.imageSmoothingEnabled = false
    g.fillStyle = '#16141c'
    g.fillRect(0, 0, w, h)
    const z = camera.zoom
    const sx = (wx: number) => (wx - camera.x) * z + w / 2
    const sy = (wy: number) => (wy - camera.y) * z + h / 2
    const list = [...drawn].sort((a, b) => order[a.plan.view] - order[b.plan.view] || a.at - b.at)
    for (const d of list) {
      if (panel > 0 && d.panels !== 3) continue
      const p = placement(d.plan, chunkSize)
      // A diff's panels: A at 0, B after a 2 px gap, the change mask after another.
      const ox = d.panels === 3 ? panel * (d.panelW + 2) : 0
      g.drawImage(d.bitmap, ox, 0, d.panelW, d.panelH, sx(p.x), sy(p.y), p.w * z, p.h * z)
    }
    // The chunk grid, once chunks are big enough to read.
    const cpx = chunkSize * z
    if (cpx >= 24) {
      g.strokeStyle = 'rgba(255, 243, 194, 0.18)'
      g.lineWidth = 1
      g.beginPath()
      const x0 = Math.floor((camera.x - w / 2 / z) / chunkSize)
      const x1 = Math.ceil((camera.x + w / 2 / z) / chunkSize)
      const y0 = Math.floor((camera.y - h / 2 / z) / chunkSize)
      const y1 = Math.ceil((camera.y + h / 2 / z) / chunkSize)
      for (let cx = x0; cx <= x1; cx++) {
        const x = Math.round(sx(cx * chunkSize)) + 0.5
        g.moveTo(x, 0)
        g.lineTo(x, h)
      }
      for (let cy = y0; cy <= y1; cy++) {
        const y = Math.round(sy(cy * chunkSize)) + 0.5
        g.moveTo(0, y)
        g.lineTo(w, y)
      }
      g.stroke()
    }
    if (picked) {
      const s = Math.max(z, 6)
      g.strokeStyle = '#ffd24a'
      g.lineWidth = 2
      g.strokeRect(sx(picked.tx + 0.5) - s / 2 - 1, sy(picked.ty + 0.5) - s / 2 - 1, s + 2, s + 2)
    }
    if (hero) {
      const x = sx(hero.tx + 0.5)
      const y = sy(hero.ty + 0.5)
      g.fillStyle = '#ffd24a'
      g.strokeStyle = '#241f31'
      g.lineWidth = 2
      g.beginPath()
      g.arc(x, y, Math.max(4, Math.min(9, z / 2)), 0, Math.PI * 2)
      g.fill()
      g.stroke()
    }
  }

  let frame = 0
  $effect(() => {
    // Everything draw reads.
    void [drawn, camera, w, h, picked, hero, panel, canvas]
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  })

  // Pointers: one drags, two pinch; a press that barely moves is a tap.
  const pointers = new Map<number, { x: number; y: number }>()
  let moved = 0
  let pinch: { d: number; cam: Camera; mx: number; my: number } | null = null

  const local = (e: PointerEvent | WheelEvent) => {
    const r = canvas!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function down(e: PointerEvent): void {
    canvas?.setPointerCapture(e.pointerId)
    pointers.set(e.pointerId, local(e))
    if (pointers.size === 1) moved = 0
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cam: camera, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
    }
  }

  function move(e: PointerEvent): void {
    const p = local(e)
    hover = tileAt(camera, { w, h }, p.x, p.y)
    const last = pointers.get(e.pointerId)
    if (!last) return
    pointers.set(e.pointerId, p)
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1
      moved += 10
      onCamera(zoomAround(pinch.cam, { w, h }, pinch.mx, pinch.my, d / pinch.d))
      return
    }
    const dx = p.x - last.x
    const dy = p.y - last.y
    moved += Math.abs(dx) + Math.abs(dy)
    onCamera({ ...camera, x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom })
  }

  function up(e: PointerEvent): void {
    const p = pointers.get(e.pointerId)
    pointers.delete(e.pointerId)
    if (pointers.size < 2) pinch = null
    if (p && pointers.size === 0 && moved < 6 && e.type === 'pointerup') {
      const t = tileAt(camera, { w, h }, p.x, p.y)
      onTap(t.tx, t.ty, panel)
    }
  }

  function wheel(e: WheelEvent): void {
    e.preventDefault()
    const p = local(e)
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015))
    onCamera(zoomAround(camera, { w, h }, p.x, p.y, factor))
  }

  // Not passive: the wheel zooms the map, never the page.
  $effect(() => {
    const c = canvas
    if (!c) return
    c.addEventListener('wheel', wheel, { passive: false })
    return () => c.removeEventListener('wheel', wheel)
  })

  function key(e: KeyboardEvent): void {
    const step = 80 / camera.zoom
    const moves: Record<string, () => Camera> = {
      ArrowLeft: () => ({ ...camera, x: camera.x - step }),
      ArrowRight: () => ({ ...camera, x: camera.x + step }),
      ArrowUp: () => ({ ...camera, y: camera.y - step }),
      ArrowDown: () => ({ ...camera, y: camera.y + step }),
      '+': () => zoomAround(camera, { w, h }, w / 2, h / 2, 1.5),
      '=': () => zoomAround(camera, { w, h }, w / 2, h / 2, 1.5),
      '-': () => zoomAround(camera, { w, h }, w / 2, h / 2, 1 / 1.5)
    }
    const m = moves[e.key]
    if (m) {
      e.preventDefault()
      onCamera(m())
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onTap(Math.floor(camera.x), Math.floor(camera.y), panel)
    }
  }
</script>

<div class="pane" bind:clientWidth={w} bind:clientHeight={h}>
  <canvas
    bind:this={canvas}
    tabindex="0"
    aria-label={`${label}: drag to pan, wheel or pinch to zoom, tap a tile to inspect it; arrows and + or − from the keyboard, Enter inspects the middle`}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    onpointerleave={() => (hover = null)}
    onkeydown={key}
  ></canvas>
  <span class="tag">{label}</span>
  {#if busy}<span class="busy" role="status">{busy}</span>{/if}
  {#if hover}<span class="where">tile {hover.tx}, {hover.ty} · chunk {Math.floor(hover.tx / chunkSize)}, {Math.floor(hover.ty / chunkSize)}</span>{/if}
</div>

<style>
  .pane {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: #16141c;
    border-radius: 8px;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    touch-action: none;
    cursor: grab;
    display: block;
  }
  canvas:active {
    cursor: grabbing;
  }
  canvas:focus-visible {
    outline: 3px solid var(--gold);
    outline-offset: -3px;
  }
  .tag,
  .busy,
  .where {
    position: absolute;
    padding: 2px 8px;
    border-radius: 6px;
    background: rgba(22, 20, 28, 0.78);
    color: var(--cream-hi);
    font-size: 12px;
    pointer-events: none;
  }
  .tag {
    max-width: calc(100% - 90px);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    top: 6px;
    left: 6px;
    font-family: var(--font-display);
  }
  .busy {
    top: 6px;
    right: 6px;
    color: var(--gold);
  }
  .where {
    bottom: 6px;
    left: 6px;
    font-variant-numeric: tabular-nums;
  }
</style>
