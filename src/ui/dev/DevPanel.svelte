<script lang="ts">
  import type { Session } from '../../game/session'
  import type { DevTools } from '../../lib/web-settings'
  import { DEV_LOCAL } from '../../lib/dev-tools'
  import { actionRunner } from '../panel-state.svelte'
  import Panel from '../Panel.svelte'
  import ArtIcon from '../ArtIcon.svelte'
  import Icon from '../Icon.svelte'
  import Glim from '../Glim.svelte'
  import DevSection from './DevSection.svelte'
  import { clampCount, everyMaterial, GLIMS_GRANT_ID, grantables, grantGroups, searchGrantables, type Grantable } from './grantables'
  import { devGrant, type GrantRequest } from './dev-grant'
  import { CLOCK_STEPS, devClockAdvance } from './dev-clock'
  import { loadDevPrefs, saveDevPrefs, withRecent, type DevSection as SectionId } from './dev-prefs'
  import { loadTimingsText } from '../loading.svelte'
  import LabSection from '../../game/height-lab/LabSection.svelte'
  import { inLab } from '../../game/height-lab/look'

  // Dev mode: give this account Glimway's own things through the dev
  // server's grant route, and move the server's clock. Only builds with dev
  // tools load this panel (App, behind DEV_TOOLS), and it shows only the
  // tools the server gives this player (`tools`; the Vite dev server: every
  // grant, and the clock when the server's is movable). Never anything from
  // Habitica.
  //
  // `docked` (desktop): a column at the right of the screen beside the game,
  // which stays playable: no backdrop, no focus trap, and keys reach the
  // game unless a field has focus. Otherwise (phones): the shared sheet.
  // Its sections fold, and which are open is kept on this device.
  let { session, tools, docked = false, onClose, onWorldLab }: { session: Session; tools: DevTools | null; docked?: boolean; onClose: () => void; onWorldLab?: () => void } = $props()

  const action = actionRunner()
  const all = grantables()
  const groups = grantGroups(all)
  const prefs = loadDevPrefs()
  let open = $state(prefs.sections)
  let recent = $state(prefs.recent)
  let query = $state('')
  let group = $state('')
  let counts = $state<Record<string, number>>({})
  const shown = $derived(searchGrantables(group ? all.filter((g) => g.group === group) : all, query))
  const recentShown = $derived(recent.map((id) => all.find((g) => g.id === id)).filter((g): g is Grantable => !!g))
  /** The clock step waiting for its confirm. */
  let asked = $state<(typeof CLOCK_STEPS)[number] | null>(null)
  /** Walking the height lab: its section comes first. */
  const lab = inLab()

  // Docked, the page makes room: the game, its HUD and its panels (App's
  // <main>) take the screen left of the panel, and the game's canvas follows
  // its stage's size (src/game/main.ts). Here, not in App, so a release
  // build carries none of it.
  $effect(() => {
    if (!docked) return
    document.documentElement.classList.add('dev-docked')
    return () => document.documentElement.classList.remove('dev-docked')
  })

  function fold(id: SectionId, isOpen: boolean): void {
    if (open[id] === isOpen) return
    open = { ...open, [id]: isOpen }
    saveDevPrefs({ sections: open })
  }

  /**
   * Fields keep their keys from the game (Phaser and the app's shortcuts
   * listen on the window: WASD, E, I…); Escape in a field leaves the field.
   */
  function fieldKeys(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null
    if (!t?.matches('input, textarea, select')) return
    e.stopPropagation()
    if (e.key === 'Escape') t.blur()
  }

  /** Docked, a clicked button lets go of the focus, so Space and Enter go on to the game. */
  function dropFocus(e: MouseEvent): void {
    if (e.detail === 0) return
    const b = (e.target as HTMLElement | null)?.closest('button, summary')
    if (b instanceof HTMLElement) b.blur()
  }

  const countOf = (g: Grantable) => clampCount(g, counts[g.id] ?? (g.kind === 'glims' ? 100 : g.kind === 'instance' || g.kind === 'decoration' ? 1 : 10))
  const said = (granted: GrantRequest[]) =>
    granted.length === 1 ? `Given: ${granted[0].qty} × ${all.find((g) => g.id === granted[0].id)?.name ?? granted[0].id}.` : `Given: ${granted.length} things.`

  function give(id: string, grants: GrantRequest[], remember = false): void {
    void action.run(id, () => devGrant(session, grants), (r) => said(r.granted)).then((r) => {
      if (!r?.ok || !remember) return
      recent = withRecent(recent, grants.map((g) => g.id))
      saveDevPrefs({ recent })
    })
  }
  const giveOne = (g: Grantable) => give(`give:${g.id}`, [{ id: g.id, qty: countOf(g) }], true)

  /** Enter in the search gives the one thing it found. */
  function searchKeys(e: KeyboardEvent): void {
    if (e.key === 'Enter' && shown.length === 1) giveOne(shown[0])
  }

  function moveClock(step: (typeof CLOCK_STEPS)[number]): void {
    asked = null
    void action.run(`clock:${step.id}`, () => devClockAdvance(step.seconds), (r) => `The server’s clock is now ${new Date(r.unix * 1000).toLocaleString()}. Reload to see the new time everywhere.`)
  }
</script>

{#snippet banner()}
  <p class="banner" data-testid="dev-banner"><Icon name="key" size={12} /> {DEV_LOCAL ? 'Dev mode (local only)' : 'Dev mode (this server)'}</p>
{/snippet}

{#snippet heightLab()}
  <DevSection id="height-lab" icon="stone" title="Height lab" note={lab ? 'walking it' : undefined} open={open['height-lab']} onToggle={(o) => fold('height-lab', o)}>
    <LabSection bare />
  </DevSection>
{/snippet}

{#snippet body()}
  <p class="lede">Glimway’s own things for this account, the server’s clock and the labs. Nothing here exists in a real build. Key: <span class="kbd tick">`</span></p>
  {#if lab}{@render heightLab()}{/if}
  {#if tools?.grant}
    <DevSection id="quick" icon="glim" title="Quick" open={open.quick} onToggle={(o) => fold('quick', o)}>
      <div class="quick">
        <button type="button" class="primary" data-testid="dev-glims" disabled={action.busy !== null} onclick={() => give('quick:glims', [{ id: GLIMS_GRANT_ID, qty: 100 }])}>
          <Glim size={14} /> +100 glims
        </button>
        <button type="button" data-testid="dev-glims-1000" disabled={action.busy !== null} onclick={() => give('quick:glims1000', [{ id: GLIMS_GRANT_ID, qty: 1000 }])}>
          <Glim size={14} /> +1,000
        </button>
        <button type="button" data-testid="dev-materials" disabled={action.busy !== null} onclick={() => give('quick:materials', everyMaterial(99))}>
          <Icon name="stone" size={14} /> A stack of every material
        </button>
      </div>
      {#if recentShown.length}
        <p class="sub">Given lately: again, at the count beside it in the list</p>
        <div class="recent" data-testid="dev-recent">
          {#each recentShown as g (g.id)}
            <button type="button" class="chip" data-again={g.id} title={`Give ${countOf(g)} × ${g.name} again`} disabled={action.busy !== null} onclick={() => giveOne(g)}>
              <ArtIcon art={g.art} name={g.icon} size={18} />
              <span>{g.name}</span>
              <span class="n">×{countOf(g)}</span>
            </button>
          {/each}
        </div>
      {/if}
    </DevSection>
    <DevSection id="give" icon="bag" title="Give an item" note={query || group ? `${shown.length} of ${all.length}` : `${all.length}`} open={open.give} onToggle={(o) => fold('give', o)}>
      <div class="filters">
        <label class="search">
          <span class="sr">Search</span>
          <input type="search" placeholder="Search: timber, axe, recipe…" autocomplete="off" spellcheck="false" bind:value={query} onkeydown={searchKeys} data-testid="dev-search" />
        </label>
        <label class="kind">
          <span class="sr">Kind</span>
          <select bind:value={group} data-testid="dev-group">
            <option value="">Every kind</option>
            {#each groups as gr (gr)}<option value={gr}>{gr}</option>{/each}
          </select>
        </label>
      </div>
      <ul class="things" data-testid="dev-list">
        {#each shown as g (g.id)}
          <li class="thing" data-grant={g.id}>
            <span class="thumb" aria-hidden="true"><ArtIcon art={g.art} name={g.icon} size={28} /></span>
            <span class="txt">
              <span class="name">{g.name}</span>
              <span class="what">{g.group} · <code>{g.id}</code></span>
            </span>
            <span class="go">
              <input
                type="number"
                min="1"
                max={g.max}
                inputmode="numeric"
                aria-label={`How many ${g.name}`}
                title={`Up to ${g.max.toLocaleString()}`}
                value={countOf(g)}
                oninput={(e) => (counts = { ...counts, [g.id]: Number((e.currentTarget as HTMLInputElement).value) })}
                onkeydown={(e) => e.key === 'Enter' && giveOne(g)}
              />
              <button type="button" class="small" data-give={g.id} disabled={action.busy !== null} onclick={() => giveOne(g)}>
                {action.busy === `give:${g.id}` ? 'Giving…' : 'Give'}
              </button>
            </span>
          </li>
        {:else}
          <li class="none">Nothing called that.</li>
        {/each}
      </ul>
    </DevSection>
  {/if}
  {#if tools?.clock}
    <DevSection id="clock" icon="clock" title="The server’s clock" open={open.clock} onToggle={(o) => fold('clock', o)}>
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
    </DevSection>
  {/if}
  {#if tools?.world_lab && onWorldLab}
    <DevSection id="world-lab" icon="world" title="World lab" open={open['world-lab']} onToggle={(o) => fold('world-lab', o)}>
      <p class="sub">The Wilds generator from any seed: atlas, region and chunk, overlays, stats, a diff, an editable copy of the rules, and “go here”. It renders on this server, away from the game, and changes nothing.</p>
      <button type="button" class="primary" onclick={onWorldLab}>Open the world lab</button>
    </DevSection>
  {/if}
  {#if !lab}{@render heightLab()}{/if}
  <!-- The last loads, stage by stage (src/lib/load-timings.ts); the Menu copies the same text. -->
  <DevSection id="timings" icon="clock" title="Load timings" open={open.timings} onToggle={(o) => fold('timings', o)}>
    <pre data-testid="dev-load-timings">{loadTimingsText()}</pre>
  </DevSection>
{/snippet}

{#if docked}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <aside class="dock panel dev" aria-labelledby="dev-title" data-testid="dev-panel" onkeydown={fieldKeys} onclick={dropFocus}>
    <header class="dock-head">
      <h2 class="panel-title" id="dev-title"><Icon name="key" size={18} /> Dev</h2>
      {@render banner()}
      <button type="button" class="close" onclick={onClose} aria-label="Close dev mode" title="Close (`)"><Icon name="close" size={14} /></button>
      {#if action.message}<p class="msg {action.message.kind}" role="status" data-testid="dev-message">{action.message.text}</p>{/if}
    </header>
    <div class="dock-body">
      {@render body()}
    </div>
  </aside>
{:else}
  <Panel id="dev" icon="key" title="Dev" closeLabel="Close dev mode" {onClose} message={action.message} messageTestId="dev-message" class="dev" data-testid="dev-panel" onkeydown={fieldKeys}>
    {#snippet head()}{@render banner()}{/snippet}
    {@render body()}
  </Panel>
{/if}

<style>
  /* Docked: the right column of the screen, the game in the rest. */
  :global(html.dev-docked) {
    --dev-dock-w: clamp(340px, 28vw, 420px);
  }
  :global(html.dev-docked main) {
    width: calc(100% - var(--dev-dock-w));
  }
  .dock {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 45;
    width: var(--dev-dock-w, 400px);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    border-radius: 0;
    border-width: 0 0 0 3px;
    user-select: text;
    -webkit-user-select: text;
  }
  /* One row: the title, the banner (it gives way first) and the ✕; the message under them. */
  .dock-head {
    flex: none;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px 10px;
    padding: 10px 12px 8px 16px;
    border-bottom: 3px solid var(--wood-dark);
    background: linear-gradient(180deg, var(--paper-glow) 0%, var(--paper-hi) 100%);
  }
  .dock-head .panel-title {
    margin: 0;
    font-size: 20px;
  }
  .dock-head .banner {
    justify-self: start;
    max-width: 100%;
    margin: 0;
    padding: 2px 8px;
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .close {
    width: 36px;
    height: 36px;
    padding: 0;
    display: grid;
    place-items: center;
  }
  .dock-head .msg {
    grid-column: 1 / -1;
    margin: 0;
  }
  /* The backquote is a hairline in the display font. */
  .tick {
    font-family: ui-monospace, monospace;
    font-size: 0.9em;
  }
  .dock-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 8px 14px 24px 16px;
  }
  .lede {
    margin: 0 0 4px;
    font-size: 12.5px;
  }
  .sub {
    margin: 0 0 8px;
    font-size: 12.5px;
    color: var(--text-soft);
  }
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
  pre {
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
    margin: 0 0 10px;
  }
  .quick button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 40px;
  }
  .recent {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px 3px 5px;
    min-height: 34px;
    font-size: 13px;
    box-shadow: 0 2px 0 var(--wood-dark), inset 0 1px 0 rgba(255, 255, 255, 0.8);
  }
  .chip .n {
    color: var(--accent);
    font-weight: 800;
  }
  .filters {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
  }
  .search {
    flex: 1 1 auto;
    min-width: 0;
  }
  .kind {
    flex: 0 1 40%;
    min-width: 0;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  input[type='search'],
  input[type='number'],
  select {
    box-sizing: border-box;
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
  input[type='search'],
  select {
    width: 100%;
    min-height: 40px;
  }
  input[type='number'] {
    width: 4.2em;
    min-height: 36px;
    padding: 6px 8px;
  }
  /* A bounded list that scrolls on its own: the sections under it stay in reach. */
  .things {
    list-style: none;
    margin: 0;
    padding: 2px 4px 2px 0;
    display: grid;
    gap: 5px;
    max-height: min(52vh, 460px);
    overflow-y: auto;
    overscroll-behavior: contain;
    border-radius: 9px;
  }
  .thing {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
    align-items: center;
    padding: 5px 8px;
    border-radius: 9px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.28);
  }
  .thumb {
    flex: none;
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: var(--wood-wash);
    color: var(--wood);
  }
  .txt {
    flex: 1 1 80px;
    min-width: 0;
    display: grid;
  }
  .name {
    font-weight: 800;
    color: var(--wood-dark);
  }
  .what {
    font-size: 11.5px;
    color: var(--accent);
    overflow-wrap: anywhere;
  }
  .what code {
    font-size: 11px;
    color: var(--text-soft);
  }
  .go {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-left: auto;
  }
  .small {
    padding: 4px 12px;
    font-size: 14px;
    min-height: 36px;
  }
  .none {
    padding: 8px;
    color: var(--text-soft);
  }
</style>
