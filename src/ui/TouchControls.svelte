<script lang="ts">
  import { bus, EV } from '../game/events'
  import { touchVec } from '../game/input'
  import { getCombatKit } from '../lib/combat'
  import { ui } from './store.svelte'
  import { isTouchFirst } from './device'
  import Icon from './Icon.svelte'

  const show = isTouchFirst()

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

  // ---- action buttons

  let actionRepeat: number | null = null

  function actionDown(e: PointerEvent): void {
    e.preventDefault()
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

  const kit = $derived(getCombatKit(ui.importedProfile))
  const canAfford = $derived(ui.stats.mana >= kit.manaCost)
  const talkMode = $derived(!!ui.prompt.label && !ui.dialogueOpen)
  // The dialogue box covers this corner on phones; tapping it advances.
  const hidden = $derived(ui.cinematic || ui.dialogueOpen)
</script>

{#if show}
  <div class="controls" class:hidden aria-label="Touch controls">
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

    <div class="actions">
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
      <button
        type="button"
        class="round act"
        class:talk={talkMode}
        onpointerdown={actionDown}
        onpointerup={actionUp}
        onpointercancel={actionUp}
        onpointerleave={actionUp}
        oncontextmenu={(e) => e.preventDefault()}
        aria-label={ui.dialogueOpen ? 'Continue' : talkMode ? ui.prompt.label : kit.basicName}
      >
        <Icon name={ui.dialogueOpen ? 'check' : talkMode ? 'sparkle' : 'sword'} size={28} />
        <span class="cap">{ui.dialogueOpen ? 'Next' : talkMode ? 'Talk' : kit.basicName}</span>
      </button>
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
  .cast {
    width: 60px;
    height: 60px;
    margin-bottom: 34px;
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
