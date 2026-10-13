<script lang="ts">
  import { expose } from '../game/dev-hooks'
  import type { Session } from '../game/session'
  import { bus, EV } from '../game/events'
  import { loadMap, type MapLoad } from '../game/wilds/map-data'
  import { CHUNK_TILES, isWildsArea } from '../game/wilds/coords'
  import { heroPosition } from '../game/map-position'
  import { gameNow } from '../game/clock'
  import { gateTile, MAP_COLOURS } from '../lib/wilds/map-model'
  import {
    MAP_PAN_FAR_PX,
    MAP_PAN_PX,
    WheelZoom,
    centreOn,
    pinchWheelScale,
    zoomAbout,
    clampView,
    openingScale,
    panBy,
    pinchView,
    showAll,
    snapView,
    toScreen,
    zoomPercent,
    zoomSteps,
    type MapView,
    type Pinch
  } from '../lib/wilds/map-view'
  import { MapRenderer, backingSize, canvasImage } from './map-renderer'
  import { foundByText, placeName } from '../lib/wilds/paths'
  import { MAP_LABELS } from '../content/open-map'
  import { focusTrap } from './focus'
  import { ui } from './store.svelte'
  import Icon from './Icon.svelte'

  /**
   * The world map (docs/design/world-map.md): the Wilds you've walked this
   * wick, full screen, to zoom and drag. App owns it as a panel (M, the HUD's
   * Map button, Escape), so it blocks the world as every panel does.
   *
   * The view (a centre in tiles and a scale) is the map's own; only its
   * scale outlives a closing, in App (`scale`/`onScale`). Each opening
   * centres on you, or on the Commons gate when you're not out there.
   * Terrain is drawn by src/ui/map-renderer.ts into a viewport-sized canvas;
   * you and the labels are DOM over it, so you moving never redraws land.
   * Zooming and dragging never read anything: only the Wilds changing does,
   * at most twice a second.
   */
  let { session, scale = null, onScale, onClose }: { session: Session; scale?: number | null; onScale: (scale: number) => void; onClose: () => void } = $props()

  const renderer = new MapRenderer(canvasImage)

  let result = $state<MapLoad | null>(null)
  let loading = $state(true)
  /** Bumps when new input reached the renderer (a redraw is due). */
  let inputVersion = $state(0)
  let view = $state<MapView | null>(null)
  let vp = $state({ w: 0, h: 0 })
  let dpr = $state(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
  let detailsOpen = $state(false)
  let status = $state('')
  let viewportEl = $state<HTMLDivElement | null>(null)
  let canvas = $state<HTMLCanvasElement | null>(null)
  /** Map loads and terrain draws (playtests read them through the dev hook). */
  let loads = 0
  let draws = 0

  // ---------------------------------------------------------------- where you are

  type Pos = { area: string; world: string; x: number; y: number }
  /** The scene's live position when it's the session's own area and world, else the save's (src/game/map-position.ts). */
  function samplePosition(): Pos | null {
    const p = heroPosition({ area: String(session.state.area), position: session.state.position }, session.link?.worldId ?? '')
    return p ? { ...p } : null
  }
  let pos = $state<Pos | null>(samplePosition())
  $effect(() => {
    // Up to ten times a second while open; a repaint only when it moved.
    const t = setInterval(() => {
      const p = samplePosition()
      if (p?.area !== pos?.area || p?.world !== pos?.world || p?.x !== pos?.x || p?.y !== pos?.y) pos = p
    }, 100)
    return () => clearInterval(t)
  })
  /** You on the map (fractional tiles), only out in the Wilds of this world. */
  const hero = $derived(pos && isWildsArea(pos.area) && pos.world === (session.link?.worldId ?? '') ? { x: pos.x / 16, y: pos.y / 16 } : null)
  const outside = $derived(!hero)

  // ---------------------------------------------------------------- loading

  /** An opening's generation: a slow load never lands on a newer one, nor after closing. */
  let generation = 0
  let alive = true
  let inFlight = false
  let again = false
  /** Loads by the order they began: one that began earlier never replaces a later one's picture. */
  let started = 0
  let shown = 0
  let expiring = false

  /**
   * Load the map's land. One read at a time, with one more after it when
   * news came meanwhile. `read: false` (the wick running out) skips the
   * network, so it runs at once, beside a load already waiting on a read.
   */
  async function load(opts: { read?: boolean } = {}): Promise<void> {
    const quick = opts.read === false
    if (!quick) {
      if (inFlight) {
        again = true
        return
      }
      inFlight = true
    }
    const gen = generation
    const n = ++started
    try {
      loads++
      const got = await loadMap(session, opts)
      if (!alive || gen !== generation || n < shown) return
      // Another world or wick came while it loaded: none of it is current, and the newer one loads next.
      if (got.superseded) {
        again = true
        return
      }
      // Begun before the wick ran out: it can't speak for after.
      if (!got.ended && got.endsAt !== null && gameNow() >= got.endsAt) {
        void expire()
        return
      }
      shown = n
      result = got
      if (got.input) {
        renderer.setInput(got.input, got.scope)
        inputVersion++
      }
    } catch {
      // Keep the last picture; say so.
      if (alive) status = MAP_LABELS.partial
    } finally {
      if (!quick) inFlight = false
      if (alive && !quick) loading = false
      if (alive && again && !inFlight) {
        again = false
        void load()
      }
    }
  }

  /** The wick has run out (game clock): only the Tangle at once, whatever the network; then a read for the new wick. */
  async function expire(): Promise<void> {
    if (expiring) return
    expiring = true
    try {
      await load({ read: false })
    } finally {
      expiring = false
    }
    if (alive) void load()
  }

  $effect(() => {
    alive = true
    generation++
    void load()
    // The Wilds moved (a read, a path, a find): load again, at most twice a second.
    let queued: ReturnType<typeof setTimeout> | null = null
    const soon = () => {
      if (queued) return
      queued = setTimeout(() => {
        queued = null
        void load()
      }, 500)
    }
    bus.on(EV.wilds, soon)
    // The wick's end, on the game clock, checked each second while open.
    const clock = setInterval(() => {
      const r = result
      if (r?.input && !r.ended && r.endsAt !== null && gameNow() >= r.endsAt) void expire()
    }, 1000)
    return () => {
      alive = false
      generation++
      bus.off(EV.wilds, soon)
      clearInterval(clock)
      if (queued) clearTimeout(queued)
    }
  })

  // The connection, as it is now: the note follows it, and either way it changes the map loads again.
  const online = $derived(ui.link?.status === 'online')
  let wasOnline: boolean | null = null
  $effect(() => {
    const now = online
    if (wasOnline !== null && now !== wasOnline) void load()
    wasOnline = now
  })

  // ---------------------------------------------------------------- the view

  const frame = $derived.by(() => {
    void inputVersion
    return renderer.frame()
  })

  /** Where an opening (or "centre") looks: you, else the Commons gate. */
  function home(): { x: number; y: number } {
    if (hero) return hero
    const g = gateTile()
    return g ? { x: g.tx + 0.5, y: g.ty + 0.5 } : { x: 0, y: 0 }
  }

  /** The scale this viewport opens at (two chunks on its shorter side): the zoom readout's 100%. */
  const openScale = $derived(openingScale(vp, CHUNK_TILES))

  // First the opening view, then the clamp whenever the frame or the viewport changes (the centre stays in world tiles).
  $effect(() => {
    const f = frame
    if (!f || vp.w <= 0 || vp.h <= 0) return
    const v = view
    if (!v) {
      const at = home()
      view = centreOn(at.x, at.y, scale ?? openScale, vp, f)
      return
    }
    const c = clampView(v, vp, f)
    if (c.cx !== v.cx || c.cy !== v.cy || c.scale !== v.scale) view = c
  })

  // The chosen scale outlives this opening (App keeps it for the session).
  $effect(() => {
    if (view) onScale(view.scale)
  })

  // ---------------------------------------------------------------- drawing

  let raf = 0
  $effect(() => {
    // What a terrain draw depends on; the dot and labels are DOM and don't come here.
    const v = view
    const size = vp
    const ratio = dpr
    void inputVersion
    const c = canvas
    if (!v || !c || size.w <= 0) return
    if (raf) cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      raf = 0
      const b = backingSize(size, ratio)
      if (c.width !== b.w) c.width = b.w
      if (c.height !== b.h) c.height = b.h
      const ctx = c.getContext('2d')
      if (!ctx) return
      renderer.draw(ctx, v, size, ratio)
      draws++
    })
  })
  $effect(() => () => {
    if (raf) cancelAnimationFrame(raf)
  })

  $effect(() => {
    const el = viewportEl
    if (!el) return
    const ro = new ResizeObserver(() => {
      vp = { w: el.clientWidth, h: el.clientHeight }
      dpr = window.devicePixelRatio || 1
    })
    ro.observe(el)
    vp = { w: el.clientWidth, h: el.clientHeight }
    return () => ro.disconnect()
  })

  const youAt = $derived(view && hero ? toScreen(view, vp, hero.x, hero.y) : null)
  const labels = $derived.by(() => {
    void inputVersion
    return view && vp.w > 0 ? renderer.labels(view, vp, hero ? { ...hero, text: MAP_LABELS.you } : null) : []
  })

  // ---------------------------------------------------------------- actions

  function say(text: string): void {
    status = text
  }
  function zoom(steps: number): void {
    if (!view || !frame) return
    view = zoomSteps(view, vp, frame, steps)
    say(MAP_LABELS.zoom.replace('{pct}', String(zoomPercent(view.scale, openScale))))
  }
  function centreOnMe(): void {
    if (!view || !frame || !hero) return
    view = centreOn(hero.x, hero.y, view.scale, vp, frame)
    say(MAP_LABELS.centred)
  }
  function toGate(): void {
    const g = gateTile()
    if (!view || !frame || !g) return
    view = centreOn(g.tx + 0.5, g.ty + 0.5, view.scale, vp, frame)
    say(MAP_LABELS.atGate)
  }
  function all(): void {
    if (!frame || vp.w <= 0) return
    view = showAll(vp, frame)
    say(MAP_LABELS.shownAll)
  }

  // ---------------------------------------------------------------- gestures

  /** Pointers down on the map, where they are now. */
  const pointers = new Map<number, { x: number; y: number }>()
  let drag: { view: MapView; x: number; y: number; moved: boolean } | null = null
  let pinch: Pinch | null = null
  const DRAG_THRESHOLD = 4

  function local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = viewportEl!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function onPointerDown(e: PointerEvent): void {
    if (!view || !frame) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    try {
      viewportEl?.setPointerCapture?.(e.pointerId)
    } catch {
      // A pointer the browser no longer tracks: the gesture still works while it's over the map.
    }
    pointers.set(e.pointerId, local(e))
    rebase()
  }

  /** Start the gesture again from where the pointers are now (a finger added or lifted: no jump). */
  function rebase(): void {
    if (!view) return
    const p = [...pointers.values()]
    if (p.length >= 2) {
      drag = null
      pinch = { view, a: p[0]!, b: p[1]! }
    } else if (p.length === 1) {
      pinch = null
      drag = { view, x: p[0]!.x, y: p[0]!.y, moved: drag?.moved ?? false }
    } else {
      pinch = null
      drag = null
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (!pointers.has(e.pointerId) || !frame) return
    pointers.set(e.pointerId, local(e))
    const p = [...pointers.values()]
    if (pinch && p.length >= 2) {
      view = pinchView(pinch, p[0]!, p[1]!, vp, frame)
    } else if (drag && p.length === 1) {
      const dx = p[0]!.x - drag.x
      const dy = p[0]!.y - drag.y
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      drag.moved = true
      view = panBy(drag.view, vp, frame, dx, dy)
    }
  }

  function onPointerEnd(e: PointerEvent): void {
    if (!pointers.delete(e.pointerId)) return
    rebase()
    // The gesture's over: settle on whole device pixels.
    if (pointers.size === 0 && view) view = snapView(view, vp, dpr)
  }

  // The wheel: non-passive, so it can keep the page from scrolling or zooming. Over the map, a trackpad
  // pinch (a Ctrl/⌘ wheel) zooms the map smoothly about the pointer; anywhere else it stays the browser's.
  const wheel = new WheelZoom()
  $effect(() => {
    const el = viewportEl
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!view || !frame) return
      if (e.ctrlKey || e.metaKey) {
        const at = local(e)
        view = zoomAbout(view, vp, frame, pinchWheelScale(view.scale, e.deltaY, e.deltaMode, vp.h), at.x, at.y)
        return
      }
      const steps = wheel.steps(e.deltaY, e.deltaMode, vp.h, performance.now())
      if (!steps) return
      const at = local(e)
      view = zoomSteps(view, vp, frame, steps, at.x, at.y)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  /** Keys on the focused map (M and Escape are App's). */
  function onViewportKey(e: KeyboardEvent): void {
    if (!view || !frame || e.ctrlKey || e.metaKey || e.altKey) return
    const step = e.shiftKey ? MAP_PAN_FAR_PX : MAP_PAN_PX
    const pans: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      KeyA: [step, 0],
      ArrowRight: [-step, 0],
      KeyD: [-step, 0],
      ArrowUp: [0, step],
      KeyW: [0, step],
      ArrowDown: [0, -step],
      KeyS: [0, -step]
    }
    const pan = pans[e.code]
    if (pan) view = panBy(view, vp, frame, pan[0], pan[1])
    else if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '+') zoom(1)
    else if (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.key === '-') zoom(-1)
    else if (e.code === 'Home') hero ? centreOnMe() : toGate()
    else if (e.code === 'End') all()
    else return
    e.preventDefault()
    // The world mustn't act on it too (src/ui/layers.ts: a panel blocks world input; this is belt and braces).
    ;(e as KeyboardEvent & { fsConsumed?: boolean }).fsConsumed = true
  }

  // ---------------------------------------------------------------- the lists

  const input = $derived(result?.input ?? null)
  const places = $derived((input?.places ?? []).filter((p) => p.seen || p.foundBy))
  const ways = $derived(input?.ways ?? [])
  /** A place by name for the list ("the camp glade", "the Tangle"). */
  const nameOf = (id: string) => placeName(id, input?.places.find((p) => p.id === id)?.kind ?? null)
  const notes = $derived.by(() => {
    const out: string[] = []
    if (!result?.input) return out
    if (result.ended) out.push(MAP_LABELS.ended)
    else if (session.link && !online) out.push(MAP_LABELS.offlineNow)
    if (result.partial) out.push(MAP_LABELS.partial)
    if (outside) out.push(MAP_LABELS.outside)
    // (After the wick's end only the Tangle shows: that isn't "you haven't walked".)
    else if (input && input.chunks.length <= 9 && !result.ended) out.push(MAP_LABELS.empty)
    return out
  })
  const summary = $derived(
    [MAP_LABELS.wick, ...notes, hero ? MAP_LABELS.onMap : ''].filter(Boolean).join(' ')
  )
  const css = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`

  // Playtests (src/game/dev-hooks.ts): the view, you, and how often it loaded and drew.
  $effect(() => {
    if (!import.meta.env.DEV) return
    return expose('__fsWorldMap', () => ({ view: view ? { ...view } : null, vp: { ...vp }, frame, hero, outside, loads, draws, cached: renderer.cached, stats: { ...renderer.stats }, result: result ? { scope: result.scope, missing: result.missing, offline: result.offline, partial: result.partial, ended: result.ended, endsAt: result.endsAt } : null, online, notes: [...notes], chunks: result?.input?.chunks.length ?? 0 }))
  })
</script>

<div class="world-map" role="dialog" aria-modal="true" aria-labelledby="world-map-title" data-testid="world-map" use:focusTrap={{ initial: '.viewport' }}>
  <header class="head">
    <h2 id="world-map-title"><Icon name="map" size={20} /> {MAP_LABELS.heading}</h2>
    <button type="button" class="close" onclick={onClose} aria-label={MAP_LABELS.close} data-testid="world-map-close"><Icon name="close" size={14} /></button>
  </header>

  <!-- The map's surface: focusable for its keys, with its gestures; a region, not an application (its lists are in Details). -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="viewport"
    bind:this={viewportEl}
    tabindex="0"
    role="region"
    aria-label={MAP_LABELS.title}
    aria-describedby="world-map-summary world-map-keys"
    data-testid="map-viewport"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerEnd}
    onpointercancel={onPointerEnd}
    onlostpointercapture={onPointerEnd}
    onkeydown={onViewportKey}
  >
    <div class="picture" role="img" aria-label={`${MAP_LABELS.title}. ${summary}`}>
      <canvas bind:this={canvas} data-testid="map-canvas"></canvas>
    </div>
    <div class="marks" aria-hidden="true">
      {#each labels as l, i (i)}
        <span class={`label ${l.kind}`} style={`left:${l.x}px;top:${l.y}px`} data-label={l.kind}>
          {l.text}{#if l.sub}<small>{foundByText(l.sub)}</small>{/if}
        </span>
      {/each}
      {#if youAt}
        <span class="dot" style={`left:${youAt.x}px;top:${youAt.y}px`} data-testid="map-you"></span>
      {/if}
    </div>
    {#if loading && !result}
      <p class="empty">{MAP_LABELS.loading}</p>
    {:else if result && !result.input}
      <div class="empty">
        <p>{result.missing === 'guest' ? MAP_LABELS.guest : MAP_LABELS.offline}</p>
        {#if result.missing === 'unread'}
          <button type="button" onclick={() => void load()} disabled={!online} data-testid="map-retry">{MAP_LABELS.retry}</button>
        {/if}
      </div>
    {/if}
    {#if notes.length}
      <div class="notes" data-testid="map-notes">
        {#each notes as n (n)}<p>{n}</p>{/each}
        {#if result?.ended}
          <button type="button" class="tiny" onclick={() => void load()} disabled={!online} data-testid="map-notes-retry">{MAP_LABELS.retry}</button>
        {/if}
      </div>
    {/if}
  </div>

  <div class="tools" role="group" aria-label="Map controls">
    <button type="button" onclick={() => zoom(1)} aria-label={MAP_LABELS.zoomIn} title={MAP_LABELS.zoomIn} data-testid="map-zoom-in">+</button>
    <span class="pct" aria-hidden="true">{view ? zoomPercent(view.scale, openScale) : 100}%</span>
    <button type="button" onclick={() => zoom(-1)} aria-label={MAP_LABELS.zoomOut} title={MAP_LABELS.zoomOut} data-testid="map-zoom-out">−</button>
    <button type="button" class="word" onclick={centreOnMe} disabled={!hero} title={hero ? MAP_LABELS.centre : MAP_LABELS.noCentre} aria-describedby={hero ? undefined : 'world-map-nocentre'} data-testid="map-centre">
      <Icon name="pin" size={16} /><span>{MAP_LABELS.centre}</span>
    </button>
    {#if !hero}<span class="sr" id="world-map-nocentre">{MAP_LABELS.noCentre}</span>{/if}
    <button type="button" class="word gate" onclick={toGate} data-testid="map-gate"><Icon name="home" size={16} /><span>{MAP_LABELS.gate}</span></button>
    <button type="button" class="word" onclick={all} data-testid="map-show-all"><Icon name="world" size={16} /><span>{MAP_LABELS.showAll}</span></button>
    <button type="button" class="word" onclick={() => (detailsOpen = !detailsOpen)} aria-expanded={detailsOpen} aria-controls="world-map-details" data-testid="map-details-toggle">
      <Icon name="scroll" size={16} /><span>{MAP_LABELS.details}</span>
    </button>
  </div>

  {#if detailsOpen}
    <aside class="details" id="world-map-details" aria-label={MAP_LABELS.details} data-testid="map-details">
      <!-- Phones: the gate's button lives here, out of the toolbar row. -->
      <button type="button" class="gate-inline" onclick={toGate}>{MAP_LABELS.gate}</button>
      <p class="fine">{MAP_LABELS.wick}</p>
      <h3>{MAP_LABELS.ways}</h3>
      {#if ways.length}
        <ul data-testid="map-ways">
          {#each ways as w (w.id)}
            <li><span class="swatch way" aria-hidden="true"></span>{w.name} <span class="fine">· {MAP_LABELS.between.replace('{from}', nameOf(w.a)).replace('{to}', nameOf(w.b))}</span></li>
          {/each}
        </ul>
      {:else}
        <p class="fine">{MAP_LABELS.noWays}</p>
      {/if}
      <h3>{MAP_LABELS.places}</h3>
      {#if places.length}
        <ul data-testid="map-places">
          {#each places as p (p.id)}
            <li data-place={p.id}>
              <span class={`swatch ${p.foundBy ? 'found' : 'seen'}`} aria-hidden="true"></span>
              {placeName(p.id, p.kind).replace(/^the /, 'The ')}
              <span class="fine">· {p.foundBy ? foundByText(p.foundBy) : MAP_LABELS.notFound}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="fine">{MAP_LABELS.seen}: {MAP_LABELS.noPlaces}</p>
      {/if}
      <h3>{MAP_LABELS.legend}</h3>
      <ul class="legend">
        <li><span class="swatch" style={`background:#86a35e`} aria-hidden="true"></span>{MAP_LABELS.legendWalked}</li>
        <li><span class="swatch" style={`background:${css(MAP_COLOURS.parchment)}`} aria-hidden="true"></span>{MAP_LABELS.legendBlank}</li>
        <li><span class="swatch" style={`background:#dfe0c2`} aria-hidden="true"></span>{MAP_LABELS.legendBeyond}</li>
        <li><span class="swatch dash" aria-hidden="true"></span>{MAP_LABELS.frontier}</li>
        <li><span class="swatch way" aria-hidden="true"></span>{MAP_LABELS.ways}</li>
        <li><span class="swatch found" aria-hidden="true"></span>{MAP_LABELS.foundByLegend}</li>
        <li><span class="swatch seen" aria-hidden="true"></span>{MAP_LABELS.seen}</li>
        <li><span class="swatch you" aria-hidden="true"></span>{MAP_LABELS.you}</li>
      </ul>
    </aside>
  {/if}

  <p class="sr" id="world-map-summary">{summary}</p>
  <p class="sr" id="world-map-keys">{MAP_LABELS.keys}</p>
  <p class="sr" role="status" aria-live="polite" data-testid="map-status">{loading && !result ? MAP_LABELS.loading : status}</p>
</div>

<style>
  /* Full screen: the whole viewport, its safe areas kept clear. Not a sheet: nothing here drags it shut. */
  .world-map {
    position: fixed;
    inset: 0;
    z-index: 40;
    height: 100dvh;
    box-sizing: border-box;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-rows: auto auto minmax(0, 1fr);
    grid-template-areas: 'head head' 'tools tools' 'map details';
    row-gap: 8px;
    padding: max(10px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) max(10px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left));
    color: var(--text);
    background:
      radial-gradient(120% 80% at 50% 0%, rgba(255, 252, 240, 0.7) 0%, rgba(255, 252, 240, 0) 60%),
      linear-gradient(180deg, var(--paper-hi) 0%, var(--paper) 100%);
    animation: map-in 140ms ease-out;
  }
  .world-map:focus {
    outline: none;
  }
  @keyframes map-in {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .world-map {
      animation: none;
    }
  }
  .head {
    grid-area: head;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h2 {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 20px;
    letter-spacing: 0.04em;
    color: var(--wood-dark);
  }
  .close {
    flex: none;
    width: 44px;
    height: 44px;
    padding: 0;
    display: grid;
    place-items: center;
    border-radius: 12px;
  }
  .tools {
    grid-area: tools;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .tools button {
    min-width: 44px;
    min-height: 44px;
    padding: 4px 10px;
    font-size: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .tools button.word {
    font-size: 14px;
  }
  .pct {
    min-width: 46px;
    text-align: center;
    font-family: var(--font-display);
    font-size: 13px;
    color: var(--text-soft);
  }
  .viewport {
    grid-area: map;
    position: relative;
    min-height: 0;
    overflow: hidden;
    border: 3px solid var(--wood-dark);
    border-radius: 12px;
    background: #efe3bf;
    box-shadow: inset 0 0 0 2px rgba(255, 249, 230, 0.8);
    /* Only the map takes the gestures; the lists and the page keep theirs. */
    touch-action: none;
    overscroll-behavior: contain;
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
  }
  .viewport:active {
    cursor: grabbing;
  }
  .viewport:focus-visible {
    outline: 3px solid var(--gold);
    outline-offset: 2px;
  }
  .picture,
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    image-rendering: pixelated;
  }
  .marks {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .label {
    position: absolute;
    transform: translate(-50%, calc(-100% - 2px));
    padding: 1px 4px;
    border-radius: 4px;
    font-family: var(--font-display);
    font-size: 11px;
    line-height: 1.15;
    color: var(--wood-dark);
    background: rgba(255, 249, 230, 0.85);
    white-space: nowrap;
    text-align: center;
  }
  .label small {
    display: block;
    font-size: 10px;
    color: #5a3a86;
  }
  .label.footprint {
    transform: translate(-50%, -50%);
    background: rgba(255, 249, 230, 0.6);
  }
  .label.you {
    transform: translate(-50%, 8px);
    color: #fff;
    background: #c4523a;
  }
  .label.way {
    background: rgba(255, 236, 190, 0.92);
    color: #7a4c10;
  }
  /* You: a dot of your own, over the labels' layer (the label "You" sits under it). */
  .dot {
    position: absolute;
    width: 12px;
    height: 12px;
    margin: -6px 0 0 -6px;
    border-radius: 50%;
    background: #c4523a;
    border: 2px solid #fff7e0;
    box-shadow: 0 0 0 1px #4a3220;
    box-sizing: border-box;
  }
  .empty {
    position: absolute;
    inset: 0;
    margin: 0;
    display: grid;
    place-content: center;
    gap: 10px;
    padding: 16px;
    text-align: center;
    font-size: 14px;
    color: var(--text-soft);
  }
  .empty p {
    margin: 0;
    max-width: 36ch;
  }
  .notes {
    position: absolute;
    left: 8px;
    bottom: 8px;
    right: 8px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    pointer-events: none;
  }
  .notes p {
    margin: 0;
    padding: 4px 9px;
    border-radius: 8px;
    border: 2px solid var(--paper-line);
    background: rgba(251, 241, 218, 0.94);
    font-size: 12.5px;
    color: var(--wood-dark);
  }
  .notes button {
    pointer-events: auto;
  }
  .details {
    grid-area: details;
    width: clamp(220px, 28vw, 300px);
    margin-left: 8px;
    box-sizing: border-box;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 10px 12px;
    border: 3px solid var(--wood-dark);
    border-radius: 12px;
    background: var(--paper-hi);
    user-select: text;
    -webkit-user-select: text;
  }
  .details h3 {
    margin: 10px 0 4px;
    font-family: var(--font-display);
    font-size: 14px;
    color: var(--wood-dark);
  }
  .details ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 4px;
    font-size: 13px;
  }
  .details li {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .fine {
    margin: 0;
    font-size: 12px;
    color: var(--text-soft);
  }
  .gate-inline {
    display: none;
    min-height: 44px;
    width: 100%;
    margin-bottom: 6px;
  }
  .swatch {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 3px;
    border: 1px solid var(--wood-dark);
  }
  .swatch.way {
    background: #e3a53a;
  }
  .swatch.found {
    background: #7a4bb0;
  }
  .swatch.seen {
    background: #3a2e22;
  }
  .swatch.you {
    background: #c4523a;
    border-radius: 50%;
  }
  .swatch.dash {
    background: repeating-linear-gradient(90deg, #8a7b9c 0 3px, transparent 3px 6px);
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* Phones and narrow windows: icon-only tools in their own row, the details under the map. */
  @media (max-width: 640px) {
    .world-map {
      row-gap: 6px;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      grid-template-areas: 'head' 'tools' 'map' 'details';
    }
    .details {
      width: auto;
      max-height: 42dvh;
      margin-left: 0;
    }
    h2 {
      font-size: 17px;
    }
    .tools {
      gap: 4px;
    }
    .tools button.word span {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .tools button.gate {
      display: none;
    }
    .gate-inline {
      display: block;
    }
    .tools button {
      padding: 4px 8px;
    }
    .pct {
      min-width: 40px;
    }
  }
  /* Short landscape phones: the title and the icon-only tools share the top row; details beside the map, not under it. */
  @media (max-height: 480px) and (orientation: landscape) {
    .world-map {
      row-gap: 6px;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-rows: auto minmax(0, 1fr);
      grid-template-areas: 'head tools' 'map details';
    }
    h2 {
      font-size: 16px;
    }
    .tools {
      flex-wrap: nowrap;
      gap: 4px;
      margin-left: 8px;
    }
    .tools button {
      padding: 4px 8px;
    }
    .tools button.word span {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .details {
      width: min(300px, 40vw);
      max-height: none;
      margin-left: 8px;
    }
  }
</style>
