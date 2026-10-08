<script lang="ts">
  import type { Session } from '../game/session'
  import { pinned, questContext, setPinned } from '../game/guide-pin'
  import { journalEntries } from '../content/world'
  import { bus, EV } from '../game/events'
  import { questShelves, type QuestCard } from './quests-page'
  import { ui } from './store.svelte'
  import { home } from './home.svelte'
  import ArtIcon from './ArtIcon.svelte'
  import Icon from './Icon.svelte'

  /**
   * The Quests page (docs/design/indoors.md 5.4): the road, the village and
   * crafts as shelves; each quest you've come across as a card with its next
   * step, the steps reached and the rest kept back. Pin one, and the goal
   * line and its needle lead to its next step. Then the notes, newest first.
   */
  let { session, focus = null }: { session: Session; focus?: string | null } = $props()

  // Quests move under the page (a step reached, a wait opening): re-read now and then.
  let tick = $state(0)
  $effect(() => {
    const t = setInterval(() => (tick += 1), 1000)
    return () => clearInterval(t)
  })
  let slot = $state(pinned.slot)
  $effect(() => {
    const onPin = (p: { id: string | null }) => (slot = p.id)
    bus.on(EV.guidePin, onPin)
    return () => {
      bus.off(EV.guidePin, onPin)
    }
  })
  const shelves = $derived.by(() => {
    void tick
    void ui.quest
    const ctx = questContext(session)
    return questShelves(session.quests, { needs: ctx.needs, gate: ctx.gate, pinned: slot, focus })
  })
  // Open on the quest asked for, else the pinned one, else the first open card.
  let open = $state<string | null>(null)
  $effect.pre(() => {
    open = focus ?? (slot?.startsWith('quest:') ? slot.slice(6) : null)
  })
  const firstOpen = $derived(shelves.flatMap((s) => s.open).find((c) => c.status === 'open')?.id ?? null)
  const isOpen = (c: QuestCard) => (open ?? firstOpen) === c.id

  // Newest first: the latest page is what the player wants to read.
  const entries = $derived.by(() => {
    void ui.quest
    return [...journalEntries(session.quests, ui.residentsMet)].reverse()
  })
  const illustration = $derived(
    ui.area.areaId === 'ruin' ? '/assets/fingersnap/packed/fingersnap-shrine.webp' : '/assets/fingersnap/packed/fingersnap-village.webp'
  )
  const lead = $derived(ui.goalLine.quest ? { eyebrow: ui.goalLine.quest.title, text: ui.goalLine.quest.objective } : { eyebrow: ui.quest.stage === 'complete' && !ui.quest.short ? 'All done' : 'Current goal', text: ui.quest.objective })

  const SHELF_ICONS: Record<string, { art: string; name: string }> = {
    road: { art: 'shelf-icon-road', name: 'lantern' },
    village: { art: 'shelf-icon-village', name: 'home' },
    craft: { art: 'shelf-icon-craft', name: 'tools' }
  }

  function togglePin(id: string): void {
    setPinned(slot === `quest:${id}` ? null : `quest:${id}`)
  }
</script>

<div class="quests">
  <div class="hero">
    <img src={illustration} alt="" />
    <div class="goal">
      <span class="eyebrow">{lead.eyebrow}</span>
      <span class="text">{lead.text}</span>
    </div>
  </div>
  {#if home.goal}
    <div class="home-goal" data-testid="journal-home-goal">
      <span class="eyebrow"><Icon name="home" size={12} /> Your homestead</span>
      <span class="text">{home.goal}</span>
    </div>
  {/if}

  {#each shelves as shelf (shelf.line)}
    <section class="shelf" data-shelf={shelf.line} aria-labelledby={`shelf-${shelf.line}`}>
      <h3 class="section-title" id={`shelf-${shelf.line}`}>
        <ArtIcon art={SHELF_ICONS[shelf.line].art} name={SHELF_ICONS[shelf.line].name} size={16} />
        {shelf.title}
      </h3>
      {#each shelf.open as c (c.id)}
        {@const expanded = isOpen(c)}
        <article class="quest" class:pinned={c.pinned} class:locked={c.status === 'locked'} data-quest={c.id}>
          <button type="button" class="head" aria-expanded={expanded} aria-controls={`quest-${c.id}`} onclick={() => (open = expanded ? '' : c.id)}>
            <span class="state" aria-hidden="true">
              {#if c.status === 'locked'}<ArtIcon art="gate-locked" name="key" size={14} />{:else if c.pinned}<ArtIcon art="pin-pinned" name="pin" size={14} />{:else}<Icon name="scroll" size={12} />{/if}
            </span>
            <span class="title">{c.title}</span>
            {#if c.pinned}<span class="badge">Pinned</span>{/if}
          </button>
          <div class="sub">
            {#if c.status === 'locked'}
              <p class="lockline">{c.locked}</p>
            {:else if c.goal}
              <p class="goalline">{c.goal}{#if c.wait}<span class="wait"> · <ArtIcon art="gate-waiting" name="clock" size={12} /> {c.wait}</span>{/if}</p>
            {/if}
          </div>
          {#if expanded}
            <div class="body" id={`quest-${c.id}`}>
              <p class="blurb">{c.blurb}</p>
              {#if c.status === 'open'}
                <ol class="steps">
                  {#each c.reached as step, i (i)}
                    <li class="done"><span class="dot" aria-hidden="true"><Icon name="check" size={10} /></span><span>{step}</span><span class="sr"> (done)</span></li>
                  {/each}
                  <li class="now" aria-current="step"><span class="dot" aria-hidden="true">•</span><span>{c.objective}</span></li>
                  {#if c.later > 0}
                    <li class="later" aria-label="More to come"><span class="dot" aria-hidden="true"></span><span aria-hidden="true">· · ·</span></li>
                  {/if}
                </ol>
                <!-- The label says what a press does (no pressed state on top of it). -->
                <button type="button" class="pin" class:primary={!c.pinned} onclick={() => togglePin(c.id)} data-testid={`pin-quest-${c.id}`}>
                  <ArtIcon art={c.pinned ? 'pin-pinned' : 'pin-unpinned'} name="pin" size={12} /> {c.pinned ? 'Unpin' : 'Pin as my goal'}
                </button>
              {/if}
            </div>
          {/if}
        </article>
      {/each}
      {#each shelf.done as c (c.id)}
        <p class="doneline" data-quest={c.id}><Icon name="check" size={12} /> {c.title} <span class="faint">(done)</span></p>
      {/each}
    </section>
  {/each}

  <h3 class="section-title">Notes</h3>
  {#each entries as entry, i (entry.title + '\n' + entry.body)}
    <article class="note" class:latest={i === 0}>
      <h4>{entry.title}</h4>
      <p>{entry.body}</p>
    </article>
  {/each}
</div>

<style>
  .quests {
    display: grid;
    gap: 8px;
  }
  .hero {
    position: relative;
    border: 3px solid var(--wood-dark);
    border-radius: 10px;
    overflow: hidden;
  }
  .hero img {
    display: block;
    width: 100%;
    height: 150px;
    object-fit: cover;
  }
  :global(:root.touch) .hero img {
    height: 110px;
  }
  .goal {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 28px 14px 10px;
    display: grid;
    gap: 2px;
    background: linear-gradient(180deg, transparent, rgba(20, 12, 16, 0.85));
    color: #fff6dc;
  }
  .goal .eyebrow {
    font-family: var(--font-display);
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--gold);
  }
  .goal .text {
    font-size: 15px;
    font-weight: 700;
    line-height: 1.35;
  }
  .home-goal {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    border: 2px dashed var(--paper-line);
    border-radius: 8px;
    background: #fff8e4;
  }
  .home-goal .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.75;
  }
  .shelf {
    display: grid;
    gap: 8px;
  }
  .section-title {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .quest {
    border: 2px solid var(--paper-line);
    border-radius: 10px;
    background: rgba(255, 252, 240, 0.6);
  }
  .quest.pinned {
    border-color: var(--gold-deep);
    box-shadow: 0 0 0 2px var(--gold-glow);
  }
  .quest.locked {
    opacity: 0.8;
    border-style: dashed;
  }
  .head {
    all: unset;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 44px;
    padding: 8px 12px 2px;
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
  .pinned .state {
    background: linear-gradient(180deg, #fff3b8, #f5cf5c);
  }
  .title {
    flex: 1;
    min-width: 0;
  }
  .badge {
    font-family: var(--font-body, inherit);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--gold-deep);
  }
  .sub {
    padding: 0 12px 8px 42px;
  }
  .goalline,
  .lockline {
    margin: 0;
    font-size: 13.5px;
    color: var(--text-soft);
  }
  .wait {
    white-space: nowrap;
    color: var(--wood);
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
  .steps li.later {
    color: var(--text-faint);
    letter-spacing: 0.2em;
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
  .later .dot {
    visibility: hidden;
  }
  .pin {
    min-height: 40px;
  }
  .doneline {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 4px 12px;
    font-size: 13.5px;
    color: var(--text-soft);
  }
  .faint {
    color: var(--text-faint);
  }
  .note {
    padding: 10px 12px;
    border-left: 3px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.3);
    border-radius: 0 8px 8px 0;
  }
  .note.latest {
    border-left-color: var(--gold-deep);
    background: rgba(255, 233, 160, 0.35);
  }
  .note h4 {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 16px;
    color: var(--wood-dark);
  }
  .note p {
    margin: 0;
    font-size: 14.5px;
    line-height: 1.55;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
