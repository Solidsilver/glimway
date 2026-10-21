<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../../../game/session'
  import { TILE } from '../../../lib/tile'
  import { isWildsArea } from '../../../game/wilds/coords'
  import { canDevWarp, devWarpTo } from '../../../game/dev-warp'
  import Icon from '../../Icon.svelte'
  import LabPane, { type Drawn } from './LabPane.svelte'
  import LabRules from './LabRules.svelte'
  import { labRender, labState, labTile, renderBody, type Comparison, type LabState, type Stats, type TileInfo, type Version } from './lab-api'
  import { clampZoom, covers, percent, plan, ranked, VIEW_ZOOM, viewOf, visibleChunks, zoomAround, type Camera, type LabMode, type LabView } from './lab-view'

  // The world lab (dev builds only; the dev panel opens it): the Wilds
  // generator from any seed, at three scales, with overlays, stats, tile
  // inspection, a side-by-side diff (two seeds, or the server's rules
  // against an edited copy), and "go here". Renders run on the dev
  // server in worker processes (server/internal/worldlab); the page keeps
  // its view and the edited rules in this browser.
  let { session, onClose }: { session: Session; onClose: () => void } = $props()

  const VIEW_KEY = 'glimway.worldlab.view'
  const RULES_KEY = 'glimway.worldlab.rules'

  type Saved = { seed?: string; epoch?: string; overlays?: string[]; field?: string; mode?: LabMode; camera?: Camera; rulesA?: 'server' | 'edited'; compare?: boolean; bSeed?: string; rulesB?: 'server' | 'edited' }
  const saved: Saved = read(VIEW_KEY) ?? {}
  const savedRules: { text: string; base: string } | null = read(RULES_KEY)

  function read<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : null
    } catch {
      return null
    }
  }

  let st = $state<LabState | null>(null)
  let failed = $state<string | null>(null)

  const heroTile = (): { tx: number; ty: number } | null => {
    const s = session.state
    return isWildsArea(s.area) ? { tx: Math.floor(s.position.x / TILE), ty: Math.floor(s.position.y / TILE) } : null
  }
  const hero = $state(heroTile())

  let seed = $state(saved.seed ?? '')
  let epoch = $state(saved.epoch ?? '')
  let overlays = $state<string[]>(saved.overlays ?? [])
  let field = $state<string>(saved.field ?? '')
  let mode = $state<LabMode>(saved.mode ?? 'auto')
  let camera = $state<Camera>(saved.camera ?? { x: hero?.tx ?? 0, y: hero?.ty ?? 0, zoom: VIEW_ZOOM.atlas })
  let rulesA = $state<'server' | 'edited'>(saved.rulesA ?? 'server')
  let compare = $state(saved.compare ?? false)
  let bSeed = $state(saved.bSeed ?? '')
  let rulesB = $state<'server' | 'edited'>(saved.rulesB ?? 'edited')
  let edited = $state(savedRules?.text ?? '')
  let rulesProblem = $state<string | null>(null)

  let tab = $state<'view' | 'stats' | 'tile' | 'rules'>('view')
  let width = $state(0)
  let mapsW = $state(0)
  let mapsH = $state(0)
  /** On a narrow screen a diff shows one panel at a time. */
  let onePanel = $state<0 | 1 | 2>(0)

  let drawn = $state.raw<Drawn[]>([])
  let stats = $state<Stats | null>(null)
  let comparison = $state<Comparison | null>(null)
  let renderError = $state<string | null>(null)
  let busySince = $state<number | null>(null)
  let busyView = $state<LabView>('atlas')
  let now = $state(Date.now())
  let lastCached = $state(false)

  let picked = $state<{ tx: number; ty: number; panel: 0 | 1 | 2 } | null>(null)
  let tile = $state<TileInfo | null>(null)
  let tileVersion = $state<Version | null>(null)
  let tileError = $state<string | null>(null)
  let message = $state<string | null>(null)

  let root = $state<HTMLDivElement | null>(null)

  onMount(() => {
    root?.focus()
    void labState().then((a) => {
      if (!a.ok) {
        failed = a.text
        return
      }
      st = a.value
      if (!seed) seed = a.value.seed
      if (!epoch) epoch = a.value.epoch
      if (!edited) edited = a.value.rules
    })
    const tick = setInterval(() => (now = Date.now()), 200)
    return () => {
      clearInterval(tick)
      for (const d of drawn) d.bitmap.close()
    }
  })

  // Keep the view and the edits for the next opening.
  $effect(() => {
    const v: Saved = { seed, epoch, overlays, field, mode, camera, rulesA, compare, bSeed, rulesB }
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(v))
    } catch {
      // Private mode: nothing kept.
    }
  })
  $effect(() => {
    if (!st) return
    try {
      if (edited === st.rules) localStorage.removeItem(RULES_KEY)
      else localStorage.setItem(RULES_KEY, JSON.stringify({ text: edited, base: savedRules?.base ?? st.rulesSHA256 }))
    } catch {
      // As above.
    }
  })

  const isEdited = $derived(!!st && edited !== st.rules)
  const staleEdits = $derived(!!st && !!savedRules && savedRules.base !== st.rulesSHA256 && isEdited)
  const rulesFor = (which: 'server' | 'edited') => (which === 'edited' && isEdited ? edited : '')
  const versionA = $derived<Version>({ seed, rules: rulesFor(rulesA) })
  const versionB = $derived<Version | null>(compare ? { seed: bSeed.trim() || seed, rules: rulesFor(rulesB) } : null)
  const needsGoodRules = $derived((rulesA === 'edited' || (compare && rulesB === 'edited')) && isEdited && !!rulesProblem)
  const wide = $derived(width >= 760)
  const panes = $derived<(0 | 1 | 2)[]>(compare ? (wide ? [0, 1, 2] : [onePanel]) : [0])
  const pane = $derived({ w: compare && wide ? Math.max(1, (mapsW - 12) / 3) : mapsW, h: mapsH })
  const view = $derived(viewOf(mode, camera.zoom))

  /** Everything a render depends on but the camera: a change starts again. */
  const key = $derived(JSON.stringify({ a: versionA.seed, ra: hash(versionA.rules), b: versionB && [versionB.seed, hash(versionB.rules)], epoch, field, overlays: [...overlays].sort() }))

  function hash(s: string): number {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
    return h >>> 0
  }

  /** The overlays a view takes (the atlas has no tiles for solid or reach). */
  function overlayList(): string[] {
    return overlays.filter((o) => view !== 'atlas' || (o !== 'solid' && o !== 'reach'))
  }

  let inflight: { ctl: AbortController; body: string } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  $effect(() => {
    void [camera, pane.w, pane.h, mode, key, st, needsGoodRules]
    clearTimeout(timer)
    timer = setTimeout(go, 180)
    return () => clearTimeout(timer)
  })

  async function go(): Promise<void> {
    if (!st || !pane.w || !pane.h || !seed || !epoch) return
    if (needsGoodRules) {
      renderError = 'The edited rules have a problem: see Rules.'
      return
    }
    const want = plan(camera, pane, st.chunkSize, mode, st.limits)
    const vis = visibleChunks(camera, pane, st.chunkSize)
    const k = key
    if (drawn.some((d) => d.key === k && covers(d.plan, want, vis))) return
    const body = renderBody(want, epoch, overlayList(), versionA, versionB, field)
    const text = JSON.stringify(body)
    if (inflight?.body === text) return
    inflight?.ctl.abort()
    const ctl = new AbortController()
    inflight = { ctl, body: text }
    busySince = Date.now()
    busyView = want.view
    try {
      const a = await labRender(body, ctl.signal)
      if (ctl.signal.aborted) return
      if (!a.ok) {
        renderError = a.text
        return
      }
      const r = a.value
      const bytes = Uint8Array.from(atob(r.png), (c) => c.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      if (ctl.signal.aborted) {
        bitmap.close()
        return
      }
      const fresh: Drawn = { key: k, plan: want, bitmap, panels: versionB ? 3 : 1, panelW: r.width * r.scale, panelH: r.height * r.scale, at: Date.now() }
      const keep = drawn.filter((d) => d.key === k).slice(-5)
      for (const d of drawn) if (!keep.includes(d)) d.bitmap.close()
      drawn = [...keep, fresh]
      stats = r.stats
      comparison = r.comparison ?? null
      renderError = null
      lastCached = a.cached
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) renderError = String(e)
    } finally {
      if (inflight?.ctl === ctl) {
        inflight = null
        busySince = null
      }
    }
  }

  const busy = $derived(busySince === null ? null : `Rendering the ${busyView}… ${((now - busySince) / 1000).toFixed(1)} s`)

  async function inspect(tx: number, ty: number, panel: 0 | 1 | 2): Promise<void> {
    if (!epoch) return
    picked = { tx, ty, panel }
    const v = panel > 0 && versionB ? versionB : versionA
    tileVersion = v
    tileError = null
    tile = null
    tab = 'tile'
    const a = await labTile(v, epoch, tx, ty)
    if (picked?.tx !== tx || picked?.ty !== ty) return
    if (a.ok) tile = a.value
    else tileError = a.text
  }

  /** Where "go here" lands: the nearest open tile of the picked one's chunk. */
  const target = $derived(tile && tile.onGrid !== false ? (tile.stand ?? (tile.fixed ? tile.tile : null)) : null)
  /** The picked tile isn't your world as it is now: the arrival is in your world all the same. */
  const elsewhere = $derived(!!st?.here && !!tileVersion && (tileVersion.seed !== st.here.seed || epoch !== st.here.epoch || !!tileVersion.rules))

  function goHere(): void {
    if (!target) return
    if (!canDevWarp()) {
      message = 'Walk into the world first (the lab can’t move you from here).'
      return
    }
    devWarpTo(target[0], target[1])
    onClose()
  }

  function setView(v: LabView | 'auto'): void {
    mode = v
    if (v !== 'auto') camera = { ...camera, zoom: v === 'region' ? Math.max(camera.zoom, 1.5) : VIEW_ZOOM[v] }
  }

  function zoomBy(f: number): void {
    camera = zoomAround(camera, pane, pane.w / 2, pane.h / 2, f)
  }

  function toggleOverlay(name: string): void {
    overlays = overlays.includes(name) ? overlays.filter((o) => o !== name) : [...overlays, name]
  }

  function useHere(): void {
    if (!st?.here) return
    seed = st.here.seed
    epoch = st.here.epoch
  }

  function keys(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
    // The game listens for keys (WASD, E…): the lab keeps its own.
    e.stopPropagation()
  }

  /** A world's seed is a long hash: its start is enough to tell them apart. */
  const short = (seed: string) => (seed.length > 14 ? seed.slice(0, 10) + '…' : seed)

  const panelName = ['A', 'B', 'Changed'] as const
  const paneLabel = (p: 0 | 1 | 2) => {
    if (!versionB) return `${short(seed)} · ${view}`
    const v = p === 1 ? versionB : versionA
    return p === 2 ? 'Changed' : `${panelName[p]}: ${short(v.seed)}${v.rules ? ' · edited' : ''}`
  }
  const OVERLAY_TEXT: Record<string, string> = {
    regions: 'Regions & IDs',
    biomes: 'Biomes',
    blend: 'Blend band',
    pins: 'Pins',
    'land-cells': 'Land cells',
    'place-cells': 'Place cells',
    tiers: 'Tiers',
    wend: 'The Wend',
    road: 'The road',
    rumours: 'Rumours',
    border: 'World border',
    solid: 'Solid',
    reach: 'Reach'
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="lab" role="dialog" aria-modal="true" aria-label="World lab" tabindex="-1" bind:this={root} onkeydown={keys} bind:clientWidth={width} data-testid="world-lab">
  <header>
    <h2><Icon name="world" size={16} /> World lab</h2>
    <div class="views" role="group" aria-label="Scale">
      {#each ['auto', 'atlas', 'region', 'chunk'] as const as v (v)}
        <button type="button" class="small" aria-pressed={mode === v} onclick={() => setView(v)}>{v === 'auto' ? `Auto (${view})` : v[0].toUpperCase() + v.slice(1)}</button>
      {/each}
    </div>
    <div class="zoom">
      <button type="button" class="small" aria-label="Zoom out" onclick={() => zoomBy(1 / 1.6)}>−</button>
      <button type="button" class="small" aria-label="Zoom in" onclick={() => zoomBy(1.6)}>+</button>
      {#if hero}<button type="button" class="small" onclick={() => (camera = { ...camera, x: hero.tx + 0.5, y: hero.ty + 0.5 })} title="Centre on your hero"><Icon name="pin" size={12} /> You</button>{/if}
    </div>
  </header>
  <button type="button" class="close" aria-label="Close the world lab" onclick={onClose}><Icon name="close" size={14} /></button>

  {#if failed}
    <p class="banner bad" role="alert">{failed}</p>
  {:else if !st}
    <p class="banner" role="status">Opening the lab…</p>
  {:else}
    <div class="body" class:wide>
      <div class="maps" class:three={compare && wide} bind:clientWidth={mapsW} bind:clientHeight={mapsH}>
        {#each panes as p (p)}
          <LabPane {drawn} panel={p} seed={p === 1 && versionB ? versionB.seed : versionA.seed} {camera} chunkSize={st.chunkSize} hero={hero && versionA.seed === st.here?.seed ? hero : null} picked={picked} label={paneLabel(p)} busy={p === panes[0] ? busy : null} onCamera={(c) => (camera = { ...c, zoom: clampZoom(c.zoom) })} onTap={inspect} />
        {/each}
        {#if compare && !wide}
          <div class="which" role="group" aria-label="Diff panel">
            {#each [0, 1, 2] as const as p (p)}
              <button type="button" class="small" aria-pressed={onePanel === p} onclick={() => (onePanel = p)}>{panelName[p]}</button>
            {/each}
          </div>
        {/if}
        {#if renderError}<p class="map-note bad" role="alert">{renderError}</p>{/if}
      </div>

      <aside>
        <div class="tabs" role="tablist">
          {#each [['view', 'View'], ['stats', 'Stats'], ['tile', 'Tile'], ['rules', isEdited ? 'Rules •' : 'Rules']] as const as [id, text] (id)}
            <button type="button" role="tab" class="tab" aria-selected={tab === id} onclick={() => (tab = id)}>{text}</button>
          {/each}
        </div>
        <div class="sheet">
          {#if tab === 'view'}
            <section>
              <label class="field"><span>Seed</span><input bind:value={seed} spellcheck="false" autocomplete="off" /></label>
              <label class="field"><span>Epoch (wick season)</span><input bind:value={epoch} spellcheck="false" autocomplete="off" /></label>
              <div class="row">
                {#if st.here}<button type="button" class="small" onclick={useHere} disabled={seed === st.here.seed && epoch === st.here.epoch}>Your world, now</button>{/if}
                <button type="button" class="small" onclick={() => st && (epoch = st.defaultEpoch)} disabled={epoch === st.defaultEpoch}>Reproducible epoch</button>
              </div>
              {#if st.here && (seed !== st.here.seed || epoch !== st.here.epoch)}<p class="hint">Not your world as it is now: “go here” still lands in your world.</p>{/if}
            </section>
            <section>
              <h3>Rules</h3>
              <div class="row" role="group" aria-label="Rules for the map">
                <button type="button" class="small" aria-pressed={rulesA === 'server'} onclick={() => (rulesA = 'server')}>Server’s</button>
                <button type="button" class="small" aria-pressed={rulesA === 'edited'} onclick={() => (rulesA = 'edited')} disabled={!isEdited}>Edited</button>
              </div>
              {#if !isEdited}<p class="hint">Edit a copy under Rules to try a variant.</p>{/if}
            </section>
            <section>
              <h3>Field heatmap</h3>
              <div class="chips" role="group" aria-label="Field heatmap">
                <button type="button" class="chip" aria-pressed={field === ''} onclick={() => (field = '')}>Terrain / biome</button>
                {#each st.fields ?? ['upland', 'relief', 'wetness', 'warmth', 'quiet'] as f (f)}
                  <button type="button" class="chip" aria-pressed={field === f} onclick={() => (field = field === f ? '' : f)}>{f}</button>
                {/each}
              </div>
              <p class="hint">Lasting world fields (0..1000) depend only on the world seed and tile.</p>
            </section>
            <section>
              <h3>Overlays</h3>
              <div class="chips">
                {#each st.overlays as o (o)}
                  <button type="button" class="chip" aria-pressed={overlays.includes(o)} disabled={view === 'atlas' && (o === 'solid' || o === 'reach')} onclick={() => toggleOverlay(o)}>{OVERLAY_TEXT[o] ?? o}</button>
                {/each}
              </div>
              {#if view === 'atlas'}<p class="hint">Solid and reach need tiles: zoom in to a region.</p>{/if}
            </section>
            <section>
              <h3>Compare</h3>
              <label class="check"><input type="checkbox" bind:checked={compare} /> Side by side: A, B and what changed</label>
              {#if compare}
                <label class="field"><span>B’s seed (empty: the same)</span><input bind:value={bSeed} placeholder={seed} spellcheck="false" autocomplete="off" /></label>
                <div class="row" role="group" aria-label="Rules for B">
                  <button type="button" class="small" aria-pressed={rulesB === 'server'} onclick={() => (rulesB = 'server')}>B: server’s rules</button>
                  <button type="button" class="small" aria-pressed={rulesB === 'edited'} onclick={() => (rulesB = 'edited')} disabled={!isEdited}>B: edited</button>
                </div>
                {#if versionB && versionB.seed === versionA.seed && versionB.rules === versionA.rules}<p class="hint">A and B are the same: change B’s seed or its rules.</p>{/if}
              {/if}
            </section>
            <p class="hint">Drag to pan; wheel or pinch to zoom (atlas → region by zoom, or pick a scale). Tap a tile to inspect it.</p>
          {:else if tab === 'stats'}
            {#if !stats}
              <p class="hint">Nothing rendered yet.</p>
            {:else}
              {@render statsOf(stats, comparison ? 'A' : null)}
              {#if comparison}
                <section class="diff">
                  <h3>Changed</h3>
                  <p class="big">{comparison.changedUnits.toLocaleString()} {comparison.unit} · {percent(comparison.changedShare)}</p>
                  <p class="hint">{comparison.totalMs.toFixed(0)} ms for both.</p>
                </section>
                {@render statsOf(comparison.b, 'B')}
              {/if}
              <p class="hint">{lastCached ? 'From the cache.' : ''} {stats.note}</p>
            {/if}
          {:else if tab === 'tile'}
            {#if !picked}
              <p class="hint">Tap a tile on the map.</p>
            {:else if tileError}
              <p class="bad">{tileError}</p>
            {:else if !tile}
              <p class="hint" role="status">Reading tile {picked.tx}, {picked.ty}…</p>
            {:else}
              <section>
                <h3>Tile {tile.tile[0]}, {tile.tile[1]}</h3>
                <dl>
                  <dt>Version</dt><dd title={tileVersion?.seed}>{short(tileVersion?.seed ?? '')}{tileVersion?.rules ? ', edited rules' : ''}</dd>
                  <dt>Chunk</dt><dd>{tile.chunk[0]}, {tile.chunk[1]} (at {tile.local[0]}, {tile.local[1]})</dd>
                  {#if tile.region}
                    <dt>Region</dt><dd>{tile.region}</dd>
                  {/if}
                  {#if tile.biome}
                    <dt>Biome</dt><dd>{tile.biome}{tile.regionBiome && tile.regionBiome !== tile.biome ? ` (region owner: ${tile.regionBiome})` : ''}</dd>
                  {/if}
                  {#if tile.borderDistTiles !== undefined}
                    <dt>Border</dt><dd>{tile.borderDistTiles} tiles{tile.inBlendBand ? ` · blend band ↔ ${tile.secondaryRegion ?? ''} (${tile.secondaryBiome ?? ''})` : ''}{tile.tripleJunction ? ' · triple junction' : ''}</dd>
                  {/if}
                  {#if tile.pin}
                    <dt>Pin</dt><dd>{tile.pin.biomeRef} ({tile.pin.support ? 'support' : 'direct'} pin from chunk {tile.pin.triggerChunk[0]}, {tile.pin.triggerChunk[1]})</dd>
                  {/if}
                  {#if tile.fields}
                    <dt>Fields</dt><dd>upland {tile.fields.upland} · relief {tile.fields.relief} · wetness {tile.fields.wetness} · warmth {tile.fields.warmth} · quiet {tile.fields.quiet}</dd>
                  {/if}
                  {#if tile.fixed}
                    <dt>Authored</dt><dd>{tile.fixed}: fixed ground, not generated</dd>
                  {:else}
                    <dt>Land</dt><dd>{tile.land} (chunk: {tile.chunkLand})</dd>
                    <dt>Ground</dt><dd>{tile.ground}{tile.solid ? ', solid' : ', open'}</dd>
                    <dt>Here</dt>
                    <dd>{[...tile.entitiesOnTile.map((e) => e.kind ?? e.id), ...tile.sitesOnTile.map((s) => `site ${s.kind}`), ...tile.placesOnTile.map((p) => `place ${p.kind ?? p.id}`)].join(', ') || 'nothing'}</dd>
                    <dt>In the chunk</dt><dd>{(tile.chunkEntities ?? []).map((e) => `${e.kind ?? e.id} (${e.tx}, ${e.ty})`).join(', ') || 'nothing'}</dd>
                  {/if}
                </dl>
              </section>
              <section>
                <button type="button" class="primary go" disabled={!target} onclick={goHere}><Icon name="pin" size={12} /> Go here</button>
                {#if target && (target[0] !== tile.tile[0] || target[1] !== tile.tile[1])}<p class="hint">Lands on {target[0]}, {target[1]}, the nearest open tile.</p>{/if}
                {#if tile.onGrid === false}<p class="hint warn">Your world doesn’t reach this chunk yet: the server wouldn’t let you stand there.</p>
                {:else if !target}<p class="hint">This chunk has no open tile to stand on.</p>
                {:else if tile.fixed}<p class="hint">Authored ground: you land on this very tile, wall or not.</p>{/if}
                {#if elsewhere}<p class="hint warn">This isn’t your world as it is now (seed {short(st.here?.seed ?? '')}, this wick, the server’s rules): you’ll arrive in your world at this tile, which may look different.</p>{/if}
                {#if message}<p class="bad">{message}</p>{/if}
                <p class="hint">Moves only your hero, like a walk: nothing else changes.</p>
              </section>
            {/if}
          {:else}
            {#if staleEdits}<p class="hint warn">The server’s rules changed since you started editing. Reset to start again from its copy.</p>{/if}
            <LabRules bind:text={edited} server={st.rules} bind:problem={rulesProblem} />
          {/if}
        </div>
      </aside>
    </div>
  {/if}
</div>

{#snippet statsOf(s: Stats, name: string | null)}
  <section>
    <h3 title={s.seed}>{name ? `${name}: ` : ''}{short(s.seed)}{s.content === 'edited' ? ' · edited rules' : ''}</h3>
    <dl>
      <dt>View</dt><dd>{s.view}, chunks {s.rect[0]},{s.rect[1]} to {s.rect[2]},{s.rect[3]}</dd>
      <dt>Chunks</dt><dd>{s.chunks.toLocaleString()}{s.generatedChunks ? ` (${s.generatedChunks.toLocaleString()} made, ${s.fixedChunks} authored)` : ''}</dd>
      {#if s.regionCount !== undefined}<dt>Regions</dt><dd>{s.regionCount}{s.blendBandShare !== undefined ? ` · blend band ${percent(s.blendBandShare)}` : ''}</dd>{/if}
      {#if s.pinManifest}<dt>Pins</dt><dd>{s.pinManifest.pins.length} pinned ({s.pinManifest.directPins} direct, {s.pinManifest.supportPins} support)</dd>{/if}
      {#if s.field}<dt>Field ({s.field.field})</dt><dd>min {s.field.min} · mean {s.field.mean.toFixed(0)} · max {s.field.max}</dd>{/if}
      {#if s.firstBiomeChunkDistFromHome}
        <dt>First from home</dt>
        <dd>{Object.entries(s.firstBiomeChunkDistFromHome).map(([k, d]) => `${k}: ${d}c`).join(' · ')}</dd>
      {/if}
      <dt>Time</dt><dd>{s.generationMs.toFixed(0)} ms</dd>
      <dt>Longest land run</dt><dd>{s.longestAxialLandRunChunks} chunks</dd>
      {#if s.solidShare !== undefined}<dt>Solid</dt><dd>{percent(s.solidShare)}</dd>{/if}
      {#if s.campsPer100Chunks !== undefined}<dt>Camps / 100 chunks</dt><dd>{s.campsPer100Chunks.toFixed(1)}</dd>{/if}
      {#if s.placesPer100Chunks !== undefined}<dt>Places / 100 chunks</dt><dd>{s.placesPer100Chunks.toFixed(1)}</dd>{/if}
      {#if s.unreachableWalkableTiles !== undefined}<dt>Unreachable open tiles</dt><dd>{s.unreachableWalkableTiles.toLocaleString()}</dd>{/if}
    </dl>
    {#if s.biomeShare}
      <h4>Biome share</h4>
      {@render bars(ranked(s.biomeShare))}
    {/if}
    <h4>Land, by chunk centre</h4>
    {@render bars(ranked(s.landShareByChunkCentre))}
    {#if s.groundShare}
      <h4>Ground</h4>
      {@render bars(ranked(s.groundShare).slice(0, 10))}
    {/if}
  </section>
{/snippet}

{#snippet bars(list: [string, number][])}
  <ul class="bars">
    {#each list as [k, v] (k)}
      <li><span class="k">{k}</span><span class="bar"><span style:width={`${Math.max(1, v * 100)}%`}></span></span><span class="v">{percent(v)}</span></li>
    {/each}
  </ul>
{/snippet}

<style>
  .lab {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    background: var(--paper);
    color: var(--text);
    font-family: var(--font-body);
    padding: max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
    box-sizing: border-box;
    gap: 8px;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    /* Room for the close button, top right. */
    padding-right: 50px;
    min-height: 40px;
  }
  h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 18px;
    color: var(--wood-dark);
    display: flex;
    align-items: center;
    gap: 6px;
    margin-right: auto;
  }
  .views,
  .zoom,
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .small {
    padding: 4px 10px;
    font-size: 13px;
    min-height: 34px;
  }
  [aria-pressed='true'] {
    background: var(--wood);
    color: var(--cream-hi);
  }
  .close {
    position: absolute;
    top: max(8px, env(safe-area-inset-top));
    right: max(8px, env(safe-area-inset-right));
    min-width: 40px;
    min-height: 40px;
    padding: 0;
  }
  .banner {
    margin: 0;
    padding: 12px;
  }
  .bad {
    color: var(--danger-text);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .body.wide {
    flex-direction: row;
  }
  .maps {
    position: relative;
    flex: 1 1 58%;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr;
    gap: 6px;
  }
  .maps.three {
    grid-template-columns: repeat(3, 1fr);
  }
  .which {
    position: absolute;
    bottom: 32px;
    right: 6px;
    display: flex;
    gap: 4px;
  }
  .map-note {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 30px;
    margin: 0;
    padding: 6px 10px;
    border-radius: 8px;
    background: var(--cream-hi);
    box-shadow: 0 2px 0 var(--wood-dark);
    font-size: 13px;
  }
  aside {
    flex: 1 1 42%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--paper-hi);
    border: 2px solid var(--paper-line);
    border-radius: var(--panel-radius);
    overflow: hidden;
  }
  .wide aside {
    flex: 0 0 min(380px, 36vw);
  }
  .tabs {
    display: flex;
    border-bottom: 2px solid var(--paper-line);
  }
  .tab {
    flex: 1;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    background: transparent;
    padding: 8px 4px;
    min-height: 40px;
    font-size: 14px;
  }
  .tab:hover:not(:disabled),
  .tab:active:not(:disabled) {
    background: var(--wood-wash);
    transform: none;
    box-shadow: none;
  }
  .tab[aria-selected='true'],
  .tab[aria-selected='true']:hover {
    background: var(--cream);
    color: var(--wood-dark);
    box-shadow: inset 0 -3px 0 var(--wood);
  }
  .sheet {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 10px 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  h3 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 15px;
    color: var(--wood-dark);
  }
  h4 {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--text-soft);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
    font-weight: 700;
    color: var(--text-soft);
  }
  .field input {
    font: 14px ui-monospace, Menlo, monospace;
    padding: 6px 8px;
    border: 2px solid var(--paper-line);
    border-radius: 8px;
    background: var(--cream-hi);
    color: var(--text);
    min-height: 36px;
    box-sizing: border-box;
  }
  .check {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 14px;
  }
  .check input {
    width: 20px;
    height: 20px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chip {
    padding: 3px 10px;
    font-size: 13px;
    min-height: 32px;
    border-radius: 16px;
  }
  .hint {
    margin: 0;
    font-size: 12px;
    color: var(--text-soft);
  }
  .warn {
    color: var(--danger-text);
  }
  .big {
    margin: 0;
    font-family: var(--font-display);
    font-size: 18px;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    margin: 0;
    font-size: 13px;
  }
  dt {
    color: var(--text-soft);
  }
  dd {
    margin: 0;
    word-break: break-word;
    font-variant-numeric: tabular-nums;
  }
  .bars {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
  }
  .bars li {
    display: grid;
    grid-template-columns: 7.5em 1fr 4em;
    gap: 6px;
    align-items: center;
  }
  .k {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bar {
    height: 8px;
    border-radius: 4px;
    background: var(--wood-wash);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .v {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .go {
    align-self: flex-start;
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
</style>
