<script lang="ts">
  import type { GameState } from '../lib/state'
  import { questObjective } from '../lib/state'
  import { areaInfo } from '../content/world'
  import { MIGRATION_CAP, originCopy } from '../content/connected'
  import { focusTrap } from './focus'
  import Icon from './Icon.svelte'

  /**
   * First sign-in for an account: bring this device's journey into the world,
   * or start fresh there (design: "Migrating a guest save"). The choice is
   * recorded once per account by the server.
   */
  let {
    name,
    local,
    busy,
    error,
    onChoose,
    onCancel
  }: {
    name: string
    local: GameState
    busy: boolean
    error: string
    onChoose: (choice: 'migrate' | 'fresh') => void
    onCancel?: () => void
  } = $props()

  const place = $derived(areaInfo(local.area).name)
  const goal = $derived(questObjective(local.quest))
  const carried = $derived(Math.min(local.embers, MIGRATION_CAP))
</script>

<div class="overlay gate" role="dialog" aria-modal="true" aria-labelledby="origin-title" aria-busy={busy}>
  <div class="panel gate-panel wide" use:focusTrap>
    <p class="gate-eyebrow"><Icon name="lantern" size={14} /> {originCopy.eyebrow}</p>
    <h2 class="gate-title" id="origin-title">{originCopy.title(name)}</h2>
    <p class="gate-lead">{originCopy.lead}</p>

    <div class="options">
      <button type="button" class="option bring" onclick={() => onChoose('migrate')} disabled={busy}>
        <span class="opt-head">
          <span class="opt-badge"><Icon name="scroll" size={16} /></span>
          <span class="opt-title">{originCopy.bring.label}</span>
        </span>
        <span class="opt-where">
          <span class="place"><Icon name="map" size={12} /> {place}</span>
          <span class="goal">{goal}</span>
        </span>
        <span class="opt-list">
          <span class="li"><span class="ic ok"><Icon name="check" size={11} /></span>{originCopy.bring.keeps}</span>
          <span class="li"><span class="ic ember"><Icon name="ember" size={12} /></span>{originCopy.bring.embers(carried)}</span>
          <span class="li"><span class="ic heart"><Icon name="heart" size={12} /></span>{originCopy.bring.vitals}</span>
        </span>
      </button>

      <button type="button" class="option fresh" onclick={() => onChoose('fresh')} disabled={busy}>
        <span class="opt-head">
          <span class="opt-badge"><Icon name="sparkle" size={16} /></span>
          <span class="opt-title">{originCopy.fresh.label}</span>
        </span>
        <span class="opt-list">
          <span class="li"><span class="ic ok"><Icon name="check" size={11} /></span>{originCopy.fresh.keeps}</span>
          <span class="li"><span class="ic ember"><Icon name="ember" size={12} /></span>{originCopy.fresh.welcome}</span>
          <span class="li"><span class="ic home"><Icon name="lantern" size={12} /></span>{originCopy.fresh.local}</span>
        </span>
      </button>
    </div>

    {#if error}<p class="gate-error" role="alert">{error}</p>{/if}
    {#if busy}
      <p class="gate-status" role="status"><span class="gate-spinner" aria-hidden="true"></span> {originCopy.working}</p>
    {:else}
      <p class="gate-fine">
        {originCopy.once}
        {#if onCancel}<button type="button" class="ghost later" onclick={onCancel}>Not now</button>{/if}
      </p>
    {/if}
  </div>
</div>

<style>
  .options {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin: 14px 0 8px;
  }
  .option {
    display: grid;
    align-content: start;
    gap: 8px;
    padding: 14px 14px 16px;
    text-align: left;
    border-radius: 12px;
    border-width: 3px;
    font-family: var(--font-body);
    font-size: 14px;
    letter-spacing: 0;
    color: var(--text);
  }
  .option.bring {
    background: linear-gradient(180deg, var(--cream) 0%, #f6d77c 100%);
    box-shadow: 0 4px 0 var(--wood-dark), 0 0 0 3px var(--gold-glow), inset 0 1px 0 rgba(255, 255, 255, 0.8);
  }
  .option.bring:hover:not(:disabled) {
    background: linear-gradient(180deg, #fff8d8 0%, #f8df93 100%);
  }
  .opt-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .opt-badge {
    display: grid;
    place-items: center;
    flex: none;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: 2px solid var(--wood-dark);
    background: var(--paper-hi);
    color: var(--wood);
  }
  .bring .opt-badge {
    background: var(--gold);
    color: var(--wood-dark);
  }
  .opt-title {
    font-family: var(--font-display);
    font-size: 18px;
    line-height: 1.15;
    color: var(--wood-dark);
  }
  .opt-where {
    display: grid;
    gap: 2px;
    padding: 6px 8px;
    border-radius: 8px;
    background: rgba(255, 252, 240, 0.55);
    border: 1.5px dashed rgba(107, 76, 46, 0.35);
    font-size: 12.5px;
  }
  .opt-where .place {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-display);
    font-size: 13px;
    color: var(--wood-dark);
  }
  .opt-where .goal {
    font-weight: 600;
    color: var(--text-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .opt-list {
    display: grid;
    gap: 6px;
  }
  .li {
    display: grid;
    grid-template-columns: 20px 1fr;
    gap: 6px;
    align-items: start;
    line-height: 1.4;
  }
  .ic {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    margin-top: 1px;
    border-radius: 50%;
  }
  .ic.ok {
    background: var(--accent);
    color: #fff;
  }
  .ic.ember {
    color: var(--ember-deep);
  }
  .ic.heart {
    color: var(--hp);
  }
  .ic.home {
    color: var(--wood);
  }
  .later {
    margin-left: 6px;
    padding: 2px 10px;
    font-size: 13px;
  }
  @media (max-width: 620px) {
    .options {
      grid-template-columns: 1fr;
    }
  }
</style>
