<script lang="ts">
  import { bus, EV } from '../game/events'
  import { heroScreen, touchVec } from '../game/input'
  import { getCombatKit } from '../lib/combat'
  import { ui } from './store.svelte'
  import { isTouchFirst } from './device'
  import Icon from './Icon.svelte'
  import ArtIcon from './ArtIcon.svelte'
  import { heldUi } from './held.svelte'
  import { setHeld } from '../game/held'
  import { KIND_WORDS } from '../lib/belt'
  import { noteFloatingVisit, settings } from './settings.svelte'

  const show = isTouchFirst()
  /** fixed: the corner joystick. floating: it appears under the thumb. hold: walk toward the finger. */
  const mode = $derived(settings.stick)

  // The floating stick's resting hint shows for the first few visits only.
  const FLOAT_HINT_SESSIONS = 3
  if (show) noteFloatingVisit()
  const floatHint = $derived(mode === 'floating' && settings.value.floatingSessions <= FLOAT_HINT_SESSIONS)

  // ---- joystick: one pad, analog direction, slide freely between directions

  const RADIUS = 44
  let padEl: HTMLDivElement | undefined = $state()
  let knob = $state({ x: 0, y: 0 })
  let activePointer: number | null = null
  let center = { x: 0, y: 0 }

  function setVec(dx: number, dy: number): void {
    const len = Math.hypot(dx, dy)
    const clamped = Math.min(len, RADIUS)
    const nx = len > 0 ? dx / len : 0
    const ny = len > 0 ? dy / len : 0
    knob = { x: nx * clamped, y: ny * clamped }
    // Small dead zone, then full speed quickly (walking, not tip-toeing).
    const strength = clamped < 8 ? 0 : Math.min(1, (clamped - 8) / (RADIUS * 0.6))
    touchVec.x = nx * strength
    touchVec.y = ny * strength
  }

  function padDown(e: PointerEvent): void {
    e.preventDefault()
    if (activePointer !== null || !padEl) return
    activePointer = e.pointerId
    padEl.setPointerCapture(e.pointerId)
    const r = padEl.getBoundingClientRect()
    center = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    setVec(e.clientX - center.x, e.clientY - center.y)
  }

  function padMove(e: PointerEvent): void {
    if (e.pointerId !== activePointer) return
    setVec(e.clientX - center.x, e.clientY - center.y)
  }

  function padUp(e: PointerEvent): void {
    if (e.pointerId !== activePointer) return
    activePointer = null
    setVec(0, 0)
  }

  // ---- floating stick: a press on the left of the screen puts the stick under the thumb

  /** Where the floating stick sits while held (viewport px), or null at rest. */
  let floatAt = $state<{ x: number; y: number } | null>(null)

  function floatDown(e: PointerEvent): void {
    e.preventDefault()
    if (activePointer !== null) return
    activePointer = e.pointerId
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    center = { x: e.clientX, y: e.clientY }
    floatAt = { ...center }
    setVec(0, 0)
  }

  function floatMove(e: PointerEvent): void {
    if (e.pointerId !== activePointer) return
    setVec(e.clientX - center.x, e.clientY - center.y)
  }

  function floatUp(e: PointerEvent): void {
    if (e.pointerId !== activePointer) return
    activePointer = null
    floatAt = null
    setVec(0, 0)
  }

  // ---- hold to walk: the hero heads for the finger while it stays down

  /** The held finger (viewport px), or null. */
  let holdAt = $state<{ x: number; y: number } | null>(null)
  let holdFrame = 0
  /** The canvas's offset on the page (the scene reports the hero in canvas px). */
  let canvasOrigin = { x: 0, y: 0 }
  /** Close enough to the finger: stop instead of jittering on the spot. */
  const HOLD_STOP = 14

  function steer(): void {
    holdFrame = 0
    if (!holdAt) return
    const dx = holdAt.x - (canvasOrigin.x + heroScreen.x)
    const dy = holdAt.y - (canvasOrigin.y + heroScreen.y)
    const len = Math.hypot(dx, dy)
    if (len < HOLD_STOP) {
      touchVec.x = 0
      touchVec.y = 0
    } else {
      // Full speed a little way out; ease in only for the last few pixels.
      const strength = Math.min(1, (len - HOLD_STOP) / 24 + 0.35)
      touchVec.x = (dx / len) * strength
      touchVec.y = (dy / len) * strength
    }
    holdFrame = requestAnimationFrame(steer)
  }

  function holdDown(e: PointerEvent): void {
    e.preventDefault()
    if (activePointer !== null) return
    activePointer = e.pointerId
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    const r = document.querySelector('.stage canvas')?.getBoundingClientRect()
    canvasOrigin = { x: r?.left ?? 0, y: r?.top ?? 0 }
    holdAt = { x: e.clientX, y: e.clientY }
    if (!holdFrame) steer()
  }

  function holdMove(e: PointerEvent): void {
    if (e.pointerId !== activePointer || !holdAt) return
    holdAt = { x: e.clientX, y: e.clientY }
  }

  function holdUp(e: PointerEvent): void {
    if (e.pointerId !== activePointer) return
    activePointer = null
    holdAt = null
    if (holdFrame) cancelAnimationFrame(holdFrame)
    holdFrame = 0
    setVec(0, 0)
  }

  const zoneDown = (e: PointerEvent) => (mode === 'hold' ? holdDown(e) : floatDown(e))
  const zoneMove = (e: PointerEvent) => (mode === 'hold' ? holdMove(e) : floatMove(e))
  const zoneUp = (e: PointerEvent) => (mode === 'hold' ? holdUp(e) : floatUp(e))

  /** Let go of any stick or held finger (hidden controls, a mode change). */
  function releaseWalk(): void {
    activePointer = null
    floatAt = null
    holdAt = null
    if (holdFrame) cancelAnimationFrame(holdFrame)
    holdFrame = 0
    setVec(0, 0)
  }

  // ---- action buttons

  let actionRepeat: number | null = null

  function actionDown(e: PointerEvent): void {
    e.preventDefault()
    // Keep pointerup on this button even if the controls hide mid-press.
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    bus.emit(EV.action)
    if (actionRepeat !== null) window.clearInterval(actionRepeat)
    // Hold to keep swinging — but never auto-advance conversations.
    actionRepeat = window.setInterval(() => {
      if (!ui.dialogueOpen && !ui.prompt.label) bus.emit(EV.action)
    }, 320)
  }

  function actionUp(): void {
    if (actionRepeat !== null) {
      window.clearInterval(actionRepeat)
      actionRepeat = null
    }
  }

  function castDown(e: PointerEvent): void {
    e.preventDefault()
    bus.emit(EV.cast)
  }

  function rollDown(e: PointerEvent): void {
    e.preventDefault()
    bus.emit(EV.dodge)
  }

  const kit = $derived(getCombatKit(ui.importedProfile))
  const canAfford = $derived(ui.stats.mana >= kit.manaCost)
  const talkMode = $derived(!!ui.prompt.label && !ui.dialogueOpen)
  /**
   * The belt (src/game/held.ts): the big button shows what's in hand; the
   * rest sit as small buttons arced above it, clear of the roll and the
   * ability. Shown only when there's more than the weapon to hold.
   */
  const heldDef = $derived(heldUi.slot?.itemDef ?? null)
  const handWord = $derived(heldUi.kind === 'weapon' ? kit.basicName : KIND_WORDS[heldUi.kind])
  const others = $derived(heldUi.belt.filter((b) => b.kind !== heldUi.kind))
  /** Spots for the small buttons, from the big button's centre (px): up, then curving left over the roll. */
  const RING = [
    [0, -160],
    [-50, -152],
    [-100, -138],
    [-140, -108],
    [-166, -66],
    [-178, -20],
    [-182, 26]
  ]
  function pickHeld(e: PointerEvent, kind: (typeof heldUi.belt)[number]['kind']): void {
    e.preventDefault()
    setHeld(kind)
  }
  // The dialogue box covers this corner on phones; tapping it advances.
  const hidden = $derived(ui.cinematic || ui.dialogueOpen)

  // Never leave a held-swing repeat or a walk running behind a hidden/unmounted pad.
  $effect(() => {
    if (hidden) {
      actionUp()
      releaseWalk()
    }
  })
  // A new stick mode (picked in the Menu) starts from rest.
  $effect(() => {
    void mode
    releaseWalk()
  })
  $effect(() => () => {
    actionUp()
    releaseWalk()
  })
</script>

{#if show}
  {#if mode !== 'fixed'}
    <!-- Under the HUD, the prompt and every button: only bare world reaches it. -->
    <div
      class="walk-zone {mode}"
      class:hidden
      onpointerdown={zoneDown}
      onpointermove={zoneMove}
      onpointerup={zoneUp}
      onpointercancel={zoneUp}
      oncontextmenu={(e) => e.preventDefault()}
      role="application"
      aria-label={mode === 'hold' ? 'Hold to walk toward your finger' : 'Movement: touch the left side to walk'}
      data-testid="walk-zone"
    ></div>
    {#if mode === 'floating' && (floatAt || floatHint) && !hidden}
      <div
        class="float-stick"
        class:hint={!floatAt}
        style={floatAt ? `left:${floatAt.x}px; top:${floatAt.y}px` : ''}
        aria-hidden="true"
        data-testid="float-stick"
      >
        <span class="ring"></span>
        {#if floatAt}<span class="knob" style={`transform: translate(${knob.x}px, ${knob.y}px)`}></span>{/if}
      </div>
    {/if}
    {#if mode === 'hold' && holdAt && !hidden}
      <span class="hold-mark" style={`left:${holdAt.x}px; top:${holdAt.y}px`} aria-hidden="true"></span>
    {/if}
  {/if}
  <div class="controls" class:hidden aria-label="Touch controls">
    {#if mode === 'fixed'}
      <div
        class="pad"
        bind:this={padEl}
        onpointerdown={padDown}
        onpointermove={padMove}
        onpointerup={padUp}
        onpointercancel={padUp}
        oncontextmenu={(e) => e.preventDefault()}
        role="application"
        aria-label="Movement joystick"
      >
        <span class="ring"></span>
        <span class="knob" style={`transform: translate(${knob.x}px, ${knob.y}px)`}></span>
      </div>
    {/if}

    <div class="actions" class:with-belt={heldUi.belt.length > 1}>
      <div class="col">
      <button
        type="button"
        class="round roll"
        onpointerdown={rollDown}
        oncontextmenu={(e) => e.preventDefault()}
        aria-label="Roll"
      >
        <Icon name="roll" size={20} />
        {#key ui.roll.readyAt}
          {#if ui.roll.readyAt > 0}<span class="sweep" style={`animation-duration:${ui.roll.cooldown}s`}></span>{/if}
        {/key}
      </button>
      <button
        type="button"
        class="round cast"
        class:dim={!canAfford}
        onpointerdown={castDown}
        oncontextmenu={(e) => e.preventDefault()}
        aria-label={`${kit.signatureName} (${kit.manaCost} mana)`}
      >
        {#key ui.ability.deniedAt}
          <span class="glyph" class:shake={ui.ability.deniedAt > 0}><Icon name="sparkle" size={24} /></span>
        {/key}
        {#key ui.ability.readyAt}
          {#if ui.ability.readyAt > 0}<span class="sweep" style={`animation-duration:${ui.ability.cooldown}s`}></span>{/if}
        {/key}
        <span class="cost"><Icon name="drop" size={9} />{kit.manaCost}</span>
      </button>
      </div>
      <div class="actwrap">
        {#if heldUi.belt.length > 1}
          <div class="belt" role="group" aria-label="Take in hand" data-testid="belt">
            {#each others as b, i (b.kind)}
              {@const at = RING[i] ?? RING[RING.length - 1]}
              <button
                type="button"
                class="bslot"
                class:worn={!b.usable}
                aria-label={`Hold the ${b.kind === 'weapon' ? kit.basicName.toLowerCase() : KIND_WORDS[b.kind].toLowerCase()}`}
                data-kind={b.kind}
                style={`transform: translate(${at[0]}px, ${at[1]}px)`}
                onpointerdown={(e) => pickHeld(e, b.kind)}
                oncontextmenu={(e) => e.preventDefault()}
              >
                {#if b.itemDef}<ArtIcon art={b.itemDef} name="tools" size={16} />{:else}<Icon name="sword" size={18} />{/if}
              </button>
            {/each}
          </div>
        {/if}
        <button
          type="button"
          class="round act"
          class:talk={talkMode}
          data-held={heldUi.kind}
          onpointerdown={actionDown}
          onpointerup={actionUp}
          onpointercancel={actionUp}
          onpointerleave={actionUp}
          oncontextmenu={(e) => e.preventDefault()}
          aria-label={ui.dialogueOpen ? 'Continue' : talkMode ? ui.prompt.label : handWord}
        >
          {#if ui.dialogueOpen}<Icon name="check" size={28} />{:else if talkMode}<Icon name="sparkle" size={28} />{:else if heldDef}<ArtIcon art={heldDef} name="tools" size={32} />{:else}<Icon name="sword" size={28} />{/if}
          <span class="cap">{ui.dialogueOpen ? 'Next' : talkMode ? (ui.prompt.verb ?? 'Talk') : handWord}</span>
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .controls {
    position: absolute;
    left: 0;
    right: 0;
    bottom: max(16px, env(safe-area-inset-bottom));
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    padding: 0 max(18px, env(safe-area-inset-left)) 0 max(18px, env(safe-area-inset-right));
    z-index: 25;
    pointer-events: none;
    transition: opacity 250ms ease;
  }
  .controls.hidden {
    opacity: 0;
  }
  .controls.hidden * {
    pointer-events: none !important;
  }
  .pad {
    position: relative;
    width: 128px;
    height: 128px;
    border-radius: 50%;
    pointer-events: auto;
    touch-action: none;
    display: grid;
    place-items: center;
  }
  .walk-zone {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 45%;
    z-index: 14;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .walk-zone.hold {
    width: 100%;
  }
  .walk-zone.hidden {
    pointer-events: none;
  }
  .float-stick {
    position: absolute;
    width: 112px;
    height: 112px;
    margin: -56px 0 0 -56px;
    display: grid;
    place-items: center;
    z-index: 25;
    pointer-events: none;
  }
  /* At rest (first few visits): a faint ring where the thumb usually lands. */
  .float-stick.hint {
    left: calc(max(18px, env(safe-area-inset-left)) + 64px);
    top: auto;
    bottom: calc(max(16px, env(safe-area-inset-bottom)) + 8px);
    margin: 0 0 0 -56px;
    opacity: 0.45;
    animation: hint-breathe 2.4s ease-in-out infinite;
  }
  .float-stick .knob {
    position: absolute;
    left: 50%;
    top: 50%;
    margin: -27px 0 0 -27px;
  }
  .hold-mark {
    position: absolute;
    width: 34px;
    height: 34px;
    margin: -17px 0 0 -17px;
    border-radius: 50%;
    border: 3px solid rgba(255, 243, 196, 0.85);
    box-shadow: 0 0 0 2px rgba(43, 29, 26, 0.45), 0 0 12px rgba(255, 210, 74, 0.5);
    z-index: 25;
    pointer-events: none;
    animation: hold-pulse 0.9s ease-in-out infinite alternate;
  }
  @keyframes hint-breathe {
    0%, 100% { transform: scale(0.96); }
    50% { transform: scale(1.02); }
  }
  @keyframes hold-pulse {
    from { transform: scale(0.85); opacity: 0.75; }
    to { transform: scale(1.1); opacity: 1; }
  }
  .ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(244, 228, 193, 0.18) 0%, rgba(244, 228, 193, 0.32) 70%);
    border: 3px solid rgba(74, 50, 32, 0.55);
    box-shadow: inset 0 0 0 2px rgba(255, 249, 230, 0.25);
  }
  .knob {
    position: relative;
    width: 54px;
    height: 54px;
    border-radius: 50%;
    background: linear-gradient(180deg, #fff6dd, #e3cf9f);
    border: 3px solid var(--wood-dark);
    box-shadow: 0 4px 0 rgba(20, 12, 16, 0.5);
    transition: transform 40ms linear;
  }
  .actions {
    margin-left: auto;
    display: flex;
    gap: 14px;
    align-items: flex-end;
    pointer-events: none;
  }
  .round {
    position: relative;
    pointer-events: auto;
    touch-action: none;
    border-radius: 50%;
    padding: 0;
    display: grid;
    place-items: center;
    border-width: 3px;
  }
  /* Room above the buttons for the belt's arc (the camera keeps the hero clear of this box). */
  /* The ring is an overlay over the world: App.svelte measures its buttons, not a padded box. */
  .actwrap {
    position: relative;
  }
  .belt {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 0;
    height: 0;
    pointer-events: none;
  }
  .bslot {
    position: absolute;
    left: -20px;
    top: -20px;
    width: 40px;
    height: 40px;
    padding: 0;
    display: grid;
    place-items: center;
    border-radius: 50%;
    border-width: 2.5px;
    background: linear-gradient(180deg, #fff6dd, #e8d4a4);
    color: var(--wood-dark);
    pointer-events: auto;
    touch-action: none;
    box-shadow: 0 3px 0 rgba(20, 12, 16, 0.45);
  }
  /* A thumb-sized hit area. */
  .bslot::after {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: 50%;
  }
  .bslot.worn {
    filter: grayscale(0.8);
  }
  .act {
    width: 80px;
    height: 80px;
    background: linear-gradient(180deg, #fff6dd, #e8d4a4);
    color: var(--wood-dark);
  }
  .act.talk {
    background: linear-gradient(180deg, #fff3b8, #f5cf5c);
  }
  .act .cap {
    position: absolute;
    bottom: -20px;
    font-size: 12px;
    color: #fff3c4;
    text-shadow: 0 1px 0 #2b1d1a, 1px 0 0 #2b1d1a, -1px 0 0 #2b1d1a, 0 -1px 0 #2b1d1a;
    white-space: nowrap;
  }
  .col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    margin-bottom: 34px;
    pointer-events: none;
  }
  .roll {
    width: 46px;
    height: 46px;
    background: linear-gradient(180deg, #eef6e4, #b9d7a5);
    color: #2c4a22;
  }
  .cast {
    width: 60px;
    height: 60px;
    background: linear-gradient(180deg, #d6e6ff, #8fb3ec);
    color: #20365c;
    overflow: visible;
  }
  .cast.dim {
    filter: grayscale(0.7) brightness(0.85);
  }
  .glyph.shake {
    animation: deny 0.32s ease;
  }
  .sweep {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: conic-gradient(rgba(20, 14, 24, 0.55) var(--p, 100%), transparent 0);
    animation: sweep linear forwards;
  }
  .cost {
    position: absolute;
    top: -8px;
    right: -8px;
    display: flex;
    align-items: center;
    gap: 1px;
    padding: 1px 5px;
    font-size: 11px;
    color: #fff;
    background: var(--mana);
    border: 2px solid #20365c;
    border-radius: 8px;
  }
  @property --p {
    syntax: '<percentage>';
    inherits: false;
    initial-value: 100%;
  }
  @keyframes sweep {
    from { --p: 100%; }
    to { --p: 0%; }
  }
  @keyframes deny {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-4px); }
    50% { transform: translateX(4px); }
    75% { transform: translateX(-2px); }
  }
</style>
