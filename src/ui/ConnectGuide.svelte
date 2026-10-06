<script lang="ts">
  import { onMount } from 'svelte'
  import { isSafeArea, syncProfile, type SyncResult } from '../lib/habitica/sync'
  import { parseFields, parsePaste, swapped, type PasteResult } from '../lib/habitica/paste'
  import { forgetRemembered, saveRemembered } from '../lib/habitica/remembered'
  import { HabiticaApiError } from '../lib/habitica/client'
  import type { HabiticaProfile } from '../lib/habitica/types'
  import { XP_PER_EMBER } from '../lib/embers'
  import { emberLine, guideCopy, guideTabs, syncCopy, unverifiedNote, whyToken, type GuideTabId } from '../content/connect-guide'
  import type { Session } from '../game/session'
  import { sfx } from '../game/sfx'
  import { ui } from './store.svelte'
  import Icon from './Icon.svelte'
  import { connectedClient, connectSession, creatorId, disconnectSession, fixtureProfiles, friendlyErrorCopy, isConnected } from './habitica-local'
  import { api } from './account'
  import { errorCode, isUnreachable } from '../lib/api/errors'
  import type { Snapshot, WorldChoice } from '../lib/api/types'
  import { offlineCopy, signInCopy } from '../content/connected'

  /**
   * The Habitica connect guide, shared by the title screen ("title": a fresh
   * game, nothing has started yet) and the Menu panel ("menu"). Credentials
   * live in habitica-local's memory holder; only the opt-in Remember box
   * ever writes them anywhere (src/lib/habitica/remembered.ts).
   */
  let {
    session,
    mode,
    onBack,
    onReady,
    onSignedIn
  }: {
    session: Session
    mode: 'title' | 'menu'
    onBack?: () => void
    onReady?: () => void
    /** A Fingersnap server answered the sign-in: connected mode takes over from here. */
    onSignedIn?: (snapshot: Snapshot | WorldChoice, profile: HabiticaProfile) => void
  } = $props()

  type ConnectionState = 'disconnected' | 'connected' | 'syncing' | 'error'

  let connection = $state<ConnectionState>(isConnected() ? 'connected' : 'disconnected')
  let step = $state<1 | 2 | 3>(isConnected() ? 3 : 1)
  let tab = $state<GuideTabId>('website')
  let pasteText = $state('')
  let fieldUser = $state('')
  let fieldToken = $state('')
  let flipped = $state(false)
  let remember = $state(false)
  let showWhy = $state(false)
  let askForget = $state(false)
  let connectionError = $state('')
  let rememberNote = $state('')
  let heroPreview = $state<HabiticaProfile | null>(null)
  let welcome = $state(0)
  /** True when the last sign-in attempt came from two unlabeled codes. */
  let lastWasUnlabeled = false
  let syncBusy = $state(false)
  const setupNotice = creatorId() === null
  /** Connected play: pasted details only enable syncing; the server keeps the journey. */
  const remote = $derived(!!session.link)
  const linkOffline = $derived(remote && ui.link?.status !== 'online')
  /** Offer the server sign-in: a server answered, nobody is signed in yet, and play is not connected. */
  const canSignIn = $derived(ui.server === 'available' && !ui.account && !remote && !!onSignedIn)
  let inviteCode = $state('')
  let showInvite = $state(false)
  /** The server said this account needs an invite. */
  let inviteOnly = $state(false)
  /** The server refused for another reason (rate limit, trouble): local play is offered. */
  let offerLocal = $state(false)

  const hero = $derived(ui.importedProfile ?? heroPreview)

  /** Text fields must not leak keys to the game (Phaser captures WASD/E/F). */
  const keepKeys = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') e.stopPropagation()
  }

  // ---- paste ----

  const parsed = $derived.by<PasteResult | null>(() => {
    if (pasteText.trim()) return parsePaste(pasteText)
    if (fieldUser.trim() || fieldToken.trim()) return parseFields(fieldUser, fieldToken)
    return null
  })
  /** The pair that Connect would send, or null while unusable. */
  const resolved = $derived.by(() => {
    if (!parsed || parsed.kind === 'error') return null
    return parsed.kind === 'unlabeled' && flipped ? swapped(parsed) : { userId: parsed.userId, apiToken: parsed.apiToken }
  })
  const pasteError = $derived(parsed?.kind === 'error' && pasteText.trim() ? parsed.message : '')
  const mask = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`

  function onPasteInput(): void {
    flipped = false
    connectionError = ''
  }

  // ---- sync (moved from the Menu panel; same rules) ----

  /**
   * Safety gate: sync only somewhere safe and quiet (Hearthwick or the
   * Commons, including your cottage), before network and after. The area
   * test is the save's, as the shared rules and the server check it.
   */
  function syncBlocker(): string | null {
    if (mode === 'title') return null // nothing has started: a new game is in the village
    const safety = (window as unknown as {
      __fsSafety?: () => { areaId: string; transitioning: boolean; dialogueOpen: boolean; enemiesNear: boolean }
    }).__fsSafety?.()
    if (!safety) return 'The world is still waking up — try again in a moment.'
    if (!isSafeArea(session.state.area)) return syncCopy.goSafe
    if (safety.transitioning) return 'Finish walking through the gate first.'
    if (safety.dialogueOpen) return 'Finish your conversation first.'
    if (safety.enemiesNear) return 'Not with creatures this close!'
    return null
  }

  /** A failed first sign-in: forget the pair, go back to the paste step. */
  function failSignIn(err: unknown): void {
    disconnectSession()
    connection = 'disconnected'
    step = 2
    const auth = err instanceof HabiticaApiError && err.kind === 'auth'
    connectionError = auth && lastWasUnlabeled ? guideCopy.swapSuggestion : friendlyErrorCopy(err)
  }

  async function rememberIfAsked(creds: { userId: string; apiToken: string }): Promise<void> {
    if (!remember) return
    const ok = await saveRemembered(creds)
    ui.remembered = ok
    rememberNote = ok ? '' : guideCopy.rememberFailed
  }

  async function signIn(): Promise<void> {
    if (syncBusy) return
    const creds = resolved
    if (!creds) {
      connectionError = parsed?.kind === 'error' ? parsed.message : 'We need both your User ID and your API Token.'
      return
    }
    connectionError = ''
    rememberNote = ''
    lastWasUnlabeled = parsed?.kind === 'unlabeled'
    connectSession(creds.userId, creds.apiToken)
    if (remote) {
      // Already in a world: these details are for syncing that hero.
      const ok = await syncCharacter(true)
      if (ok) {
        await rememberIfAsked(creds)
        clearPaste()
      }
      return
    }
    if (canSignIn) {
      syncBusy = true
      connection = 'syncing'
      let next: 'done' | 'stop' | 'local' = 'local'
      try {
        const profile = await connectedClient()!.fetchProfile()
        heroPreview = profile
        next = await serverSignIn(creds, profile)
      } catch (err) {
        failSignIn(err)
        return
      } finally {
        syncBusy = false
        if (connection === 'syncing') connection = isConnected() ? 'connected' : 'disconnected'
      }
      if (next !== 'local') return
    }
    await localSignIn(creds)
  }

  /**
   * Sign in to the Fingersnap server with the details just checked against
   * Habitica. The server reads Habitica once to prove the account, and never
   * keeps the token. 'local' means no server answered: carry on as today.
   */
  async function serverSignIn(creds: { userId: string; apiToken: string }, profile: HabiticaProfile): Promise<'done' | 'stop' | 'local'> {
    try {
      const snapshot = await api.login({ userId: creds.userId, token: creds.apiToken, invite: inviteCode, party: profile.partyId ?? '' })
      await rememberIfAsked(creds)
      clearPaste()
      inviteOnly = false
      offerLocal = false
      inviteCode = ''
      connection = 'connected'
      step = 3
      onSignedIn?.(snapshot, profile)
      return 'done'
    } catch (err) {
      const code = errorCode(err)
      if (isUnreachable(err)) {
        ui.server = 'unavailable'
        return 'local'
      }
      if (code === 'habitica-auth') {
        failSignIn(new HabiticaApiError('auth', 'Habitica rejected the details.', { status: 401 }))
        return 'stop'
      }
      if (code === 'access-denied') {
        inviteOnly = true
        showInvite = true
        connectionError = inviteCode.trim() ? 'That invite code didn’t work. Check it, or ask for a new one.' : ''
        return 'stop'
      }
      offerLocal = true
      const wait = err instanceof Error && 'retryAfterMs' in err ? Number((err as { retryAfterMs?: number }).retryAfterMs ?? 0) : 0
      connectionError = code === 'login-rate-limited' || code === 'login-global-rate-limited' || code === 'login-busy' || code === 'habitica-rate-limited'
        ? signInCopy.rateLimited(Math.max(1, Math.round(wait / 1000)))
        : signInCopy.serverTrouble
      return 'stop'
    }
  }

  /** "Play on this device instead": the details stay in memory, the journey stays local. */
  async function playLocally(): Promise<void> {
    const creds = connectedClient() ? resolved ?? null : null
    inviteOnly = false
    offerLocal = false
    connectionError = ''
    if (!creds) {
      step = 2
      return
    }
    await localSignIn(creds)
  }

  /** Today's path: apply the hero to the journey on this device. */
  async function localSignIn(creds: { userId: string; apiToken: string }): Promise<void> {
    const blocker = syncBlocker()
    if (blocker) {
      // Not somewhere safe to apply a sync: still verify the sign-in (one read).
      syncBusy = true
      try {
        heroPreview = await connectedClient()!.fetchProfile()
        await rememberIfAsked(creds)
        clearPaste()
        connection = 'connected'
        step = 3
        connectionError = `${blocker} Then press Sync.`
      } catch (err) {
        failSignIn(err)
      } finally {
        syncBusy = false
      }
      return
    }
    const ok = await syncCharacter(true)
    if (ok) {
      await rememberIfAsked(creds)
      clearPaste()
    }
  }

  function clearPaste(): void {
    pasteText = ''
    fieldUser = ''
    fieldToken = ''
    flipped = false
  }

  /** One explicit GET per press. Returns true when the profile was fetched
   * and the sync handled (applied or already current). */
  async function syncCharacter(signingIn = false): Promise<boolean> {
    const client = connectedClient()
    if (!client) {
      connection = 'disconnected'
      step = 2
      connectionError = 'Connect first — your details stay in this tab until you disconnect.'
      return false
    }
    if (syncBusy) return false
    const generation = session.currentGeneration
    const blocker = syncBlocker()
    if (blocker) {
      connectionError = blocker
      return false
    }
    if (remote && linkOffline) {
      connectionError = `${offlineCopy.needs}. Syncing waits until you’re back online.`
      return false
    }
    connection = 'syncing'
    connectionError = ''
    syncBusy = true
    try {
      const profile = await client.fetchProfile()

      if (!isConnected() || session.currentGeneration !== generation) {
        connection = isConnected() ? 'connected' : 'disconnected'
        connectionError = 'That sync was cancelled because your journey changed. Nothing was applied.'
        return false
      }

      const late = (window as unknown as { __fsSafety?: () => { transitioning: boolean; dialogueOpen: boolean; enemiesNear: boolean } }).__fsSafety?.()
      if (mode === 'menu' && late && (late.transitioning || late.dialogueOpen || late.enemiesNear)) {
        connection = 'error'
        connectionError = syncCopy.midSync
        return false
      }

      if (session.link) return await remoteSync(profile, signingIn)

      const result = syncProfile(
        { state: session.state, vitalsSource: session.vitalsSource, importedProfile: session.importedProfile ?? undefined },
        profile,
        { atSafeBoundary: true }
      )

      if (result.status === 'rejected') {
        connection = 'error'
        connectionError = result.reason === 'account-switch'
          ? 'That’s a different Habitica character than this journey’s. Start over to switch heroes.'
          : syncCopy.unsafeUnchanged
        if (signingIn) {
          disconnectSession()
          connection = 'disconnected'
          step = 2
        }
        return false
      }
      if (result.status === 'unchanged') {
        connection = 'connected'
        step = 3
        heroPreview = profile
        const baselineMoved = JSON.stringify(result.save.importedProfile ?? null) !== JSON.stringify(session.importedProfile)
        if (baselineMoved) {
          const applied = await session.applySynced(result.save, generation)
          if (applied === 'committed') {
            ui.importedProfile = result.save.importedProfile ?? null
          } else if (applied === 'save-failed') {
            connection = 'error'
            connectionError = 'We read your character, but couldn’t save here. Try again in a moment.'
            return false
          } else if (applied === 'stale') {
            connection = isConnected() ? 'connected' : 'disconnected'
            connectionError = 'That sync was cancelled because your journey changed. Nothing was applied.'
            return false
          }
        }
        ui.toast({ text: 'All caught up — nothing new on Habitica.' })
        return true
      }

      const firstImport = session.vitalsSource !== 'imported'
      const applied = await session.applySynced(result.save, generation)
      if (applied === 'committed') {
        ui.vitalsSource = 'imported'
        ui.importedProfile = profile
        heroPreview = profile
        connection = 'connected'
        step = 3
        welcome = result.embers?.welcome ?? 0
        if (mode === 'menu') {
          ui.toast({
            text: firstImport
              ? `Welcome to Hearthwick, ${profile.name}! Your Habitica health and mana travel with you.`
              : `Synced — ${profile.name} is up to date.`,
            icon: 'person'
          })
          emberToast(result)
        }
        return true
      } else if (applied === 'stale') {
        connection = isConnected() ? 'connected' : 'disconnected'
        connectionError = 'That sync was cancelled because your journey changed. Nothing was applied.'
      } else {
        connection = 'error'
        connectionError = 'We read your character, but couldn’t save here — nothing changed. Try again in a moment.'
      }
      return false
    } catch (err) {
      if (signingIn) failSignIn(err)
      else {
        connectionError = friendlyErrorCopy(err)
        connection = 'error'
      }
      return false
    } finally {
      syncBusy = false
    }
  }

  /**
   * Connected play: the browser fetched the profile; the server records it
   * against the journey's baseline and XP mark (design: "Sync: the browser
   * fetches, the server records").
   */
  async function remoteSync(profile: HabiticaProfile, signingIn: boolean): Promise<boolean> {
    const result = await session.link!.sync(profile)
    if (result.ok) {
      connection = 'connected'
      step = 3
      heroPreview = profile
      ui.vitalsSource = session.vitalsSource
      ui.importedProfile = session.importedProfile
      if (result.welcome > 0) {
        sfx('ember')
        ui.toast({ text: `Mara presses ${result.welcome} embers into your hand. “For the lanterns. Earn more out there.”`, icon: 'ember' })
      } else if (result.gained > 0) {
        sfx('ember')
        ui.toast({ text: `+${result.gained} ember${result.gained === 1 ? '' : 's'} — from the XP you earned on Habitica.`, icon: 'ember' })
      } else if (result.status === 'unchanged') {
        ui.toast({ text: 'All caught up — nothing new on Habitica.' })
      } else {
        ui.toast({ text: `Synced — ${profile.name} is up to date.`, icon: 'person' })
      }
      return true
    }
    const code = result.code
    connection = 'error'
    connectionError =
      code === 'offline' ? `${offlineCopy.needs}. Syncing waits until you’re back online.`
        : code === 'account-switch' ? 'That’s a different Habitica hero than the one in this world. Log out first to switch heroes.'
          : code === 'not-at-safe-boundary' ? syncCopy.unsafeNothing
            : code === 'implausible-profile' ? 'The world couldn’t accept that profile just now. Nothing changed; try again later.'
              : code === 'superseded' ? 'Another device took over this journey.'
                : code === 'busy' ? 'Hold on — the last request is still on its way.'
                  : 'The sync didn’t go through. Nothing changed — try again.'
    if (signingIn && code === 'account-switch') {
      disconnectSession()
      connection = 'disconnected'
      step = 2
    }
    return false
  }

  /** Tell the player what their real-life XP turned into. */
  function emberToast(result: SyncResult): void {
    const e = result.embers
    if (!e || e.gained <= 0) return
    sfx('ember')
    if (e.welcome > 0) {
      ui.toast({ text: `Mara presses ${e.welcome} embers into your hand. “For the lanterns. Earn more out there.”`, icon: 'ember' })
      return
    }
    ui.toast({ text: `+${e.gained} ember${e.gained === 1 ? '' : 's'} — from the ${e.xp} XP you earned on Habitica.`, icon: 'ember' })
  }

  function disconnect(alsoForget: boolean): void {
    askForget = false
    // Ends the sync session: an in-flight sync must not commit after this.
    session.markReset()
    disconnectSession()
    heroPreview = null
    connectionError = ''
    connection = 'disconnected'
    step = 1
    if (alsoForget) void forget()
  }

  function requestDisconnect(): void {
    if (ui.remembered) askForget = true
    else disconnect(false)
  }

  async function forget(): Promise<void> {
    const ok = await forgetRemembered()
    if (ok) {
      ui.remembered = false
      rememberNote = ''
      ui.toast({ text: guideCopy.forgottenToast })
    } else {
      rememberNote = 'This browser wouldn’t let us clear it. Clear this site’s data in your browser settings.'
    }
  }

  /** Offline demo of the import pipeline (no network, no credentials). */
  async function sampleImport(): Promise<void> {
    if (syncBusy) return
    const blocker = syncBlocker()
    if (blocker) {
      connectionError = blocker
      return
    }
    const generation = session.currentGeneration
    const sample = fixtureProfiles().find((f) => f.key === 'lowLevel') ?? fixtureProfiles()[0]
    const result = syncProfile(
      { state: session.state, vitalsSource: session.vitalsSource, importedProfile: session.importedProfile ?? undefined },
      sample.profile,
      { atSafeBoundary: true }
    )
    if (result.status === 'rejected') {
      connectionError = syncCopy.sampleUnsafe
      return
    }
    syncBusy = true
    try {
      const applied = await session.applySynced(result.save, generation)
      if (applied === 'committed') {
        ui.vitalsSource = 'imported'
        ui.importedProfile = sample.profile
        ui.toast({ text: `${sample.profile.name} steps into Hearthwick.`, icon: 'person' })
        emberToast(result)
      } else if (applied === 'save-failed') {
        connectionError = 'The sample hero is ready, but this browser wouldn’t save — nothing changed.'
      } else if (applied === 'stale') {
        connectionError = 'That was cancelled because your journey changed. Nothing was applied.'
      }
    } finally {
      syncBusy = false
    }
  }

  function onTabKey(e: KeyboardEvent): void {
    const i = guideTabs.findIndex((t) => t.id === tab)
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null
    if (next === null) return
    e.preventDefault()
    tab = guideTabs[(next + guideTabs.length) % guideTabs.length].id
    queueMicrotask(() => document.getElementById(`guide-tab-${tab}`)?.focus())
  }

  const activeTab = $derived(guideTabs.find((t) => t.id === tab) ?? guideTabs[0])
  const classLabel = (c: string) => c.charAt(0).toUpperCase() + c.slice(1)

  onMount(() => {
    if (isConnected()) step = 3
  })
</script>

<div class="guide">
  {#if setupNotice}
    <p class="fine">Live Habitica connection isn’t switched on in this build, but you can still try a sample hero to see how it works.</p>
    <div class="row">
      <button type="button" onclick={sampleImport} disabled={syncBusy}>Try a sample hero</button>
    </div>
    <p class="tiny">Builders: set VITE_HABITICA_CREATOR_ID to enable live connection.</p>
  {:else}
    <ol class="steps" aria-label="Steps">
      <li class:on={step === 1} class:done={step > 1} aria-current={step === 1 ? 'step' : undefined}><span>1</span> Find</li>
      <li class:on={step === 2} class:done={step > 2} aria-current={step === 2 ? 'step' : undefined}><span>2</span> Paste</li>
      <li class:on={step === 3} aria-current={step === 3 ? 'step' : undefined}><span>3</span> Connected</li>
    </ol>

    {#if step !== 2}
    <div class="embers-note">
      <span class="ei"><Icon name="ember" size={18} /></span>
      <p><strong>Your real-life progress lights the road.</strong> {emberLine(XP_PER_EMBER)}</p>
    </div>
    {/if}

    {#if step === 1}
      <h4 class="step-title">{guideCopy.step1}</h4>
      <p class="fine">{guideCopy.step1Intro}</p>
      <div class="tabs" role="tablist" aria-label="Where are you playing Habitica?">
        {#each guideTabs as t (t.id)}
          <button
            type="button"
            role="tab"
            id={`guide-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="guide-tabpanel"
            tabindex={tab === t.id ? 0 : -1}
            class:active={tab === t.id}
            onclick={() => (tab = t.id)}
            onkeydown={onTabKey}
          >{t.label}</button>
        {/each}
      </div>
      <div class="tabpanel" role="tabpanel" id="guide-tabpanel" aria-labelledby={`guide-tab-${activeTab.id}`}>
        {#if activeTab.unverified}
          <p class="unverified" role="note">{unverifiedNote}</p>
        {/if}
        <ol class="how">
          {#each activeTab.steps as s}<li>{s}</li>{/each}
        </ol>
        {#if activeTab.note}<p class="tiny">{activeTab.note}</p>{/if}
      </div>
      <div class="row">
        {#if onBack}<button type="button" class="ghost" onclick={onBack}>Back</button>{/if}
        <button type="button" class="primary" onclick={() => (step = 2)}>I have them</button>
        {#if !remote}<button type="button" onclick={sampleImport} disabled={syncBusy}>Try a sample hero</button>{/if}
      </div>
      <!-- A sample hero refused here (not somewhere safe) says why, instead of nothing. -->
      {#if connectionError}<p class="error" role="alert">{connectionError}</p>{/if}
    {:else if step === 2}
      <h4 class="step-title">{guideCopy.step2}</h4>
      <p class="fine">{guideCopy.step2Intro}</p>
      <label class="field">
        <span>{guideCopy.pasteLabel}</span>
        <textarea
          bind:value={pasteText}
          oninput={onPasteInput}
          rows="3"
          autocomplete="off"
          spellcheck="false"
          placeholder={'User ID: …\nAPI Token: …'}
          onkeydown={keepKeys}
        ></textarea>
      </label>
      <p class="tiny">{guideCopy.pasteHint}</p>
      {#if pasteError}<p class="error" role="alert">{pasteError}</p>{/if}

      {#if parsed?.kind === 'unlabeled' && resolved}
        <div class="preview" role="group" aria-label="Check the order">
          <strong>{guideCopy.previewTitle}</strong>
          <p>{guideCopy.previewBody}</p>
          <dl>
            <div><dt>User ID</dt><dd data-testid="preview-user">{mask(resolved.userId)}</dd></div>
            <div><dt>API Token</dt><dd data-testid="preview-token">{mask(resolved.apiToken)}</dd></div>
          </dl>
          <button type="button" onclick={() => (flipped = !flipped)}>Swap</button>
        </div>
      {/if}

      {#if !pasteText.trim()}
        <details class="separate">
          <summary>Or fill the two boxes</summary>
          <label class="field">
            <span>{guideCopy.userIdLabel}</span>
            <input type="text" bind:value={fieldUser} autocomplete="off" spellcheck="false" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" onkeydown={keepKeys} />
          </label>
          <label class="field">
            <span>{guideCopy.tokenLabel}</span>
            <input type="password" bind:value={fieldToken} autocomplete="off" placeholder="••••••••••••" onkeydown={keepKeys} />
          </label>
          {#if parsed?.kind === 'error' && !pasteText.trim()}<p class="error" role="alert">{parsed.message}</p>{/if}
        </details>
      {/if}

      <label class="check">
        <input type="checkbox" bind:checked={remember} />
        <span><strong>{guideCopy.rememberLabel}</strong></span>
      </label>
      <p class="tiny" class:warn={remember}>{remember ? guideCopy.rememberExposure : guideCopy.rememberOffNote}</p>

      {#if canSignIn && !inviteOnly}
        <p class="party-welcome" data-testid="party-welcome"><Icon name="person" size={12} /> {signInCopy.partyWelcome}</p>
        <details class="invite" bind:open={showInvite}>
          <summary><Icon name="key" size={12} /> {signInCopy.inviteToggle}</summary>
          <label class="field">
            <span>{signInCopy.inviteLabel}</span>
            <input type="text" bind:value={inviteCode} autocomplete="off" autocapitalize="none" spellcheck="false" placeholder={signInCopy.invitePlaceholder} onkeydown={keepKeys} />
          </label>
          <p class="tiny">{signInCopy.inviteHint}</p>
        </details>
      {/if}

      {#if inviteOnly}
        <div class="callout" role="group" aria-labelledby="invite-only-title" data-testid="invite-only">
          <strong id="invite-only-title"><Icon name="key" size={14} /> {signInCopy.inviteOnlyTitle}</strong>
          <p>{signInCopy.inviteOnlyBody}</p>
          <label class="field">
            <span>{signInCopy.inviteLabel}</span>
            <input type="text" bind:value={inviteCode} autocomplete="off" autocapitalize="none" spellcheck="false" placeholder={signInCopy.invitePlaceholder} onkeydown={keepKeys} />
          </label>
          {#if connectionError}<p class="error" role="alert">{connectionError}</p>{/if}
          <div class="row">
            <button type="button" class="primary" onclick={signIn} disabled={syncBusy || !resolved || !inviteCode.trim()}>{signInCopy.inviteJoin}</button>
            <button type="button" onclick={playLocally} disabled={syncBusy}>{signInCopy.playLocal}</button>
          </div>
          <p class="tiny">{signInCopy.playLocalNote}</p>
        </div>
      {:else if connectionError}
        <p class="error" role="alert">{connectionError}</p>
      {/if}
      {#if offerLocal && !inviteOnly}
        <div class="row">
          <button type="button" onclick={playLocally} disabled={syncBusy}>{signInCopy.playLocal}</button>
        </div>
      {/if}
      {#if rememberNote}<p class="error" role="alert">{rememberNote}</p>{/if}

      {#if connection === 'syncing' || syncBusy}
        <p class="status"><span class="spinner" aria-hidden="true"></span> Fetching your hero…</p>
      {/if}
      {#if !inviteOnly}
        <div class="row">
          <button type="button" class="ghost" onclick={() => (step = 1)}>Back</button>
          <button type="button" class="primary" onclick={signIn} disabled={syncBusy || !resolved}>
            {parsed?.kind === 'unlabeled' ? 'Looks right — Connect' : 'Connect'}
          </button>
        </div>
      {/if}
    {:else}
      <h4 class="step-title">{guideCopy.step3}</h4>
      {#if hero}
        <div class="hero" data-testid="hero-card">
          <span class="ok"><Icon name="check" size={12} /></span>
          <div>
            <div class="hero-name">{hero.name}</div>
            <div class="hero-meta">{hero.class ? classLabel(hero.class) : 'No class yet'} · Level {hero.level}</div>
          </div>
        </div>
      {:else}
        <p class="status"><span class="ok"><Icon name="check" size={12} /></span> Connected for this tab.</p>
      {/if}
      {#if ui.account}
        <p class="world-line" data-testid="world-line"><Icon name="lantern" size={12} /> {signInCopy.signedIn(ui.account.name)}</p>
      {/if}
      {#if welcome > 0}<p class="fine">Mara is holding {welcome} embers for you to start.</p>{/if}

      {#if ui.remembered}
        <p class="remembered" role="status">
          <Icon name="scroll" size={12} /> Remembered on this device.
          <button type="button" class="linky" onclick={forget}>{guideCopy.forgetLabel}</button>
        </p>
      {:else}
        <p class="tiny">{guideCopy.rememberOffNote}</p>
      {/if}
      {#if rememberNote}<p class="error" role="alert">{rememberNote}</p>{/if}
      {#if connectionError}<p class="error" role="alert">{connectionError}</p>{/if}
      {#if connection === 'syncing'}
        <p class="status"><span class="spinner" aria-hidden="true"></span> Fetching your hero…</p>
      {/if}

      {#if askForget}
        <div class="preview" role="group" aria-label="Forget your details?">
          <strong>{guideCopy.disconnectAsk.title}</strong>
          <p>{guideCopy.disconnectAsk.body}</p>
          <div class="row">
            <button type="button" class="danger" onclick={() => disconnect(true)}>{guideCopy.disconnectAsk.forget}</button>
            <button type="button" onclick={() => disconnect(false)}>{guideCopy.disconnectAsk.keep}</button>
            <button type="button" class="ghost" onclick={() => (askForget = false)}>Never mind</button>
          </div>
        </div>
      {:else}
        <div class="row">
          {#if mode === 'title' && onReady && ui.importedProfile}
            <button type="button" class="primary" onclick={onReady}>Begin your journey</button>
          {:else}
            <button type="button" class="primary" onclick={() => syncCharacter()} disabled={syncBusy || linkOffline} title={linkOffline ? offlineCopy.needs : undefined}>Sync character</button>
          {/if}
          <button type="button" onclick={requestDisconnect}>Disconnect</button>
          {#if linkOffline}<span class="tiny inline">{offlineCopy.needs}</span>{/if}
        </div>
      {/if}
    {/if}

    <details class="why" bind:open={showWhy}>
      <summary>{whyToken.summary}</summary>
      <h5>{whyToken.reads.title}</h5>
      <ul>{#each whyToken.reads.items as i}<li>{i}</li>{/each}</ul>
      <h5>{whyToken.never.title}</h5>
      <ul>{#each whyToken.never.items as i}<li>{i}</li>{/each}</ul>
      <p>{whyToken.honest}</p>
      <p>{whyToken.where}</p>
    </details>
  {/if}
</div>

<style>
  .guide {
    text-align: left;
  }
  .fine {
    margin: 0 0 10px;
  }
  .party-welcome {
    display: flex;
    gap: 6px;
    align-items: baseline;
    margin: 4px 0 0;
    font-size: 13px;
    line-height: 1.4;
    color: var(--wood);
  }
  .tiny {
    margin: 4px 0;
    font-size: 12px;
    color: var(--text-faint);
    line-height: 1.45;
  }
  .tiny.warn {
    color: #7a2e1e;
  }
  .row {
    display: flex;
    gap: 8px;
    margin: 10px 0 4px;
    flex-wrap: wrap;
  }
  .steps {
    display: flex;
    gap: 6px;
    list-style: none;
    margin: 8px 0 10px;
    padding: 0;
    font-family: var(--font-display);
    font-size: 13px;
    color: var(--text-faint);
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 5px;
    flex: 1;
  }
  .steps li span {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid var(--paper-line);
    font-size: 11px;
  }
  .steps li.on {
    color: var(--wood-dark);
  }
  .steps li.on span {
    background: var(--gold);
    border-color: var(--wood);
  }
  .steps li.done span {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .step-title {
    margin: 6px 0 4px;
    font-family: var(--font-display);
    font-size: 17px;
    color: var(--wood-dark);
  }
  .tabs {
    display: flex;
    gap: 4px;
    margin: 6px 0 0;
  }
  .tabs button {
    flex: 1;
    border-radius: 8px 8px 0 0;
    padding: 8px 6px;
    font-size: 14px;
    white-space: nowrap;
  }
  @media (max-width: 420px) {
    .tabs button {
      padding: 7px 4px;
      font-size: 13px;
      letter-spacing: 0;
    }
  }
  .tabs button.active {
    background: var(--paper-hi);
    border-bottom-color: transparent;
    color: var(--wood-dark);
  }
  .tabpanel {
    padding: 10px 12px;
    border: 2px solid var(--wood);
    border-radius: 0 0 8px 8px;
    background: var(--paper-hi);
  }
  .how {
    margin: 0;
    padding-left: 20px;
    font-size: 14px;
    line-height: 1.55;
  }
  .unverified {
    margin: 0 0 8px;
    padding: 6px 8px;
    font-size: 12.5px;
    border-radius: 6px;
    background: rgba(255, 210, 74, 0.25);
    border: 1px dashed var(--gold-deep);
  }
  .field {
    display: grid;
    gap: 4px;
    margin: 8px 0;
    font-family: var(--font-display);
    font-size: 13px;
    color: var(--wood-dark);
  }
  input[type='text'],
  input[type='password'],
  textarea {
    font: inherit;
    font-family: var(--font-body);
    font-size: 14px;
    width: 100%;
    padding: 8px 10px;
    border: 2px solid var(--wood);
    border-radius: 8px;
    background: #fffbef;
    color: var(--text);
    user-select: text;
    -webkit-user-select: text;
  }
  textarea {
    resize: vertical;
    font-size: 13px;
  }
  .separate,
  .why {
    margin: 10px 0 0;
  }
  summary {
    cursor: pointer;
    font-size: 13.5px;
    color: var(--text-soft);
    padding: 4px 0;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 0 0;
    font-size: 14px;
  }
  .check input {
    width: 20px;
    height: 20px;
    accent-color: var(--accent);
  }
  .preview {
    margin: 8px 0;
    padding: 10px 12px;
    border-radius: 10px;
    border: 2px solid var(--gold-deep);
    background: rgba(255, 210, 74, 0.18);
  }
  .preview p {
    margin: 4px 0 6px;
    font-size: 13.5px;
  }
  .preview dl {
    margin: 0 0 8px;
    display: grid;
    gap: 4px;
  }
  .preview dl div {
    display: flex;
    gap: 10px;
    align-items: baseline;
  }
  .preview dt {
    min-width: 76px;
    font-family: var(--font-display);
    font-size: 13px;
  }
  .preview dd {
    margin: 0;
    font-family: ui-monospace, monospace;
    font-size: 13px;
  }
  .error {
    margin: 6px 0;
    padding: 8px 10px;
    font-size: 13.5px;
    color: #7a2e1e;
    background: rgba(196, 82, 58, 0.12);
    border-radius: 8px;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
    font-weight: 700;
  }
  .hero {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 6px 0 10px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 2px solid var(--paper-line);
    background: var(--paper-hi);
  }
  .hero-name {
    font-family: var(--font-display);
    font-size: 20px;
    color: var(--wood-dark);
  }
  .hero-meta {
    font-size: 13.5px;
    color: var(--text-soft);
  }
  .remembered {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin: 6px 0;
    font-size: 13px;
  }
  .linky {
    padding: 2px 10px;
    font-size: 13px;
    min-height: 0;
  }
  .ok {
    display: grid;
    place-items: center;
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
  }
  .spinner {
    width: 14px;
    height: 14px;
    border: 3px solid var(--paper-line);
    border-top-color: var(--wood);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .why h5 {
    margin: 8px 0 2px;
    font-family: var(--font-display);
    font-size: 13px;
    color: var(--wood-dark);
  }
  .why ul {
    margin: 0;
    padding-left: 18px;
    font-size: 13.5px;
    line-height: 1.5;
  }
  .why p {
    margin: 8px 0 0;
    font-size: 13.5px;
    line-height: 1.5;
  }
  .invite {
    margin: 8px 0 0;
  }
  .invite summary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .callout {
    margin: 10px 0 4px;
    padding: 10px 12px 8px;
    border-radius: 10px;
    border: 2px solid var(--wood);
    background: linear-gradient(180deg, rgba(255, 252, 240, 0.9), rgba(244, 228, 193, 0.9));
  }
  .callout strong {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 15px;
    color: var(--wood-dark);
  }
  .callout p {
    margin: 4px 0 2px;
    font-size: 13.5px;
    line-height: 1.45;
  }
  .world-line {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: -2px 0 8px;
    font-size: 13px;
    font-weight: 700;
    color: var(--accent);
  }
  .tiny.inline {
    align-self: center;
    margin: 0;
  }
  .embers-note {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    margin: 4px 0 12px;
    padding: 10px 12px;
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(255, 194, 122, 0.22), rgba(255, 179, 92, 0.12));
    border: 2px dashed rgba(181, 72, 31, 0.35);
  }
  .embers-note p {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--text);
  }
  .embers-note .ei {
    color: var(--ember-deep);
    margin-top: 1px;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
