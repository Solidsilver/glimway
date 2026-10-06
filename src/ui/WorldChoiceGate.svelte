<script lang="ts">
  import type { WorldChoice } from '../lib/api/types'
  import { firstWorldCopy as copy } from '../content/world-moves'
  import { focusTrap } from './focus'
  import Icon from './Icon.svelte'

  /**
   * First sign-in for a newcomer whose party has a world here, or may open
   * one: join the party's world, or start one of their own. The sign-in is
   * already done (the server holds it); only the world waits. Asked again on
   * the next visit until answered.
   */
  let {
    choice,
    busy,
    error,
    picked = null,
    onChoose,
    onCancel
  }: {
    choice: WorldChoice
    busy: boolean
    error: string
    picked?: 'party' | 'own' | null
    onChoose: (choice: 'party' | 'own') => void
    onCancel?: () => void
  } = $props()

  const open = $derived(!choice.partyWorld)
  const members = $derived(choice.partyWorld?.members ?? 0)
  const partyOffered = $derived(!!choice.partyWorld || choice.partyCanOpen)
  /** Up to five figures for the travelers already there. */
  const figures = $derived(Math.min(members, 5))
</script>

<div class="overlay gate" role="dialog" aria-modal="true" aria-labelledby="world-choice-title" aria-busy={busy} data-testid="world-choice">
  <div class="panel gate-panel wide" use:focusTrap>
    <p class="gate-eyebrow"><Icon name="world" size={14} /> {copy.eyebrow}</p>
    <h2 class="gate-title" id="world-choice-title">{copy.title(choice.displayName)}</h2>
    <p class="gate-lead">{partyOffered ? copy.lead(open) : copy.partyGone}</p>

    <div class="options" class:single={!partyOffered}>
      {#if partyOffered}
        <button type="button" class="option party" class:picked={picked === 'party'} onclick={() => onChoose('party')} disabled={busy} data-testid="world-choice-party">
          <span class="opt-head">
            <span class="opt-badge"><Icon name="lantern" size={16} /></span>
            <span class="opt-title">{copy.party.label(open)}</span>
          </span>
          <span class="opt-where" class:empty={members === 0}>
            <span class="folk" aria-hidden="true">
              {#each Array.from({ length: Math.max(1, figures) }) as _, i}
                <span class="fig" class:ghost={members === 0} style={`--i:${i}`}><Icon name="person" size={14} /></span>
              {/each}
              {#if members > 5}<span class="more">+{members - 5}</span>{/if}
            </span>
            <span class="count">{open ? copy.party.first : copy.party.who(members)}</span>
          </span>
          <span class="opt-list">
            <span class="li"><span class="ic ok"><Icon name="check" size={11} /></span>{copy.party.straightIn}</span>
            <span class="li"><span class="ic home"><Icon name="home" size={12} /></span>{copy.party.belongs}</span>
          </span>
        </button>
      {/if}

      <button type="button" class="option own" class:picked={picked === 'own'} onclick={() => onChoose('own')} disabled={busy} data-testid="world-choice-own">
        <span class="opt-head">
          <span class="opt-badge"><Icon name="sparkle" size={16} /></span>
          <span class="opt-title">{copy.own.label}</span>
        </span>
        <span class="opt-list">
          <span class="li"><span class="ic ok"><Icon name="check" size={11} /></span>{copy.own.yours}</span>
          <span class="li"><span class="ic home"><Icon name="key" size={12} /></span>{copy.own.friends}</span>
          {#if partyOffered}<span class="li"><span class="ic home"><Icon name="world" size={12} /></span>{copy.own.later}</span>{/if}
        </span>
      </button>
    </div>

    {#if error}<p class="gate-error" role="alert">{error}</p>{/if}
    {#if busy}
      <p class="gate-status" role="status"><span class="gate-spinner" aria-hidden="true"></span> {copy.working}</p>
    {:else}
      <p class="gate-fine">
        {copy.note}
        {#if onCancel}<button type="button" class="ghost later" onclick={onCancel}>{copy.later}</button>{/if}
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
  .options.single {
    grid-template-columns: 1fr;
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
  .option.party {
    background: linear-gradient(180deg, #fff3c2 0%, #f6d77c 100%);
    box-shadow: 0 4px 0 var(--wood-dark), 0 0 0 3px rgba(255, 210, 74, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.8);
  }
  .option.party:hover:not(:disabled) {
    background: linear-gradient(180deg, #fff8d8 0%, #f8df93 100%);
  }
  .option.picked {
    outline: 3px solid var(--gold-deep);
    outline-offset: 2px;
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
  .party .opt-badge {
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
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 8px;
    background: rgba(255, 252, 240, 0.55);
    border: 1.5px dashed rgba(107, 76, 46, 0.35);
    font-size: 12.5px;
  }
  .folk {
    display: inline-flex;
    align-items: center;
    flex: none;
  }
  .fig {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    margin-left: -5px;
    border-radius: 50%;
    border: 2px solid var(--wood-dark);
    background: var(--paper-hi);
    color: var(--wood);
  }
  .fig:first-child {
    margin-left: 0;
  }
  .fig.ghost {
    border-style: dashed;
    background: transparent;
    color: rgba(107, 76, 46, 0.5);
  }
  .more {
    margin-left: 4px;
    font-family: var(--font-display);
    font-size: 12px;
    color: var(--wood-dark);
  }
  .count {
    font-family: var(--font-display);
    font-size: 13px;
    line-height: 1.3;
    color: var(--wood-dark);
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
