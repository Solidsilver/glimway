<script lang="ts">
  import { onMount } from 'svelte'
  import { EMOTES, presenceCopy } from '../content/presence'
  import { presence } from '../game/presence'
  import { isTouchFirst } from './device'
  import Icon from './Icon.svelte'
  import ArtIcon from './ArtIcon.svelte'

  /**
   * The emote row (phase 6): five small gestures from shared content. Opens
   * with G (or the HUD's speech button), picks with 1–5 or a tap, and shows
   * the cooldown so a too-soon tap is never silently dropped.
   */
  let { onPick, onClose }: { onPick: (id: string) => void; onClose: () => void } = $props()

  const touch = isTouchFirst()
  let wait = $state(0)
  let raf = 0

  function tick(): void {
    wait = presence()?.client.emoteWait() ?? 0
    raf = requestAnimationFrame(tick)
  }

  onMount(() => {
    tick()
    return () => cancelAnimationFrame(raf)
  })
</script>

<div class="emotes panel" role="toolbar" aria-label={presenceCopy.pickerTitle} data-testid="emote-picker">
  <span class="title"><Icon name="speech" size={14} /> {presenceCopy.pickerTitle}</span>
  <div class="row">
    {#each EMOTES as e, i (e.id)}
      <button type="button" class="emote" onclick={() => onPick(e.id)} disabled={wait > 0} aria-label={e.label} title={e.say}>
        <span class="ic"><ArtIcon art={`icon-emote-${e.id}`} name={e.icon} size={18} /></span>
        <span class="label">{e.label}</span>
        {#if !touch}<span class="kbd">{i + 1}</span>{/if}
      </button>
    {/each}
  </div>
  {#if wait > 0}
    <div class="cool" aria-hidden="true"><span style={`width:${Math.min(100, (wait / 2000) * 100)}%`}></span></div>
  {/if}
  <button type="button" class="close ghost" onclick={onClose} aria-label="Close emotes"><Icon name="close" size={12} /></button>
  {#if !touch}<p class="hint">{presenceCopy.pickerHint}</p>{/if}
</div>

<style>
  .emotes {
    position: absolute;
    left: 50%;
    bottom: max(104px, calc(env(safe-area-inset-bottom) + 104px));
    transform: translateX(-50%);
    z-index: 24;
    display: grid;
    gap: 6px;
    justify-items: center;
    padding: 8px 10px 8px;
    animation: pop 0.16s ease-out;
  }
  .title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-display);
    font-size: 12px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--wood);
  }
  .row {
    display: flex;
    gap: 6px;
  }
  .emote {
    position: relative;
    display: grid;
    justify-items: center;
    gap: 2px;
    width: 62px;
    padding: 7px 4px 5px;
    font-size: 12px;
  }
  .emote .ic {
    color: var(--ember-deep);
  }
  .emote .label {
    font-size: 12px;
  }
  .emote .kbd {
    position: absolute;
    top: -7px;
    right: -5px;
    font-size: 10px;
  }
  .cool {
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: rgba(107, 76, 46, 0.18);
    overflow: hidden;
  }
  .cool span {
    display: block;
    height: 100%;
    background: var(--gold-deep);
  }
  .close {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 24px;
    height: 24px;
    padding: 0;
    display: grid;
    place-items: center;
  }
  .hint {
    margin: 0;
    font-size: 11.5px;
    color: var(--text-faint);
  }
  @media (max-width: 560px), (pointer: coarse) {
    .emotes {
      bottom: max(196px, calc(env(safe-area-inset-bottom) + 196px));
      width: calc(100% - 24px);
    }
    .row {
      width: 100%;
      justify-content: space-between;
    }
    .emote {
      flex: 1;
      width: auto;
      min-height: 52px;
    }
  }
  @keyframes pop {
    from { opacity: 0; transform: translate(-50%, 6px); }
  }
</style>
