<script lang="ts">
  import { onMount } from 'svelte'
  import { bus, EV, type DialogueChoice, type DialoguePayload } from '../game/events'
  import { uiState } from '../game/input'
  import { sfx, voiceBlip } from '../game/sfx'
  import { ui } from './store.svelte'
  import { isTouchFirst } from './device'
  import Glim from './Glim.svelte'
  import { escapeMove } from '../lib/dialogue-escape'

  /** Name-tag colors per speaker; objects get a neutral stone tag. */
  const TAG: Record<string, string> = {
    Mara: '#2f7f7a',
    Pip: '#c0602e',
    Orrin: '#6b4c9a',
    Elara: '#4c6a4a',
    Finn: '#8a6d2f',
    Hazel: '#9c4f3c',
    Ada: '#7a3b4a',
    'Route Marker': '#6e6a5e',
    'Hilltop Lantern': '#b07a12',
    'Hearth Lantern': '#c0702a',
    'Road Lantern': '#b07a12',
    'Ashwatch Chest': '#7a5a2e'
  }

  const touch = isTouchFirst()

  let open = $state(false)
  let speaker = $state('')
  let lines = $state<string[]>([])
  let idx = $state(0)
  let shown = $state('')
  let typing = $state(false)
  let questEvent = $state<string | undefined>(undefined)
  let choices = $state<DialogueChoice[] | null>(null)
  /** True once a reply was picked (choices are not offered again). */
  let answered = $state(false)
  /** The picked reply's world action, delivered when the conversation closes. */
  let chosenAction: string | undefined
  let timer: number | null = null
  /** Timestamp of the keydown that opened this conversation (if any). */
  let openedAt = 0

  const atLastLine = $derived(idx + 1 >= lines.length)
  const showChoices = $derived(open && !typing && atLastLine && !!choices && !answered)
  const portrait = $derived(ui.portraits[speaker] ?? null)
  /** A delivered 64-px bust (Commons pass) shows at 1:1, not stretched like the small crops. */
  let bust = $state(false)
  const tagColor = $derived(TAG[speaker] ?? '#6b4c2e')

  function stopTyping(): void {
    if (timer !== null) window.clearTimeout(timer)
    timer = null
  }

  /** Typewriter with breathing room after punctuation. */
  function typeLine(line: string): void {
    stopTyping()
    typing = true
    shown = ''
    let i = 0
    const step = () => {
      i += 1
      shown = line.slice(0, i)
      const ch = line[i - 1]
      if (ch && /[A-Za-z0-9]/.test(ch)) voiceBlip(speaker)
      if (i >= line.length) {
        timer = null
        typing = false
        return
      }
      const delay = /[.!?…]/.test(ch) && line[i] === ' ' ? 240 : /[,;:—]/.test(ch) ? 110 : 18
      timer = window.setTimeout(step, delay)
    }
    timer = window.setTimeout(step, 18)
  }

  function openDialogue(payload: DialoguePayload): void {
    open = true
    // Phaser handles the same keydown first and opens us synchronously;
    // without this the opening press would also skip line one's typing.
    openedAt = performance.now()
    ui.dialogueOpen = true
    uiState.dialogueOpen = true
    speaker = payload.speaker
    lines = payload.lines
    idx = 0
    questEvent = payload.event
    choices = payload.choices && payload.choices.length > 0 ? payload.choices : null
    answered = false
    chosenAction = undefined
    typeLine(lines[0] ?? '')
  }

  function advance(): void {
    if (!open) return
    if (typing) {
      stopTyping()
      typing = false
      shown = lines[idx] ?? ''
      return
    }
    if (showChoices) return // a reply must be picked
    if (idx + 1 < lines.length) {
      idx += 1
      sfx('blip')
      typeLine(lines[idx])
      return
    }
    close()
  }

  function choose(choice: DialogueChoice): void {
    if (choice.disabled) {
      sfx('fizzle')
      return
    }
    sfx('click')
    if (choice.replay && choice.reply?.length) {
      // "Hear it again": the whole talk, then the other choices again (a
      // goodbye alone isn't worth asking: the talk just ends).
      const rest = (choices ?? []).filter((c) => c !== choice)
      choices = rest.some((c) => !c.dismiss) ? rest : null
      lines = [...lines, ...choice.reply]
      idx += 1
      typeLine(lines[idx])
      return
    }
    answered = true
    chosenAction = choice.action
    const reply = choice.reply ?? []
    if (reply.length === 0) {
      close()
      return
    }
    lines = [...lines, ...reply]
    idx += 1
    typeLine(lines[idx])
  }

  /**
   * Esc (src/lib/dialogue-escape.ts): out of the talk as if it were read
   * through, taking the goodbye when replies are on offer; a decision with
   * no goodbye, or a story beat, stays (a soft fizzle).
   */
  function escape(): void {
    const move = escapeMove({ choices, answered, beat: ui.cinematic })
    if (move.kind === 'stay') {
      sfx('fizzle')
      return
    }
    if (move.kind === 'goodbye') {
      answered = true
      chosenAction = move.choice.action
    }
    close()
  }

  function close(): void {
    stopTyping()
    open = false
    ui.dialogueOpen = false
    uiState.dialogueOpen = false
    const event = questEvent
    const action = chosenAction
    questEvent = undefined
    chosenAction = undefined
    bus.emit(EV.dialogueClosed, { event, action })
  }

  onMount(() => {
    const onDialogue = (p: DialoguePayload) => openDialogue(p)
    const onAction = () => {
      if (open) advance()
    }
    const onKey = (e: KeyboardEvent) => {
      if (!open || e.timeStamp <= openedAt) return
      if (e.code === 'Escape') {
        // Ours: the Menu mustn't open on the press that closed the talk (App.svelte's Escape).
        ;(e as KeyboardEvent & { fsConsumed?: boolean }).fsConsumed = true
        e.preventDefault()
        if (!e.repeat) escape()
        return
      }
      if (showChoices && choices) {
        const n = Number(e.key)
        if (n >= 1 && n <= choices.length) {
          e.preventDefault()
          choose(choices[n - 1])
          return
        }
        // Space/E pick the focused reply (Enter is native button behavior).
        if (!e.repeat && (e.code === 'Space' || e.code === 'KeyE')) {
          const el = document.activeElement as HTMLElement | null
          if (el?.classList.contains('choice')) {
            e.preventDefault()
            el.click()
          }
        }
        return
      }
      if (e.repeat) return
      if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyE') {
        e.preventDefault()
        advance()
      }
    }
    bus.on(EV.dialogue, onDialogue)
    bus.on(EV.action, onAction)
    window.addEventListener('keydown', onKey)
    // Read-only, for playtests: where the conversation is, so a test can
    // press on when the line changes instead of after a fixed pause, and
    // which conversations have opened so far (one the world opens on its own
    // may come and go between two checks).
    let offSeen = () => {}
    if (import.meta.env.DEV) {
      const seen: { speaker: string; text: string }[] = []
      let opened = 0
      const onSeen = (p: DialoguePayload) => {
        opened += 1
        seen.push({ speaker: p.speaker, text: p.lines.join('\n') })
        if (seen.length > 50) seen.shift()
      }
      bus.on(EV.dialogue, onSeen)
      offSeen = () => bus.off(EV.dialogue, onSeen)
      ;(window as unknown as { __fsDialogue?: () => unknown }).__fsDialogue = () => ({
        open,
        speaker,
        line: idx,
        lines: lines.length,
        /** Every line of this (or the last) conversation, replies included. */
        said: [...lines],
        typing,
        /** Replies are still to come on the last line (shown once its typing ends). */
        pending: !!choices && !answered,
        choices: showChoices ? (choices ?? []).map((c) => ({ text: c.text, disabled: !!c.disabled })) : null,
        opened,
        seen: [...seen]
      })
    }
    return () => {
      offSeen()
      bus.off(EV.dialogue, onDialogue)
      bus.off(EV.action, onAction)
      window.removeEventListener('keydown', onKey)
      stopTyping()
    }
  })

  /** Focus the first reply so keyboard users can pick with arrows/Enter. */
  function focusFirst(node: HTMLElement) {
    queueMicrotask(() => node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true }))
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const items = [...node.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const i = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
      items[next]?.focus()
    }
    node.addEventListener('keydown', onKey)
    return { destroy: () => node.removeEventListener('keydown', onKey) }
  }
</script>

{#if open}
  <div class="dialogue" role="dialog" aria-label={`Conversation with ${speaker}`}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="panel box" class:has-portrait={!!portrait} onclick={() => !showChoices && advance()}>
      {#if portrait}
        <div class="portrait" class:bust style={`--tag:${tagColor}`}>
          <img class="pixel" src={portrait} alt="" onload={(e) => (bust = (e.currentTarget as HTMLImageElement).naturalWidth >= 48)} />
        </div>
      {/if}
      <div class="content">
        <div class="tag" style={`--tag:${tagColor}`}>{speaker}</div>
        <p class="line" aria-live="polite">{shown}<span class="caret" class:on={typing}></span></p>
        {#if showChoices && choices}
          <div class="choices" use:focusFirst>
            {#each choices as c, i}
              <button
                type="button"
                class="choice"
                class:costs={!!c.action}
                disabled={c.disabled}
                aria-describedby={c.note ? `choice-note-${i}` : undefined}
                onclick={(e) => { e.stopPropagation(); choose(c) }}
              >
                {#if !touch}<span class="kbd">{i + 1}</span>{/if}
                <span class="label">{c.text}</span>
                {#if c.note}
                  <span class="note" id={`choice-note-${i}`}>
                    {#if c.action || c.disabled}<Glim size={12} />{/if}{c.note}
                  </span>
                {/if}
              </button>
            {/each}
          </div>
        {:else}
          <div class="footer">
            {#if !typing}
              <span class="next" class:more={!atLastLine}>
                {#if !touch}<span class="kbd">E</span>{/if}
                {atLastLine ? (questEvent ? 'Continue' : 'Done') : 'Next'}
                <span class="arrow">{atLastLine ? '✓' : '▼'}</span>
              </span>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .dialogue {
    position: absolute;
    left: 0;
    right: 0;
    bottom: max(14px, env(safe-area-inset-bottom));
    display: flex;
    justify-content: center;
    padding: 0 14px;
    z-index: 30;
    pointer-events: none;
    animation: up 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2);
  }
  .box {
    width: min(680px, 100%);
    padding: 16px 20px 14px;
    pointer-events: auto;
    cursor: pointer;
    display: grid;
    grid-template-columns: 1fr;
    gap: 16px;
  }
  .box.has-portrait {
    grid-template-columns: auto 1fr;
  }
  .portrait {
    width: 92px;
    height: 92px;
    align-self: start;
    display: grid;
    place-items: center;
    background:
      radial-gradient(circle at 50% 70%, rgba(255, 255, 255, 0.55), transparent 70%),
      color-mix(in srgb, var(--tag) 22%, #f6e8c8);
    border: 3px solid var(--wood-dark);
    border-radius: 12px;
    box-shadow: inset 0 0 0 2px rgba(255, 249, 230, 0.8);
    overflow: hidden;
    place-items: end center;
  }
  /* Pre-cropped, square native art scaled up crisply. */
  .portrait img {
    width: 80px;
    height: 80px;
    margin-top: 6px;
    object-fit: contain;
    animation: breathe 2.4s ease-in-out infinite;
  }
  .portrait.bust img {
    width: 64px;
    height: 64px;
    margin-top: 0;
  }
  .tag {
    display: inline-block;
    padding: 2px 10px 3px;
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: #fff;
    background: var(--tag);
    border: 2px solid var(--wood-dark);
    border-radius: 8px;
    box-shadow: 0 2px 0 var(--wood-dark);
  }
  .line {
    margin: 10px 0 8px;
    font-size: 17px;
    line-height: 1.55;
    min-height: 3.1em;
    white-space: pre-wrap;
    color: var(--text);
  }
  .caret {
    display: inline-block;
    width: 0.5em;
  }
  .caret.on::after {
    content: '▍';
    color: var(--text-faint);
    animation: blink 0.6s steps(1) infinite;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    min-height: 26px;
  }
  .next {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-display);
    font-size: 14px;
    color: var(--wood);
  }
  .next .arrow {
    color: var(--gold-deep);
  }
  .next.more .arrow {
    animation: bob 0.8s ease-in-out infinite;
  }
  .choices {
    display: grid;
    gap: 8px;
    margin-top: 4px;
  }
  .choice {
    display: flex;
    align-items: center;
    gap: 10px;
    text-align: left;
    font-family: var(--font-body);
    font-weight: 700;
    font-size: 15.5px;
    padding: 9px 14px;
  }
  .choice .label {
    flex: 1;
    min-width: 0;
  }
  /* The tag on a choice ("4 glims", "Needs 15 glims"): a solid chip in the
     body face, readable at a glance on a phone (≥ 7:1 on its own ground). */
  .choice .note {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    font-family: var(--font-body);
    font-weight: 800;
    font-size: 14px;
    line-height: 1.2;
    padding: 2px 9px 3px;
    border-radius: 999px;
    color: #8a3210;
    background: #fff4d8;
    border: 1.5px solid rgba(74, 50, 32, 0.45);
    white-space: nowrap;
  }
  /* Out of reach: muted, not faded. The global disabled opacity would wash
     the tag out to unreadable; the reason is the point of the tag. */
  .choice:disabled {
    opacity: 1;
    color: var(--text-soft);
    background: linear-gradient(180deg, #efe3c4 0%, #e3d3ad 100%);
    border-style: dashed;
    box-shadow: 0 2px 0 rgba(74, 50, 32, 0.55);
  }
  .choice:disabled .note {
    color: var(--wood-dark);
    background: var(--paper-hi);
    border-color: var(--wood);
  }
  .choice:focus-visible {
    background: linear-gradient(180deg, #fff3b8, #f5cf5c);
  }
  @keyframes up {
    from { transform: translateY(16px); opacity: 0; }
  }
  @keyframes bob {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(3px); }
  }
  @keyframes blink {
    50% { opacity: 0; }
  }
  @keyframes breathe {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-1px); }
  }
  @media (max-width: 560px) {
    .box {
      padding: 12px 14px 12px;
      gap: 12px;
    }
    .portrait {
      width: 64px;
      height: 64px;
    }
    .portrait img {
      width: 56px;
      height: 56px;
      margin-top: 4px;
    }
    .portrait.bust {
      width: 70px;
      height: 70px;
    }
    .portrait.bust img {
      width: 64px;
      height: 64px;
      margin-top: 0;
    }
    .line {
      font-size: 15.5px;
    }
    .choice {
      gap: 8px;
      padding: 9px 10px 9px 12px;
    }
  }
</style>
