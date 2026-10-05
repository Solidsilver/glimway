<script lang="ts">
  import { onMount } from 'svelte'
  import type { Session } from '../game/session'
  import { VILLAGE_EV, villageFor } from '../game/village'
  import { bus } from '../game/events'
  import { calendarLine, contributionLimits, FESTIVAL_NOTES, nextFestival, projectProgress, turningNotice } from '../lib/village'
  import { ELARA_SIGNATURE, PROJECTS_NEED_WORLD, PROJECTS_OFFLINE, projectNotice } from '../content/village-notices'
  import { MATERIALS } from '../content/expansion-writing'
  import { paperById, paperFlag } from '../content/papers'
  import type { ProjectView } from '../lib/api/types'
  import { focusTrap } from './focus'
  import Icon from './Icon.svelte'

  // A notice board (Hearthwick or the Commons): Elara's Turning notice, the
  // festivals, and the world's village projects, which you can give to.
  let { session, onClose }: { session: Session; onClose: () => void } = $props()

  const village = $derived(villageFor(session))
  let version = $state(0)
  let give = $state<Record<string, Record<string, number>>>({})
  let busy = $state<string | null>(null)
  let messages = $state<Record<string, { text: string; kind: 'ok' | 'error' }>>({})

  onMount(() => {
    const bump = () => (version += 1)
    bus.on(VILLAGE_EV.changed, bump)
    if (session.link) {
      void village.loadProjects()
      void village.loadMail() // carried counts
    }
    return () => bus.off(VILLAGE_EV.changed, bump)
  })

  const view = $derived.by(() => {
    void version
    const now = village.now()
    const day = village.calendar
    return {
      day,
      turning: turningNotice(day, now),
      next: nextFestival(now),
      projects: village.projects,
      status: village.projectsStatus,
      carried: village.inventory?.materials ?? {},
      connected: !!session.link,
    }
  })

  const matName = (id: string) => MATERIALS.find((m) => m.id === id)?.name ?? id
  const when = (unix: number) => new Date(unix * 1000).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })

  function amount(p: ProjectView, m: string): number {
    return give[p.id]?.[m] ?? 0
  }

  function setAmount(p: ProjectView, m: string, n: number): void {
    const max = contributionLimits(p, view.carried)[m] ?? 0
    const next = Math.max(0, Math.min(max, Math.round(n) || 0))
    give = { ...give, [p.id]: { ...(give[p.id] ?? {}), [m]: next } }
  }

  async function contribute(p: ProjectView): Promise<void> {
    if (busy) return
    const materials = give[p.id] ?? {}
    busy = p.id
    const r = await village.contribute(p.id, materials)
    busy = null
    if (r.ok) {
      give = { ...give, [p.id]: {} }
      const total = Object.values(materials).reduce((a, b) => a + b, 0)
      messages = { ...messages, [p.id]: { text: r.value.completed ? `Finished! ${projectNotice(p.id).complete}` : `Thank you: ${total} given. Mara writes it in the ledger.`, kind: 'ok' } }
    } else {
      messages = { ...messages, [p.id]: { text: r.text, kind: 'error' } }
    }
  }

  const heldPapers = (p: ProjectView) => p.grantablePapers.filter((id) => session.state.flags.includes(paperFlag(id)))
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="board-title">
  <div class="panel" use:focusTrap>
    <button type="button" class="modal-close" onclick={onClose} aria-label="Close the notice board"><Icon name="close" size={14} /></button>
    <h2 class="panel-title" id="board-title"><Icon name="scroll" size={20} /> Notice Board</h2>
    <p class="today" data-testid="board-date">{calendarLine(view.day)}</p>

    <section aria-label="Notices">
      <div class="notice" class:soon={view.turning.soon} data-testid="turning-notice">
        <span class="pin" aria-hidden="true"></span>
        <p class="hand">{view.turning.text}</p>
        <p class="sig">{ELARA_SIGNATURE}</p>
      </div>
      {#if view.day.festival}
        <div class="notice festive">
          <span class="pin" aria-hidden="true"></span>
          <p class="hand"><b>{view.day.festival}.</b> {FESTIVAL_NOTES[view.day.festival]}</p>
        </div>
      {:else if view.next}
        <div class="notice small">
          <span class="pin" aria-hidden="true"></span>
          <p class="hand"><b>{view.next.name}</b> falls on {view.next.day.wick}-wick, day {view.next.day.day} ({when(view.next.at)}).</p>
        </div>
      {/if}
    </section>

    <h3 class="section-title">Village projects</h3>
    {#if !view.connected}
      <p class="msg">{PROJECTS_NEED_WORLD}</p>
    {:else if view.status === 'offline'}
      <p class="msg">{PROJECTS_OFFLINE}</p>
    {:else if view.status === 'loading' && version === 0}
      <p class="msg">Mara is finding the ledger page…</p>
    {/if}
    {#if view.connected}
      <p class="carried" aria-live="polite">
        You carry:
        {#each MATERIALS as m (m.id)}<span>{view.carried[m.id] ?? 0} {m.name.toLowerCase()}</span>{/each}
      </p>
    {/if}
    <ul class="projects">
      {#each view.projects as p (p.id)}
        {@const n = projectNotice(p.id)}
        {@const limits = contributionLimits(p, view.carried)}
        {@const giving = Object.values(give[p.id] ?? {}).reduce((a, b) => a + b, 0)}
        <li class="project" class:done={p.stage === 'complete'} data-project={p.id}>
          <div class="ph">
            <span class="name">{p.name}</span>
            <span class="stage {p.stage}">{p.stage === 'complete' ? 'Done' : p.stage === 'open' ? 'Open' : 'Under way'}</span>
          </div>
          <p class="say">“{p.stage === 'complete' ? n.complete : p.stage === 'open' ? n.open : n.inProgress}” <span class="by">— {n.by}</span></p>
          <div class="bar" aria-label={`${Math.round(projectProgress(p) * 100)}% done`}><span style={`width:${projectProgress(p) * 100}%`}></span></div>
          <table class="mats">
            <tbody>
              {#each Object.keys(p.required) as m (m)}
                <tr>
                  <th scope="row">{matName(m)}</th>
                  <td class="num">{p.contributed[m] ?? 0} / {p.required[m]}</td>
                  <td class="mine">{#if (p.mine[m] ?? 0) > 0}you: {p.mine[m]}{/if}</td>
                  {#if view.connected && p.stage !== 'complete'}
                    <td class="step">
                      <button type="button" class="tiny" aria-label={`Less ${matName(m)}`} disabled={amount(p, m) <= 0} onclick={() => setAmount(p, m, amount(p, m) - 5)}>−</button>
                      <input type="number" inputmode="numeric" min="0" max={limits[m]} value={amount(p, m)} aria-label={`${matName(m)} to give`} data-give={`${p.id}:${m}`} oninput={(e) => setAmount(p, m, Number((e.currentTarget as HTMLInputElement).value))} />
                      <button type="button" class="tiny" aria-label={`More ${matName(m)}`} disabled={amount(p, m) >= limits[m]} onclick={() => setAmount(p, m, amount(p, m) + 5)}>+</button>
                      <button type="button" class="tiny max" disabled={limits[m] <= 0} onclick={() => setAmount(p, m, limits[m])}>All</button>
                    </td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
          {#if view.connected && p.stage !== 'complete'}
            <div class="act">
              <button type="button" class="primary small" data-contribute={p.id} disabled={busy !== null || giving <= 0} onclick={() => contribute(p)}>
                {busy === p.id ? 'Giving…' : giving > 0 ? `Give ${giving}` : 'Give'}
              </button>
            </div>
          {/if}
          {#if p.stage === 'complete' && heldPapers(p).length}
            <p class="papers"><Icon name="scroll" size={12} /> In your journal: {heldPapers(p).map((id) => paperById(id)?.title ?? id).join(', ')}</p>
          {/if}
          {#if messages[p.id]}<p class="msg {messages[p.id].kind}" role="status">{messages[p.id].text}</p>{/if}
        </li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .today {
    margin: -4px 0 10px;
    font-style: italic;
    color: var(--text-soft);
  }
  .notice {
    position: relative;
    margin: 0 0 8px;
    padding: 10px 12px 8px;
    background: #fffbef;
    border: 1.5px solid var(--paper-line);
    border-radius: 3px;
    box-shadow: 2px 3px 0 rgba(74, 50, 32, 0.18);
    transform: rotate(-0.4deg);
  }
  .notice.soon {
    border-color: var(--ember);
    background: #fff3e6;
  }
  .notice.festive {
    background: #fff6d6;
    transform: rotate(0.5deg);
  }
  .notice.small {
    transform: rotate(0.3deg);
  }
  .pin {
    position: absolute;
    top: -5px;
    left: 50%;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--danger);
    border: 1.5px solid var(--wood-dark);
  }
  .hand {
    margin: 0;
    font-size: 14.5px;
    color: var(--wood-dark);
  }
  .sig {
    margin: 4px 0 0;
    text-align: right;
    font-size: 12.5px;
    font-style: italic;
    color: var(--text-soft);
  }
  .section-title {
    text-transform: none;
    letter-spacing: 0.04em;
    font-size: 15px;
    margin-top: 14px;
  }
  .carried {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    margin: 0 0 8px;
    font-size: 13px;
    color: var(--text-soft);
  }
  .carried span {
    font-weight: 800;
    color: var(--wood-dark);
  }
  .projects {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .project {
    padding: 9px 10px;
    border-radius: 9px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.25);
  }
  .project.done {
    border-color: rgba(47, 127, 122, 0.5);
    background: rgba(92, 176, 168, 0.12);
  }
  .ph {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: baseline;
  }
  .name {
    font-weight: 800;
    color: var(--wood-dark);
  }
  .stage {
    flex: none;
    font-family: var(--font-display);
    font-size: 12px;
    padding: 0 7px;
    border-radius: 999px;
    border: 1.5px solid var(--paper-line);
  }
  .stage.complete {
    border-color: var(--accent);
    color: var(--accent);
  }
  .stage.in-progress {
    border-color: var(--gold-deep);
    color: var(--ember-deep);
  }
  .say {
    margin: 4px 0 6px;
    font-size: 13.5px;
    color: var(--text-soft);
    line-height: 1.4;
  }
  .by {
    font-style: italic;
    white-space: nowrap;
  }
  .bar {
    height: 8px;
    border-radius: 999px;
    background: rgba(107, 76, 46, 0.15);
    border: 1.5px solid var(--wood);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--gold-deep), var(--gold));
  }
  .done .bar span {
    background: linear-gradient(90deg, var(--accent), #5cb0a8);
  }
  .mats {
    width: 100%;
    margin-top: 6px;
    border-collapse: collapse;
    font-size: 13.5px;
  }
  .mats th {
    text-align: left;
    font-weight: 700;
    color: var(--wood-dark);
    padding: 2px 4px 2px 0;
  }
  .num {
    white-space: nowrap;
  }
  .mine {
    font-size: 12px;
    color: var(--accent);
    white-space: nowrap;
  }
  .step {
    text-align: right;
    white-space: nowrap;
  }
  .step input {
    width: 3.6em;
    padding: 3px 4px;
    font: inherit;
    text-align: center;
    border: 1.5px solid var(--wood);
    border-radius: 6px;
    background: #fffbef;
  }
  .tiny {
    min-width: 30px;
    min-height: 30px;
    padding: 0 6px;
    font-size: 14px;
  }
  .max {
    font-size: 12px;
  }
  .act {
    display: flex;
    justify-content: flex-end;
    margin-top: 6px;
  }
  .small {
    padding: 5px 14px;
    font-size: 14px;
  }
  .papers {
    margin: 6px 0 0;
    font-size: 13px;
    color: var(--accent);
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .msg {
    margin: 8px 0 0;
    padding: 7px 10px;
    border-radius: 8px;
    font-size: 13.5px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.4);
  }
  .msg.error {
    border-color: rgba(196, 82, 58, 0.6);
  }
  .msg.ok {
    border-color: rgba(47, 127, 122, 0.55);
  }
  @media (max-width: 480px) {
    .mats tr {
      display: grid;
      grid-template-columns: 1fr auto auto;
    }
    .step {
      grid-column: 1 / -1;
      text-align: left;
    }
  }
</style>
