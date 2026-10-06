<script lang="ts">
  import type { Session } from '../game/session'
  import { guideContext, pinned, setPinned } from '../game/guide-pin'
  import { allGuides } from '../lib/guides'
  import { ui } from './store.svelte'
  import Icon from './Icon.svelte'

  /**
   * "How do I…?": the guides, each with its steps ticking themselves off.
   * One can be pinned: the HUD's goal line, the needle and the edge glow
   * then lead to its next step (src/game/entities/goal-guide.ts).
   */
  let { session }: { session: Session } = $props()

  // The models change under the panel (a tool made, a deed signed): re-read now and then.
  let tick = $state(0)
  $effect(() => {
    const t = setInterval(() => (tick += 1), 1000)
    return () => clearInterval(t)
  })
  const guides = $derived.by(() => {
    void tick
    void ui.goalLine
    return allGuides(guideContext(session))
  })
  let pinnedId = $state(pinned.id)
  let open = $state<string | null>(pinned.id)

  function togglePin(id: string): void {
    const next = pinnedId === id ? null : id
    setPinned(next)
    pinnedId = next
  }
</script>

<div class="guides">
  <p class="lead">Pin one, and your goal line and its needle lead the way.</p>
  {#each guides as g (g.guide.id)}
    {@const isOpen = open === g.guide.id}
    {@const isPinned = pinnedId === g.guide.id}
    <article class="guide" class:done={g.done} class:pinned={isPinned} data-guide={g.guide.id}>
      <button type="button" class="head" aria-expanded={isOpen} onclick={() => (open = isOpen ? null : g.guide.id)}>
        <span class="state" aria-hidden="true">
          {#if g.done}<Icon name="check" size={12} />{:else if isPinned}<Icon name="star" size={12} />{:else}<Icon name="scroll" size={12} />{/if}
        </span>
        <span class="title">{g.guide.title}</span>
        {#if !g.done && !g.locked}<span class="count">{g.steps.filter((s) => s.done).length}/{g.steps.length}</span>{/if}
      </button>
      {#if isOpen}
        <div class="body">
          <p class="blurb">{g.guide.blurb}</p>
          {#if g.locked}
            <p class="locked"><Icon name="lantern" size={12} /> This needs a world to keep it. Sign in from the Menu.</p>
          {:else}
            <ol class="steps">
              {#each g.steps as st, i}
                <li class:done={st.done} class:now={i === g.current}>
                  <span class="dot" aria-hidden="true">{#if st.done}<Icon name="check" size={10} />{:else}{i + 1}{/if}</span>
                  <span>{st.text}</span>
                  {#if st.done}<span class="sr"> (done)</span>{/if}
                </li>
              {/each}
            </ol>
            {#if !g.done}
              <button type="button" class="pin" class:primary={!isPinned} aria-pressed={isPinned} onclick={() => togglePin(g.guide.id)} data-testid={`pin-${g.guide.id}`}>
                <Icon name="star" size={12} /> {isPinned ? 'Unpin' : 'Pin as my goal'}
              </button>
            {:else}
              <p class="donenote">Done.</p>
            {/if}
          {/if}
        </div>
      {/if}
    </article>
  {/each}
</div>

<style>
  .guides {
    display: grid;
    gap: 8px;
  }
  .lead {
    margin: 2px 0 4px;
    font-size: 13px;
    color: var(--text-soft);
  }
  .guide {
    border: 2px solid var(--paper-line);
    border-radius: 10px;
    background: rgba(255, 252, 240, 0.6);
  }
  .guide.pinned {
    border-color: var(--gold-deep);
    box-shadow: 0 0 0 2px rgba(255, 210, 74, 0.35);
  }
  .guide.done {
    opacity: 0.75;
  }
  .head {
    all: unset;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 44px;
    padding: 8px 12px;
    cursor: pointer;
    font-family: var(--font-display);
    font-size: 15px;
    color: var(--wood-dark);
  }
  .head:focus-visible {
    outline: 3px solid var(--gold);
    border-radius: 8px;
  }
  .state {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    flex: none;
    border-radius: 50%;
    border: 1.5px solid var(--wood);
    color: var(--wood-dark);
    background: var(--paper-hi);
  }
  .done .state {
    background: #b9d7a5;
  }
  .pinned .state {
    background: linear-gradient(180deg, #fff3b8, #f5cf5c);
  }
  .title {
    flex: 1;
    min-width: 0;
  }
  .count {
    font-size: 12px;
    color: var(--text-faint);
  }
  .body {
    padding: 0 12px 12px 42px;
  }
  .blurb {
    margin: 0 0 8px;
    font-size: 13.5px;
    font-style: italic;
    color: var(--text-soft);
  }
  .steps {
    list-style: none;
    margin: 0 0 10px;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .steps li {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    font-size: 14px;
    line-height: 1.35;
    color: var(--text-soft);
  }
  .steps li.now {
    color: var(--text);
    font-weight: 700;
  }
  .steps li.done {
    color: var(--text-faint);
    text-decoration: line-through;
    text-decoration-color: rgba(110, 90, 68, 0.4);
  }
  .dot {
    flex: none;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    margin-top: 1px;
    border-radius: 50%;
    font-family: var(--font-display);
    font-size: 11px;
    border: 1.5px solid var(--paper-line);
    background: var(--paper-hi);
  }
  .now .dot {
    border-color: var(--gold-deep);
    background: #fff3b8;
  }
  .pin {
    min-height: 40px;
  }
  .locked,
  .donenote {
    margin: 0;
    font-size: 13px;
    color: var(--text-soft);
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
