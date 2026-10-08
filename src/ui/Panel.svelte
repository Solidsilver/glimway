<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLAttributes } from 'svelte/elements'
  import { focusTrap } from './focus'
  import { sheet } from './sheet'
  import Icon from './Icon.svelte'
  import type { PanelMessage } from './panel-state.svelte'

  // The shell every panel shares: a modal sheet (src/ui/sheet.ts) with its
  // focus trap, and the pinned header (app.css .panel-head) holding the
  // close button, the title, anything the panel adds (`head`: tabs, a
  // loading line) and the action's message. The body is the children.
  let {
    id,
    icon,
    title,
    closeLabel,
    onClose,
    message = null,
    messageTestId,
    head,
    children,
    class: cls = '',
    panelEl = $bindable(),
    headEl = $bindable(),
    ...rest
  }: {
    /** Names the title (`${id}-title`), which labels the dialog. */
    id: string
    icon: string
    title: string
    closeLabel: string
    onClose: () => void
    message?: PanelMessage | null
    messageTestId?: string
    head?: Snippet
    children: Snippet
    class?: string
    panelEl?: HTMLElement
    headEl?: HTMLElement
  } & Omit<HTMLAttributes<HTMLDivElement>, 'id' | 'title' | 'class' | 'children'> = $props()
</script>

<div class="overlay sheet" use:sheet={onClose} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
  <div class="panel {cls}" use:focusTrap bind:this={panelEl} {...rest}>
    <header class="panel-head" bind:this={headEl}>
      <button type="button" class="modal-close" onclick={onClose} aria-label={closeLabel}><Icon name="close" size={14} /></button>
      <h2 class="panel-title" id={`${id}-title`}><Icon name={icon} size={20} /> {title}</h2>
      {@render head?.()}
      {#if message}<p class="msg {message.kind}" role="status" data-testid={messageTestId}>{message.text}</p>{/if}
    </header>
    {@render children()}
  </div>
</div>
