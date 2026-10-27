<script lang="ts">
  import { onTerrainSettings, setTerrainSettings, terrainSettings, TERRAIN_DEFAULT, type TerrainSettings } from '../../game/terrain/settings'
  import type { Session } from '../../game/session'
  import { heroPosition } from '../../game/map-position'
  import { canDevWarp, devWarpTo } from '../../game/dev-warp'
  import { FEATURE_LABELS, nearestFeatures, featureLabel, type FeatureKind } from '../../game/terrain/find'
  import { setTerrainFeatureView } from '../../game/terrain/feature-view'

  let { session }: { session: Session } = $props()
  let busy = $state(false)
  let message = $state('')
  let request: AbortController | null = null
  $effect(() => {
    if (!s.on) { request?.abort(); setTerrainFeatureView(null) }
    return () => request?.abort()
  })

  async function go(kind: FeatureKind): Promise<void> {
    const p = heroPosition(session.state, session.link?.worldId ?? '')
    if (!p || !canDevWarp()) { message = 'Enter the world first.'; return }
    busy = true
    message = 'Finding certified terrain…'
    const controller = new AbortController()
    request = controller
    try {
      const x = p.x / 16, y = p.y / 16
      const found = await nearestFeatures(x, y, controller.signal)
      if (controller.signal.aborted || !s.on) return
      const f = found.features.find((f) => f.kind === kind)
      if (!f) { message = 'No certified feature of this kind in the surrounding owner squares.'; return }
      setTerrainFeatureView(f)
      message = devWarpTo(...f.stand) ? featureLabel(f, x, y) : 'Enter the world first.'
    } catch (e) {
      if (!controller.signal.aborted) message = e instanceof Error ? e.message : String(e)
    } finally { busy = false }
  }

  // The dev panel's Terrain section (DevPanel.svelte): generated height
  // terrain in the Wilds (src/game/terrain), on dev servers only. The look
  // controls the height lab settled: top-down or the true ¾ lift, edge
  // shading, the sun, slope speed. Kept on this device.
  let s = $state<TerrainSettings>(terrainSettings())
  $effect(() => onTerrainSettings((n) => (s = n)))
  const set = (change: Partial<TerrainSettings>) => setTerrainSettings(change)
</script>

<section class="terrain" data-testid="dev-terrain">
  <p class="what">Generated height terrain in the Wilds: hills, ranges with passes, crags and cliffs, regenerated from the world’s seed (nothing is saved). Only a dev server serves it; the live server stays flat.</p>
  <label class="row"><span class="label"><input type="checkbox" checked={s.on} onchange={(e) => set({ on: e.currentTarget.checked })} data-testid="dev-terrain-on" /> Height terrain</span></label>
  {#if s.on}
    <div class="row" role="group" aria-label="Go to the nearest">
      <span class="label">Go to the nearest:</span>
      {#each Object.entries(FEATURE_LABELS) as [kind, label]}
        <button type="button" class="small" disabled={busy} onclick={() => void go(kind as FeatureKind)} data-testid={`terrain-go-${kind}`}>{label}</button>
      {/each}
    </div>
    <p class="what">Spire: view only. Tunnel: candidate only. Arrivals are certified for height terrain; trees and other cover are separate.</p>
    <p class="what" role="status" data-testid="terrain-destination">{message}</p>
    <div class="row" role="group" aria-label="Drawn as">
      <span class="label">Drawn as</span>
      <button type="button" class="small" aria-pressed={s.mode === 'top'} onclick={() => set({ mode: 'top' })}>Top-down</button>
      <button type="button" class="small" aria-pressed={s.mode === 'lift'} onclick={() => set({ mode: 'lift' })}>True ¾ lift</button>
    </div>
    <div class="row" role="group" aria-label="Edge shading">
      <label class="row">
        <span class="label">Edge shading: {Math.round(s.edgeShade * 100)}%</span>
        <input type="range" min="0" max="100" step="5" aria-label="Edge shading" value={Math.round(s.edgeShade * 100)} oninput={(e) => set({ edgeShade: Number(e.currentTarget.value) / 100 })} />
      </label>
      <label class="row">
        <span class="label">Band width: {s.edgeWidth} px</span>
        <input type="range" min="1" max="8" step="1" aria-label="Band width" value={s.edgeWidth} oninput={(e) => set({ edgeWidth: Number(e.currentTarget.value) })} />
      </label>
      <label class="row">
        <span class="label">Threshold: {s.edgeThreshold.toFixed(1)} levels</span>
        <input type="range" min="0.1" max="2" step="0.1" aria-label="Edge threshold" value={s.edgeThreshold} oninput={(e) => set({ edgeThreshold: Number(e.currentTarget.value) })} />
      </label>
      <label class="row"><span class="label"><input type="checkbox" checked={s.edgeScale} onchange={(e) => set({ edgeScale: e.currentTarget.checked })} /> Scale by height difference</span></label>
      <label class="row"><span class="label"><input type="checkbox" checked={s.edgeRim} onchange={(e) => set({ edgeRim: e.currentTarget.checked })} /> Rim light on the high lip</span></label>
    </div>
    <label class="row">
      <span class="label">Sun strength: {Math.round(s.sunStrength * 100)}%</span>
      <input type="range" min="0" max="200" step="5" aria-label="Sun strength" value={Math.round(s.sunStrength * 100)} oninput={(e) => set({ sunStrength: Number(e.currentTarget.value) / 100 })} />
    </label>
    <label class="row"><span class="label"><input type="checkbox" checked={s.sunClock} onchange={(e) => set({ sunClock: e.currentTarget.checked })} /> Sun follows the game clock</span></label>
    <label class="row">
      <span class="label">Time of day: {(6 + s.sunTime * 12).toFixed(1)} h</span>
      <input type="range" min="0" max="1" step="0.01" aria-label="Time of day" disabled={s.sunClock} value={s.sunTime} oninput={(e) => set({ sunTime: Number(e.currentTarget.value) })} />
    </label>
    <label class="row">
      <span class="label">Uphill slowdown: {s.uphill}%</span>
      <input type="range" min="0" max="80" step="1" aria-label="Uphill slowdown" value={s.uphill} oninput={(e) => set({ uphill: Number(e.currentTarget.value) })} />
    </label>
    <label class="row">
      <span class="label">Downhill quickening: {s.downhill}%</span>
      <input type="range" min="0" max="20" step="1" aria-label="Downhill quickening" value={s.downhill} oninput={(e) => set({ downhill: Number(e.currentTarget.value) })} />
    </label>
    <label class="row"><span class="label"><input type="checkbox" checked={s.gait} onchange={(e) => set({ gait: e.currentTarget.checked })} /> Slope gait</span></label>
    <button type="button" class="small" onclick={() => set({ ...TERRAIN_DEFAULT, on: true, mode: s.mode })}>Defaults</button>
  {/if}
</section>

<style>
  .what {
    margin: 0 0 8px;
    font-size: 13px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
  }
  .label {
    flex: 1 1 100%;
  }
</style>
