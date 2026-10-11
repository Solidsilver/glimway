<script lang="ts">
  import type { Session } from '../game/session'
  import { bus, EV } from '../game/events'
  import { mapInput } from '../game/wilds/map-data'
  import { fitLabels, mapPicture, type MapInput, type MapPicture } from '../lib/wilds/map-model'
  import { foundByText, placeName } from '../lib/wilds/paths'
  import { MAP_LABELS } from '../content/open-map'

  /**
   * The Map tab (docs/design/open-map.md 2.8): the land you've walked this
   * wick, drawn from its chunks, with the frontier's edge, the road and the
   * Wend, laid paths and named ways, the places you've seen and who found
   * them first, and you. A plain drawn grid; 0.9's Lamps tab grows from it.
   */
  let { session }: { session: Session } = $props()

  let input = $state<MapInput | null>(null)
  let picture = $state<MapPicture | null>(null)
  let loading = $state(true)
  let canvas = $state<HTMLCanvasElement | null>(null)

  async function load(): Promise<void> {
    const got = await mapInput(session)
    input = got
    picture = got ? mapPicture(got) : null
    loading = false
  }

  $effect(() => {
    void load()
    // The Wilds moved (a read, a path, a find): draw again, at most twice a second.
    let queued: ReturnType<typeof setTimeout> | null = null
    const again = () => {
      if (queued) return
      queued = setTimeout(() => {
        queued = null
        void load()
      }, 500)
    }
    bus.on(EV.wilds, again)
    return () => {
      bus.off(EV.wilds, again)
      if (queued) clearTimeout(queued)
    }
  })

  $effect(() => {
    const p = picture
    const c = canvas
    if (!p || !c) return
    c.width = p.width
    c.height = p.height
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.putImageData(new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0)
  })

  // The sheet's width on screen: labels that would overlap at this size are left off (their marks stay).
  let sheetWidth = $state(0)
  const labels = $derived(picture && sheetWidth ? fitLabels(picture.labels, sheetWidth / picture.width) : [])
  const places = $derived((input?.places ?? []).filter((p) => p.seen || p.foundBy))
  const ways = $derived(input?.ways ?? [])
  /** A place by name for the list ("the camp glade", "the Tangle"). */
  const nameOf = (id: string) => placeName(id, input?.places.find((p) => p.id === id)?.kind ?? null)
  const pct = (v: number, of: number) => `${((v + 0.5) / of) * 100}%`
</script>

<div class="map" data-testid="map-tab">
  {#if loading}
    <p class="lead">Unfolding the map…</p>
  {:else if !input || !picture}
    <p class="lead">{MAP_LABELS.offline}</p>
  {:else}
    <p class="lead">{MAP_LABELS.wick}</p>
    <div class="sheet" style={`aspect-ratio: ${picture.width} / ${picture.height}; width: min(100%, calc(52vh * ${picture.width / picture.height}))`} bind:clientWidth={sheetWidth}>
      <canvas bind:this={canvas} aria-label={MAP_LABELS.title} data-testid="map-canvas"></canvas>
      {#each labels as l, i (i)}
        <span class={`label ${l.kind}`} style={`left: ${pct(l.x, picture.width)}; top: ${pct(l.y, picture.height)}`} data-label={l.kind}>
          {l.text}{#if l.sub}<small>{foundByText(l.sub)}</small>{/if}
        </span>
      {/each}
    </div>
    {#if input.chunks.length <= 9 && !input.hero}
      <p class="fine">{MAP_LABELS.empty}</p>
    {/if}

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
      <p class="fine">{MAP_LABELS.seen}: none yet.</p>
    {/if}
  {/if}
</div>

<style>
  .map {
    display: grid;
    gap: 8px;
  }
  .lead {
    margin: 2px 0 2px;
    font-size: 13px;
    color: var(--text-soft);
  }
  .sheet {
    position: relative;
    justify-self: center;
    border: 2px solid var(--paper-line);
    border-radius: 8px;
    overflow: hidden;
    background: #efe3bf;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
  }
  .label {
    position: absolute;
    transform: translate(-50%, -110%);
    padding: 0 3px;
    border-radius: 4px;
    font-family: var(--font-display);
    font-size: 10px;
    line-height: 1.15;
    color: var(--wood-dark);
    background: rgba(255, 249, 230, 0.82);
    white-space: nowrap;
    pointer-events: none;
    text-align: center;
  }
  .label small {
    display: block;
    font-size: 9px;
    color: #5a3a86;
  }
  .label.footprint {
    transform: translate(-50%, -50%);
    font-size: 11px;
    background: rgba(255, 249, 230, 0.6);
  }
  .label.you {
    transform: translate(-50%, 40%);
    color: #fff;
    background: #c4523a;
  }
  .label.way {
    background: rgba(255, 236, 190, 0.9);
    color: #7a4c10;
  }
  h3 {
    margin: 6px 0 0;
    font-family: var(--font-display);
    font-size: 14px;
    color: var(--wood-dark);
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 4px;
    font-size: 13px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .fine {
    margin: 0;
    font-size: 12px;
    color: var(--text-soft);
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
</style>
