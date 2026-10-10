<script lang="ts">
  /**
   * A Habitica figure as the Wardrobe draws it (purse-and-wardrobe.md 4.1,
   * 4.4): the same layer stack as the world avatar (avatarLayersFor), from
   * the bundled cache or the sprite proxy, cropped to the head, the torso or
   * the whole figure. The picker's tiles and the tab's preview are both this.
   * Art loads only once the tile scrolls into view, so a big wardrobe fills
   * in as you look. Nothing is drawn for a piece that can't be had.
   */
  import { onMount } from 'svelte'
  import { avatarLayersFor, type AvatarProfileFull } from '../lib/habitica/avatar'
  import { resolveLayers } from '../game/avatar-render'
  import type { TileCrop } from '../lib/wardrobe'

  let { profile, crop = 'whole', size = 56 }: { profile: AvatarProfileFull; crop?: TileCrop; size?: number } = $props()

  /** The crop on the 90 px Habitica canvas: the figure spans about x 12–81, y 21–87; the head 39–75 × 24–60. */
  const CROPS: Record<TileCrop, { x: number; y: number; s: number }> = {
    head: { x: 28, y: 12, s: 56 },
    torso: { x: 24, y: 34, s: 58 },
    whole: { x: 6, y: 10, s: 80 }
  }

  let el = $state<HTMLElement | null>(null)
  let seen = $state(false)
  let srcs = $state<string[]>([])

  onMount(() => {
    if (!el || typeof IntersectionObserver === 'undefined') {
      seen = true
      return
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        seen = true
        io.disconnect()
      }
    })
    io.observe(el)
    return () => io.disconnect()
  })

  $effect(() => {
    if (!seen) return
    const refs = avatarLayersFor(profile)
    let live = true
    const now = resolveLayers(refs)
    void Promise.resolve(now).then((r) => {
      if (live) srcs = r.refs.map((ref) => ref.url)
    })
    return () => {
      live = false
    }
  })

  const box = $derived(CROPS[crop])
  const k = $derived(size / box.s)
</script>

<span class="tile" bind:this={el} style={`width:${size}px;height:${size}px`} aria-hidden="true">
  <span class="canvas" style={`transform:translate(${-box.x * k}px, ${-box.y * k}px) scale(${k})`}>
    {#each srcs as src, i (`${i}:${src}`)}
      <img {src} alt="" />
    {/each}
  </span>
</span>

<style>
  .tile {
    position: relative;
    display: inline-block;
    flex: none;
    overflow: hidden;
  }
  /* The Habitica canvas: every layer at a shared top-left, as upstream stacks them. */
  .canvas {
    position: absolute;
    left: 0;
    top: 0;
    width: 90px;
    height: 90px;
    transform-origin: 0 0;
  }
  .canvas img {
    position: absolute;
    left: 0;
    top: 0;
    image-rendering: pixelated;
  }
</style>
