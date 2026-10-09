<script lang="ts">
  /**
   * A Habitica pet or mount as the panel shows it: its sprite layers (a
   * mount's body and head) stacked, crisp, from the bundled cache or the
   * sprite proxy (src/lib/habitica/sprite-cache.ts). Nothing is drawn for a
   * key that can't be had: never a stand-in.
   */
  import { assetSourceFor, companionLayersFor } from '../lib/habitica/avatar'
  import { spriteCache } from '../lib/habitica/sprite-cache'

  let { key, kind, size = 44 }: { key: string; kind: 'pet' | 'mount'; size?: number } = $props()

  let srcs = $state<string[]>([])

  $effect(() => {
    const k = key
    const which = kind
    let live = true
    srcs = []
    const refs = companionLayersFor(k, which)
    void Promise.all(refs.map((r) => (assetSourceFor(r.key) === 'local' ? Promise.resolve(r.url) : assetSourceFor(r.key) === 'remote' ? spriteCache.src(r.key) : Promise.resolve(null)))).then((urls) => {
      if (live) srcs = urls.filter((u): u is string => !!u)
    })
    return () => {
      live = false
    }
  })
</script>

<span class="art" class:mount={kind === 'mount'} style={`width:${size}px;height:${size}px`} aria-hidden="true">
  {#each srcs as src (src)}
    <img {src} alt="" />
  {/each}
</span>

<style>
  .art {
    position: relative;
    display: inline-block;
    flex: none;
    overflow: hidden;
  }
  .art img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    object-position: center bottom;
    image-rendering: pixelated;
  }
  /* A mount's canvas is mostly air above and right of it: show the animal. */
  .mount img {
    inset: -10% -18% -12% -6%;
    width: 124%;
    height: 122%;
  }
</style>
