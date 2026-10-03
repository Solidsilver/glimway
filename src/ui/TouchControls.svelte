<script lang="ts">
  import { bus, EV } from '../game/events'
  import { touchVec } from '../game/input'

  let show = $state(false)
  let active = { up: false, down: false, left: false, right: false }

  $effect(() => {
    const coarse = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
    show = coarse
  })

  function applyVec(): void {
    touchVec.x = (active.right ? 1 : 0) - (active.left ? 1 : 0)
    touchVec.y = (active.down ? 1 : 0) - (active.up ? 1 : 0)
  }

  function bind(dir: 'up' | 'down' | 'left' | 'right') {
    return {
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault()
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        active[dir] = true
        applyVec()
      },
      onpointerup: () => {
        active[dir] = false
        applyVec()
      },
      onpointercancel: () => {
        active[dir] = false
        applyVec()
      },
      onpointerleave: () => {
        active[dir] = false
        applyVec()
      },
      oncontextmenu: (e: Event) => e.preventDefault()
    }
  }

  let actionRepeat: number | null = null

  function actionDown(e: PointerEvent): void {
    e.preventDefault()
    bus.emit(EV.action)
    if (actionRepeat !== null) window.clearInterval(actionRepeat)
    actionRepeat = window.setInterval(() => bus.emit(EV.action), 320)
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
</script>

{#if show}
  <div class="controls" aria-label="Touch controls">
    <div class="dpad">
      <button type="button" class="pad up" {...bind('up')} aria-label="Move up">▲</button>
      <button type="button" class="pad left" {...bind('left')} aria-label="Move left">◀</button>
      <button type="button" class="pad right" {...bind('right')} aria-label="Move right">▶</button>
      <button type="button" class="pad down" {...bind('down')} aria-label="Move down">▼</button>
    </div>
    <div class="actions">
      <button type="button" class="round cast" onpointerdown={castDown} onpointerup={actionUp} onpointercancel={actionUp} oncontextmenu={(e) => e.preventDefault()} aria-label="Cast ability">✦</button>
      <button type="button" class="round act" onpointerdown={actionDown} onpointerup={actionUp} onpointercancel={actionUp} oncontextmenu={(e) => e.preventDefault()} aria-label="Action">A</button>
    </div>
  </div>
{/if}

<style>
  .controls {
    position: absolute;
    left: 0;
    right: 0;
    bottom: max(10px, env(safe-area-inset-bottom));
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    padding: 0 14px;
    z-index: 25;
    pointer-events: none;
  }
  .dpad {
    display: grid;
    grid-template-columns: repeat(3, 46px);
    grid-template-rows: repeat(3, 46px);
    gap: 2px;
    pointer-events: none;
  }
  .pad {
    pointer-events: auto;
    touch-action: none;
    opacity: 0.75;
    font-size: 14px;
    border-radius: 8px;
    background: rgba(244, 228, 193, 0.9);
  }
  .pad.up { grid-column: 2; grid-row: 1; }
  .pad.left { grid-column: 1; grid-row: 2; }
  .pad.right { grid-column: 3; grid-row: 2; }
  .pad.down { grid-column: 2; grid-row: 3; }
  .actions {
    display: flex;
    gap: 10px;
    align-items: center;
    pointer-events: none;
  }
  .round {
    pointer-events: auto;
    touch-action: none;
    width: 62px;
    height: 62px;
    border-radius: 50%;
    font-size: 18px;
    font-weight: 700;
    opacity: 0.85;
    background: rgba(244, 228, 193, 0.92);
  }
  .act { background: rgba(63, 143, 139, 0.92); color: #fff7d6; }
</style>
