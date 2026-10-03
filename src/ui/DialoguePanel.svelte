<script lang="ts">
  import { onMount } from 'svelte'
  import { bus, EV, type DialoguePayload } from '../game/events'
  import { uiState } from '../game/input'

  let open = $state(false)
  let speaker = $state('')
  let lines = $state<string[]>([])
  let idx = $state(0)
  let shown = $state('')
  let typing = $state(false)
  let questEvent = $state<string | undefined>(undefined)
  let timer: number | null = null

  function typeLine(line: string): void {
    typing = true
    shown = ''
    if (timer !== null) window.clearInterval(timer)
    let i = 0
    timer = window.setInterval(() => {
      i += 1
      shown = line.slice(0, i)
      if (i >= line.length) {
        window.clearInterval(timer!)
        timer = null
        typing = false
      }
    }, 16)
  }

  function openDialogue(payload: DialoguePayload): void {
    open = true
    uiState.dialogueOpen = true
    speaker = payload.speaker
    lines = payload.lines
    idx = 0
    questEvent = payload.event
    typeLine(lines[0] ?? '')
  }

  function advance(): void {
    if (!open) return
    if (typing) {
      if (timer !== null) window.clearInterval(timer)
      timer = null
      typing = false
      shown = lines[idx] ?? ''
      return
    }
    if (idx + 1 < lines.length) {
      idx += 1
      typeLine(lines[idx])
      return
    }
    close()
  }

  function close(): void {
    if (timer !== null) window.clearInterval(timer)
    timer = null
    open = false
    uiState.dialogueOpen = false
    const event = questEvent
    questEvent = undefined
    bus.emit(EV.dialogueClosed, { event })
  }

  onMount(() => {
    const onDialogue = (p: DialoguePayload) => openDialogue(p)
    const onAction = () => {
      if (open) advance()
    }
    const onKey = (e: KeyboardEvent) => {
      if (!open) return
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault()
        advance()
      }
    }
    bus.on(EV.dialogue, onDialogue)
    bus.on(EV.action, onAction)
    window.addEventListener('keydown', onKey)
    return () => {
      bus.off(EV.dialogue, onDialogue)
      bus.off(EV.action, onAction)
      window.removeEventListener('keydown', onKey)
      if (timer !== null) window.clearInterval(timer)
    }
  })
</script>

{#if open}
  <div class="dialogue" role="dialog" aria-label={`Conversation with ${speaker}`}>
    <div class="panel box">
      <div class="speaker">{speaker}</div>
      <p class="line">{shown}</p>
      <div class="footer">
        <span class="hint">{typing ? '…' : idx + 1 < lines.length ? 'more ▾' : questEvent ? '✦' : 'close'}</span>
        <button type="button" onclick={advance}>{idx + 1 < lines.length || typing ? 'Next' : 'Done'}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .dialogue {
    position: absolute;
    left: 0;
    right: 0;
    bottom: max(10px, env(safe-area-inset-bottom));
    display: flex;
    justify-content: center;
    padding: 0 12px;
    z-index: 30;
    pointer-events: none;
  }
  .box {
    width: min(620px, 100%);
    padding: 12px 14px;
    pointer-events: auto;
  }
  .speaker {
    font-size: 12px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--accent);
    font-weight: 700;
  }
  .line {
    margin: 8px 0 10px;
    font-size: 14px;
    line-height: 1.5;
    min-height: 2.6em;
    white-space: pre-wrap;
  }
  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .hint {
    font-size: 11px;
    color: #8a7a5a;
  }
</style>
