<script lang="ts">
  import type { Session } from '../game/session'
  import { sfx } from '../game/sfx'
  import { soundSettings, type SoundPrefs } from '../game/sound-settings'
  import { ui } from './store.svelte'
  import Icon from './Icon.svelte'
  import Panel from './Panel.svelte'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import ConnectGuide from './ConnectGuide.svelte'
  import InvitePanel from './InvitePanel.svelte'
  import WorldCard from './WorldCard.svelte'
  import type { HabiticaProfile } from '../lib/habitica/types'
  import type { Snapshot, WorldChoice, WorldRef, WorldView } from '../lib/api/types'
  import { accountCopy, offlineCopy } from '../content/connected'
  import { CONTROLS, TOUCH_CONTROLS } from '../content/controls'
  import { updateCopy, whatsNewCopy } from '../content/update'
  import { CHANGELOG_URL, RUNNING } from '../lib/version'
  import { isTouchFirst } from './device'
  import { settings, type StickMode } from './settings.svelte'

  /** Ways to walk on a touch screen; the picture is a little phone seen from above. */
  const STICKS: Array<{ id: StickMode; name: string; note: string }> = [
    { id: 'fixed', name: 'Joystick', note: 'In the corner' },
    { id: 'floating', name: 'Floating stick', note: 'Under your thumb' },
    { id: 'hold', name: 'Hold to walk', note: 'Toward your finger' }
  ]

  let {
    session,
    onClose,
    onSignedIn,
    onLogout,
    onMove,
    onLeave,
    onWhatsNew
  }: {
    session: Session
    onClose: () => void
    /** The guide signed in to the Glimway server (connected mode starts). */
    onSignedIn?: (snapshot: Snapshot | WorldChoice, profile: HabiticaProfile) => void
    onLogout?: () => void
    /** Move to another world: the confirmation takes over from here. */
    onMove?: (target: WorldRef, home: boolean, view: WorldView) => void
    /** Left the party whose world you live in: go now. */
    onLeave?: (view: WorldView) => void
    /** The "What's new" card for this version (src/ui/WhatsNew.svelte). */
    onWhatsNew?: () => void
  } = $props()

  const touch = isTouchFirst()
  let confirmLogout = $state(false)
  let logoutBusy = $state(false)

  /** Upload what's pending first, so the dialog says truthfully whether anything is unsent. */
  async function requestLogout(): Promise<void> {
    logoutBusy = true
    const link = session.link
    if (link?.online) await Promise.race([link.flush().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))])
    logoutBusy = false
    confirmLogout = true
  }
  /** The world holds the save; offline play waits out a dead connection. */
  const offline = $derived(ui.link?.status === 'offline')

  /** Text fields must not leak keys to the game (Phaser captures WASD/E/F). */
  const keepKeys = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') e.stopPropagation()
  }

  /** Sound on or off and its volume, per device (src/game/sound-settings.ts). */
  let sound = $state<SoundPrefs>(soundSettings.prefs)
  function setSound(change: Partial<SoundPrefs>): void {
    soundSettings.set(change)
    sound = soundSettings.prefs
  }
  function toggleSound(): void {
    setSound({ on: !sound.on })
    if (sound.on) sfx('click')
  }

  /** Choose how to walk (the radiogroup: one tab stop, arrows move and choose, as in the tab rows). */
  function pickStick(id: StickMode): void {
    settings.set('stick', id)
    sfx('click')
  }
  function onStickKey(e: KeyboardEvent): void {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']
    if (!keys.includes(e.key)) return
    e.preventDefault()
    const n = STICKS.length
    const i = STICKS.findIndex((m) => m.id === settings.stick)
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp'
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (back ? -1 : 1) + n) % n
    pickStick(STICKS[next].id)
    const group = (e.currentTarget as HTMLElement).parentElement
    queueMicrotask(() => group?.querySelector<HTMLElement>(`[data-stick="${STICKS[next].id}"]`)?.focus())
  }
</script>

<Panel id="menu" icon="menu" title="Menu" closeLabel="Close menu" {onClose}>

  <div class="quick">
    <button type="button" class="primary" onclick={onClose}>Back to the road</button>
    <button type="button" onclick={toggleSound} aria-pressed={sound.on} data-testid="sound-toggle">
      <Icon name={sound.on ? 'sound' : 'mute'} size={16} /> Sound {sound.on ? 'on' : 'off'}
    </button>
    <input
      type="range"
      class="volume"
      min="0"
      max="100"
      step="5"
      value={Math.round(sound.volume * 100)}
      disabled={!sound.on}
      aria-label="Sound volume"
      data-testid="sound-volume"
      onkeydown={keepKeys}
      oninput={(e) => setSound({ volume: Number(e.currentTarget.value) / 100 })}
      onchange={() => sfx('click')}
    />
  </div>

  {#if touch}
    <div class="sticks" role="radiogroup" aria-label="How you walk" data-testid="stick-modes">
      {#each STICKS as m (m.id)}
        <button
          type="button"
          role="radio"
          class="stick"
          class:on={settings.stick === m.id}
          aria-checked={settings.stick === m.id}
          tabindex={settings.stick === m.id ? 0 : -1}
          data-stick={m.id}
          onclick={() => pickStick(m.id)}
          onkeydown={onStickKey}
        >
          <svg class="pic" viewBox="0 0 36 22" aria-hidden="true">
            <rect x="1" y="1" width="34" height="20" rx="4" class="phone" />
            {#if m.id === 'fixed'}
              <circle cx="8" cy="15" r="4.5" class="ring" /><circle cx="8" cy="15" r="2" class="dot" />
            {:else if m.id === 'floating'}
              <rect x="2.5" y="2.5" width="14" height="17" rx="2" class="zone" />
              <circle cx="11" cy="10" r="4.5" class="ring" /><circle cx="12.5" cy="9" r="2" class="dot" />
            {:else}
              <circle cx="13" cy="13" r="2" class="dot" /><path d="M15 11.5 L24 7" class="trail" /><circle cx="26" cy="6" r="3" class="ring" />
            {/if}
          </svg>
          <span class="nm">{m.name}</span>
          <span class="nt">{m.note}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if ui.account}
    <section class="card world" data-testid="world-card">
      <h3 class="section-title"><Icon name="lantern" size={14} /> {accountCopy.section}</h3>
      <p class="who"><strong>{accountCopy.signedInAs(ui.account.name)}</strong></p>
      <p class="fine">
        {#if offline}<span class="chip off"><Icon name="cloud" size={12} /> {ui.link?.trouble ? offlineCopy.troubleChip : offlineCopy.chip}</span>{/if}
        {offline ? (ui.link?.trouble ? accountCopy.savedTrouble : accountCopy.savedOffline) : accountCopy.saved}
      </p>
      <div class="row">
        <button type="button" onclick={requestLogout} disabled={offline || logoutBusy} title={offline ? offlineCopy.needs : undefined}>{accountCopy.logout}</button>
        {#if offline}<span class="tiny inline">{offlineCopy.needs}</span>{/if}
      </div>
      {#if !offline && onMove}<WorldCard {onMove} {onLeave} />{/if}
    </section>
  {/if}

  <section class="card">
    <h3 class="section-title"><Icon name="person" size={14} /> Sync your Habitica hero</h3>
    <ConnectGuide {session} mode="menu" {onSignedIn} />
  </section>

  {#if ui.account}
    <section class="card" data-testid="invites-card">
      <h3 class="section-title"><Icon name="key" size={14} /> Invite a friend</h3>
      <InvitePanel />
    </section>
  {/if}

  <section class="card">
    <h3 class="section-title"><Icon name="star" size={14} /> Controls</h3>
    {#if touch}
      <dl class="keys touch" data-testid="controls-touch">
        {#each TOUCH_CONTROLS as row (row.control)}
          <div><dt>{row.control}</dt><dd>{row.does}</dd></div>
        {/each}
      </dl>
    {:else}
      <dl class="keys" data-testid="controls-keys">
        {#each CONTROLS as row (row.does)}
          <div><dt>{#each row.keys as k}<span class="kbd">{k}</span>{/each}</dt><dd>{row.does}</dd></div>
        {/each}
      </dl>
    {/if}
  </section>

  <section class="card">
    <h3 class="section-title"><Icon name="lantern" size={14} /> About</h3>
    <p class="fine">Glimway plays in your browser. Your journey is kept in your world on the Glimway server; your Habitica token never is.</p>
    <p class="tiny" data-testid="credits">
      Avatar, gear and companion art from Habitica (habitica.com), © HabitRPG, Inc., licensed
      <a href="https://creativecommons.org/licenses/by-nc-sa/3.0/" target="_blank" rel="noopener noreferrer">CC BY-NC-SA 3.0</a>;
      gear statistics derived from Habitica's content data (GPL-3.0). Glimway is not affiliated with or
      endorsed by Habitica. Sound effects by
      <a href="https://kenney.nl" target="_blank" rel="noopener noreferrer">Kenney</a> (CC0).
    </p>
  </section>

  <p class="tiny version" data-testid="version-line">
    <a href={CHANGELOG_URL} target="_blank" rel="noopener noreferrer" title={updateCopy.menuTitle}>{updateCopy.menuLine(RUNNING.version)}</a>
    <span class="build">{updateCopy.menuBuild(RUNNING.build)}</span>
    {#if onWhatsNew}<button type="button" class="ghost whats-new" onclick={onWhatsNew} data-testid="menu-whats-new">{whatsNewCopy.menu}</button>{/if}
  </p>
</Panel>

{#if confirmLogout}
  <ConfirmDialog
    title={accountCopy.logoutTitle}
    body={session.link?.dirty ? accountCopy.logoutDirty : accountCopy.logoutBody}
    confirmLabel={accountCopy.logout}
    onConfirm={() => {
      confirmLogout = false
      onLogout?.()
    }}
    onCancel={() => (confirmLogout = false)}
  />
{/if}

<style>
  .quick {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }
  .quick button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .quick .volume {
    flex: 1 1 120px;
    max-width: 200px;
    min-height: 44px;
    accent-color: var(--wood);
  }
  .quick .volume:disabled {
    opacity: 0.45;
  }
  .sticks {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-top: 12px;
  }
  .stick {
    display: grid;
    justify-items: center;
    gap: 2px;
    min-height: 44px;
    padding: 8px 4px;
    line-height: 1.15;
  }
  .stick.on {
    background: linear-gradient(180deg, #fff3b8, #f5cf5c);
    box-shadow: inset 0 0 0 2px var(--gold-deep);
  }
  .stick .pic {
    width: 36px;
    height: 22px;
  }
  .stick .phone {
    fill: rgba(255, 252, 240, 0.7);
    stroke: var(--wood-dark);
    stroke-width: 1.5;
  }
  .stick .zone {
    fill: var(--wood-wash);
  }
  .stick .ring {
    fill: none;
    stroke: var(--wood);
    stroke-width: 1.5;
  }
  .stick .dot {
    fill: var(--wood-dark);
  }
  .stick .trail {
    stroke: var(--wood);
    stroke-width: 1.5;
    stroke-dasharray: 2 2;
  }
  .stick .nm {
    font-family: var(--font-display);
    font-size: 13px;
  }
  .stick .nt {
    font-size: 12px;
    color: var(--text-soft);
  }
  .card {
    margin-top: 14px;
    padding: 4px 16px 14px;
    background: rgba(255, 255, 255, 0.32);
    border: 2px solid var(--paper-line);
    border-radius: 10px;
  }
  .card .section-title {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
  }
  .fine {
    margin: 0 0 10px;
  }
  .who {
    margin: 0 0 4px;
    font-size: 15px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-right: 6px;
    padding: 1px 8px;
    border-radius: 999px;
    font-family: var(--font-display);
    font-size: 12px;
    vertical-align: 1px;
  }
  .chip.off {
    background: rgba(79, 134, 214, 0.16);
    color: #2c4f84;
    border: 1.5px solid rgba(79, 134, 214, 0.4);
  }
  .tiny.inline {
    align-self: center;
  }
  .tiny {
    font-size: 12px;
    color: var(--text-faint);
    line-height: 1.45;
  }
  .tiny a {
    color: inherit;
  }
  .version {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: baseline;
    gap: 2px 8px;
    margin: 14px 0 0;
    text-align: center;
  }
  .version .build {
    font-size: 11px;
    opacity: 0.8;
  }
  .version .whats-new {
    padding: 4px 12px;
    font-size: 13px;
  }
  :global(:root.touch) .version .whats-new {
    min-height: 44px;
  }
  .row {
    display: flex;
    gap: 8px;
    margin: 8px 0;
    flex-wrap: wrap;
  }
  .keys {
    display: grid;
    gap: 8px;
    margin: 0;
  }
  .keys div {
    display: grid;
    grid-template-columns: 150px 1fr;
    align-items: center;
    gap: 10px;
  }
  .keys dt {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .keys.touch dt {
    font-family: var(--font-display);
    font-size: 13px;
    color: var(--wood-dark);
  }
  .keys dd {
    margin: 0;
    font-size: 14px;
  }
  @media (max-width: 560px) {
    .keys div {
      grid-template-columns: 1fr;
      gap: 4px;
    }
  }
</style>
