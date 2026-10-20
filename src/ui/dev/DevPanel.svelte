<script lang="ts">
  import type { Session } from '../../game/session'
  import type { DevTools } from '../../lib/web-settings'
  import { DEV_LOCAL } from '../../lib/dev-tools'
  import { actionRunner } from '../panel-state.svelte'
  import Panel from '../Panel.svelte'
  import ArtIcon from '../ArtIcon.svelte'
  import Icon from '../Icon.svelte'
  import Glim from '../Glim.svelte'
  import { clampCount, everyMaterial, GLIMS_GRANT_ID, grantables, searchGrantables, type Grantable } from './grantables'
  import { devGrant, type GrantRequest } from './dev-grant'
  import { CLOCK_STEPS, devClockAdvance } from './dev-clock'
  import { loadTimingsText } from '../loading.svelte'
  import LabSection from '../../game/height-lab/LabSection.svelte'

  // Dev mode: give this account Glimway's own things through the dev
  // server's grant route, and move the server's clock. Only builds with dev
  // tools load this panel (App, behind DEV_TOOLS), and it shows only the
  // tools the server gives this player (`tools`; the Vite dev server: every
  // grant, and the clock when the server's is movable). Never anything from
  // Habitica.
  let { session, tools, onClose }: { session: Session; tools: DevTools | null; onClose: () => void } = $props()

  const action = actionRunner()
  const all = grantables()
  let query = $state('')
  let counts = $state<Record<string, number>>({})
  const shown = $derived(searchGrantables(all, query))
  /** The clock step waiting for its confirm. */
  let asked = $state<(typeof CLOCK_STEPS)[number] | null>(null)

  /** Text fields keep their keys from the game (Phaser listens for WASD, E…). */
  const keepKeys = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') e.stopPropagation()
  }

  const countOf = (g: Grantable) => clampCount(g, counts[g.id] ?? (g.kind === 'glims' ? 100 : g.kind === 'instance' || g.kind === 'decoration' ? 1 : 10))
  const said = (granted: GrantRequest[]) =>
    granted.length === 1 ? `Given: ${granted[0].qty} × ${all.find((g) => g.id === granted[0].id)?.name ?? granted[0].id}.` : `Given: ${granted.length} things.`

  function give(id: string, grants: GrantRequest[]): void {
    void action.run(id, () => devGrant(session, grants), (r) => said(r.granted))
  }

  function moveClock(step: (typeof CLOCK_STEPS)[number]): void {
    asked = null
    void action.run(`clock:${step.id}`, () => devClockAdvance(step.seconds), (r) => `The server’s clock is now ${new Date(r.unix * 1000).toLocaleString()}. Reload to see the new time everywhere.`)
  }
</script>

<Panel id="dev" icon="key" title="Dev" closeLabel="Close dev mode" {onClose} message={action.message} messageTestId="dev-message" class="dev" data-testid="dev-panel">
  {#snippet head()}
    <p class="banner" data-testid="dev-banner"><Icon name="key" size={12} /> {DEV_LOCAL ? 'Dev mode (local only)' : 'Dev mode (this server)'}</p>
  {/snippet}
  <p class="lede">Playtesting tools on a dev server: Glimway’s own things for this account, and the server’s clock. Nothing here exists in a real build.</p>
  {#if tools?.clock}
    <section class="clock" data-testid="dev-clock">
      <h3 class="section-title"><Icon name="clock" size={14} /> The server’s clock</h3>
      {#if asked}
        <div class="confirm" role="alertdialog" aria-labelledby="dev-clock-ask" data-testid="dev-clock-confirm">
          <p id="dev-clock-ask">Move the clock forward {asked.label}? It moves for the whole world: every player on this server, at once. It can’t be moved back.</p>
          <button type="button" class="primary" disabled={action.busy !== null} onclick={() => asked && moveClock(asked)}>Move it {asked.label}</button>
          <button type="button" onclick={() => (asked = null)}>Cancel</button>
        </div>
      {:else}
        <div class="quick">
          {#each CLOCK_STEPS as step (step.id)}
            <button type="button" data-clock={step.id} disabled={action.busy !== null} onclick={() => (asked = step)}>+{step.label}</button>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
  {#if tools?.grant}
    <div class="quick">
      <button type="button" class="primary" data-testid="dev-glims" disabled={action.busy !== null} onclick={() => give('quick:glims', [{ id: GLIMS_GRANT_ID, qty: 100 }])}>
        <Glim size={14} /> +100 glims
      </button>
      <button type="button" data-testid="dev-materials" disabled={action.busy !== null} onclick={() => give('quick:materials', everyMaterial(99))}>
        <Icon name="stone" size={14} /> A stack of every material
      </button>
    </div>
    <label class="search">
      <span class="sr">Search</span>
      <input type="text" placeholder="Search: timber, axe, recipe…" autocomplete="off" spellcheck="false" bind:value={query} onkeydown={keepKeys} data-testid="dev-search" />
    </label>
    <ul class="things" data-testid="dev-list">
      {#each shown as g (g.id)}
        <li class="thing" data-grant={g.id}>
          <span class="thumb" aria-hidden="true"><ArtIcon art={g.art} name={g.icon} size={28} /></span>
          <span class="txt">
            <span class="name">{g.name}</span>
            <span class="what">{g.group} · up to {g.max.toLocaleString()}</span>
          </span>
          <span class="go">
            <input
              type="number"
              min="1"
              max={g.max}
              inputmode="numeric"
              aria-label={`How many ${g.name}`}
              value={countOf(g)}
              onkeydown={keepKeys}
              oninput={(e) => (counts = { ...counts, [g.id]: Number((e.currentTarget as HTMLInputElement).value) })}
            />
            <button type="button" class="small" data-give={g.id} disabled={action.busy !== null} onclick={() => give(`give:${g.id}`, [{ id: g.id, qty: countOf(g) }])}>
              {action.busy === `give:${g.id}` ? 'Giving…' : 'Give'}
            </button>
          </span>
        </li>
      {:else}
        <li class="none">Nothing called that.</li>
      {/each}
    </ul>
  {/if}
  <LabSection />
  <!-- The last loads, stage by stage (src/lib/load-timings.ts); the Menu copies the same text. -->
  <section class="timings" data-testid="dev-load-timings">
    <h3 class="section-title"><Icon name="clock" size={14} /> Load timings</h3>
    <pre>{loadTimingsText()}</pre>
  </section>
</Panel>

<style>
  .banner {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 4px 0 0;
    padding: 2px 10px;
    border-radius: 999px;
    border: 2px dashed var(--wood);
    background: #fde6b8;
    color: var(--wood-dark);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .clock {
    margin: 4px 0 12px;
  }
  .timings pre {
    margin: 0;
    max-height: 40vh;
    overflow: auto;
    font-size: 11px;
    white-space: pre-wrap;
    user-select: text;
  }
  .confirm {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 8px 10px;
    border-radius: 9px;
    border: 2px dashed var(--wood);
    background: #fde6b8;
  }
  .confirm p {
    flex: 1 1 100%;
    margin: 0;
    color: var(--wood-dark);
    font-weight: 700;
  }
  .quick {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 4px 0 10px;
  }
  .quick button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
  }
  .search {
    display: block;
    margin-bottom: 8px;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  input[type='text'],
  input[type='number'] {
    font: inherit;
    font-family: var(--font-body);
    font-size: 14px;
    padding: 8px 10px;
    border: 2px solid var(--wood);
    border-radius: 8px;
    background: var(--cream-hi);
    color: var(--text);
    user-select: text;
    -webkit-user-select: text;
  }
  input[type='text'] {
    width: 100%;
  }
  input[type='number'] {
    width: 5.5em;
    min-height: 40px;
  }
  .things {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .thing {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 10px;
    align-items: center;
    padding: 6px 9px;
    border-radius: 9px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.28);
  }
  .thumb {
    flex: none;
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: var(--wood-wash);
    color: var(--wood);
  }
  .txt {
    flex: 1 1 140px;
    min-width: 0;
    display: grid;
  }
  .name {
    font-weight: 800;
    color: var(--wood-dark);
  }
  .what {
    font-size: 12px;
    color: var(--accent);
  }
  .go {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-left: auto;
  }
  .small {
    padding: 5px 14px;
    font-size: 14px;
    min-height: 40px;
  }
  .none {
    padding: 8px;
    color: var(--text-soft);
  }
</style>
