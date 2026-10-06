<script lang="ts">
  import { ui } from './store.svelte'
  import { home } from './home.svelte'
  import { sfx } from '../game/sfx'
  import { heroScreen } from '../game/input'
  import { isTouchFirst } from './device'
  import Icon from './Icon.svelte'

  /**
   * One banner at a time: quest beats get a ribbon with a chime, area
   * changes get a big storybook title card. Banners wait while a cinematic
   * owns the screen so they land after the moment, not on top of it.
   */
  const current = $derived(!ui.cinematic && !ui.dialogueOpen && ui.defeat === 'none' && !home.placement ? ui.banners[0] ?? null : null)
  // Placement mode or a conversation owns the screen: an area card would
  // only show through the grid or over the dialogue, and by the end it's old
  // news. A quest ribbon waits for the conversation to close.
  $effect(() => {
    if ((home.placement || ui.dialogueOpen) && ui.banners.some((b) => b.kind === 'area')) ui.banners = ui.banners.filter((b) => b.kind !== 'area')
  })
  let timer: number | null = null
  let shownId: string | null = null
  const touch = isTouchFirst()

  /**
   * Where a card sits: under the HUD, or low above the buttons, whichever
   * keeps clear of the hero (and the thought over the hero's head, and so
   * whatever the hero just walked up to). Short screens get a compact card.
   */
  let spot = $state<{ top?: number; bottom?: number; x?: number; compact: boolean }>({ compact: false })
  function place(kind: 'quest' | 'area'): typeof spot {
    const vh = window.innerHeight
    const vw = window.innerWidth
    const css = getComputedStyle(document.documentElement)
    const hudBottom = parseFloat(css.getPropertyValue('--hud-bottom')) || 0
    const dock = parseFloat(css.getPropertyValue('--dock-bottom')) || 0
    const compact = vh < 520
    // Rough card sizes (the card fades in; measuring first would flash).
    const h = compact ? (kind === 'quest' ? 72 : 70) : touch ? (kind === 'quest' ? 160 : 176) : kind === 'quest' ? 150 : 190
    const fullW = Math.min(kind === 'quest' ? 520 : 820, vw * 0.94)
    const sideW = Math.min(360, vw * 0.42)
    // A phone keeps a lane under its HUD buttons for the "+7 Fiber" tags.
    const top = hudBottom + (touch ? 40 : 14)
    const low = vh - dock - h
    // No hero on screen yet (the first frames): the top, as before.
    if (heroScreen.x === 0 && heroScreen.y === 0) return { top, compact }

    // What a card mustn't cover: the hero, the thought over the hero's head, and the prompt tag.
    const z = touch ? 2 : Math.max(1.5, Math.round((vh / 280) * 2) / 2)
    const thinking = !!ui.thought && performance.now() - ui.thought.at < 9000
    const halfW = thinking ? 66 * z : 16 * z
    type Box = { x: number; y: number; w: number; h: number }
    const keep: Box[] = [{ x: heroScreen.x - halfW, y: heroScreen.y - (30 + (thinking ? 46 : 0)) * z, w: halfW * 2, h: (42 + (thinking ? 46 : 0)) * z }]
    const prompt = document.querySelector('.prompt')?.getBoundingClientRect()
    if (prompt && prompt.width > 0) keep.push({ x: prompt.x, y: prompt.y, w: prompt.width, h: prompt.height })

    const cover = (c: Box) => keep.reduce((sum, k) => sum + Math.max(0, Math.min(c.x + c.w, k.x + k.w) - Math.max(c.x, k.x)) * Math.max(0, Math.min(c.y + c.h, k.y + k.h) - Math.max(c.y, k.y)), 0)
    const options: { spot: typeof spot; box: Box }[] = [{ spot: { top, compact }, box: { x: (vw - fullW) / 2, y: top, w: fullW, h } }]
    if (low > top + h) options.push({ spot: { bottom: dock, compact }, box: { x: (vw - fullW) / 2, y: low, w: fullW, h } })
    // A wide screen can put it beside the hero instead.
    if (vw >= 700) {
      for (const cx of [vw * 0.27, vw * 0.73]) options.push({ spot: { top, compact, x: cx }, box: { x: cx - sideW / 2, y: top, w: sideW, h } })
    }
    let best = options[0]
    let bestCover = cover(best.box)
    for (const o of options.slice(1)) {
      const c = cover(o.box)
      if (c < bestCover - 1) {
        best = o
        bestCover = c
      }
    }
    return best.spot
  }
  const spotStyle = $derived(
    (spot.top !== undefined ? `top:${Math.round(spot.top)}px;` : spot.bottom !== undefined ? `top:auto;bottom:${Math.round(spot.bottom)}px;` : '') +
      (spot.x !== undefined ? `left:${Math.round(spot.x)}px;width:min(360px, 42vw);` : '')
  )

  // Read-only, for playtests (dev builds): the banners shown so far, in
  // order (a card lasts a few seconds of wall time, which a busy test can miss).
  const shownLog: { kind: string; title: string }[] = []
  if (import.meta.env.DEV) {
    ;(window as unknown as { __fsBanners?: () => unknown }).__fsBanners = () => ({
      current: current && showing === current.id ? { kind: current.kind, title: current.title } : current ? { kind: current.kind, title: current.title, waiting: true } : null,
      shown: [...shownLog]
    })
  }

  /** The banner on screen (an area card waits a moment after arriving, until the camera has settled on the hero). */
  let showing = $state<string | null>(null)
  let waitTimer: number | null = null

  $effect(() => {
    const b = current
    if (!b) {
      // Hidden by a cinematic/defeat: stop the clock so it re-shows in full.
      if (timer !== null) window.clearTimeout(timer)
      if (waitTimer !== null) window.clearTimeout(waitTimer)
      timer = null
      waitTimer = null
      shownId = null
      showing = null
      ui.shownBannerId = null
      ui.setBannerUp(false)
      return
    }
    if (b.id === shownId) return
    shownId = b.id
    showing = null
    ui.shownBannerId = b.id
    ui.setBannerUp(true)
    if (waitTimer !== null) window.clearTimeout(waitTimer)
    const show = () => {
      waitTimer = null
      if (shownId !== b.id) return
      spot = place(b.kind)
      showing = b.id
      if (import.meta.env.DEV) shownLog.push({ kind: b.kind, title: b.title })
      sfx(b.kind === 'quest' ? 'quest' : 'step-area')
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => dismiss(b.id), b.kind === 'quest' ? 4200 : 2600)
    }
    if (b.kind === 'area') waitTimer = window.setTimeout(show, 350)
    else show()
  })

  function dismiss(id: string): void {
    if (timer !== null) window.clearTimeout(timer)
    timer = null
    if (ui.shownBannerId === id) ui.shownBannerId = null
    ui.dismissBanner(id)
    if (!ui.banners.length) ui.setBannerUp(false)
  }
</script>

{#if current && showing === current.id}
  {#key current.id}
    {#if current.kind === 'quest'}
      <button type="button" class="quest" class:compact={spot.compact} style={spotStyle} onclick={() => dismiss(current.id)} aria-live="polite">
        <span class="eyebrow"><Icon name="star" size={12} /> {current.eyebrow} <Icon name="star" size={12} /></span>
        <span class="title">{current.title}</span>
        <!-- On a short screen the ribbon is a title only: the goal is in the HUD and the journal. -->
        {#if current.body && !spot.compact}<span class="body">{current.body}</span>{/if}
      </button>
    {:else}
      <div class="area" class:compact={spot.compact} style={spotStyle} aria-live="polite">
        <span class="rule"></span>
        <span class="eyebrow">{current.eyebrow}</span>
        <span class="title">{current.title}</span>
        {#if current.body && !spot.compact}<span class="body">{current.body}</span>{/if}
        <span class="rule"></span>
      </div>
    {/if}
  {/key}
{/if}

<style>
  /* Both sit in the upper third, under the HUD (--hud-bottom, set by
     App.svelte), and clear of the hero, who stands mid-screen. */
  .quest {
    all: unset;
    position: absolute;
    top: max(14%, calc(var(--hud-bottom, 0px) + 14px));
    left: 50%;
    transform: translateX(-50%);
    z-index: 36;
    width: min(520px, 90vw);
    padding: 16px 28px 18px;
    display: grid;
    justify-items: center;
    gap: 4px;
    text-align: center;
    cursor: pointer;
    color: #3d2410;
    background:
      radial-gradient(120% 120% at 50% 0%, #fff6c8 0%, rgba(255, 246, 200, 0) 70%),
      linear-gradient(180deg, #ffe58a 0%, #f2b93a 100%);
    border: 3px solid #5a3410;
    border-radius: 14px;
    box-shadow:
      inset 0 0 0 2px rgba(255, 250, 220, 0.85),
      0 6px 0 rgba(40, 20, 8, 0.5),
      0 0 60px rgba(255, 210, 74, 0.55);
    animation: ribbon-in 0.5s cubic-bezier(0.2, 0.9, 0.3, 1.25), ribbon-out 0.4s ease-in 3.8s forwards;
  }
  .quest:focus-visible {
    outline: 3px solid #fff;
  }
  .quest .eyebrow {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-display);
    font-size: 12px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: #7a4a10;
  }
  .quest .title {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 28px;
    line-height: 1.1;
  }
  .quest .body {
    font-size: 14.5px;
    color: #5a3a14;
    max-width: 40ch;
  }

  .area {
    position: absolute;
    top: max(10%, calc(var(--hud-bottom, 0px) + 6px));
    left: 50%;
    transform: translateX(-50%);
    z-index: 34;
    width: min(820px, 94vw);
    display: grid;
    justify-items: center;
    gap: 6px;
    text-align: center;
    pointer-events: none;
    padding: 18px 24px;
    color: #fff6dc;
    text-shadow: 0 2px 0 rgba(20, 12, 16, 0.85), 0 0 24px rgba(20, 12, 16, 0.8);
    background: radial-gradient(ellipse at center, rgba(20, 14, 24, 0.62) 0%, rgba(20, 14, 24, 0.35) 45%, transparent 72%);
    animation: area-in 0.6s ease-out, area-out 0.5s ease-in 2.1s forwards;
  }
  .area .eyebrow {
    font-family: var(--font-display);
    font-size: 14px;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    color: var(--gold);
  }
  .area .title {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: clamp(30px, 6vw, 52px);
    line-height: 1;
    letter-spacing: 0.04em;
  }
  .area .body {
    font-size: 15px;
    max-width: 44ch;
    font-style: italic;
    opacity: 0.92;
  }
  /* Short screens (phone landscape): the card in two lines, no tagline. */
  .area.compact {
    padding: 8px 20px;
    gap: 2px;
  }
  .area.compact .eyebrow {
    font-size: 11px;
  }
  .area.compact .title {
    font-size: 30px;
  }
  .area.compact .rule {
    display: none;
  }
  .quest.compact {
    padding: 8px 20px 10px;
    width: min(460px, 70vw);
  }
  .quest.compact .title {
    font-size: 22px;
  }
  .quest.compact .body {
    font-size: 13px;
  }
  .rule {
    width: 120px;
    height: 2px;
    background: linear-gradient(90deg, transparent, var(--gold), transparent);
  }

  @keyframes ribbon-in {
    from { transform: translate(-50%, -20px) scale(0.85); opacity: 0; }
    to { transform: translate(-50%, 0) scale(1); opacity: 1; }
  }
  @keyframes ribbon-out {
    to { transform: translate(-50%, -12px); opacity: 0; }
  }
  @keyframes area-in {
    from { opacity: 0; transform: translate(-50%, 10px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }
  @keyframes area-out {
    to { opacity: 0; }
  }
</style>
