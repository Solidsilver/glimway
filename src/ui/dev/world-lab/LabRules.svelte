<script lang="ts">
  import { labCheck } from './lab-api'
  import { jsonProblem } from './lab-view'

  // The world lab's rules editor (WorldLab.svelte): an editable copy of
  // content/wilds.json, started from the server's own. Problems show as
  // you type: the JSON's own first, then the server's validation (decoded
  // there, never installed). Download it for a lane to commit.
  let {
    text = $bindable(),
    server,
    problem = $bindable()
  }: {
    /** The edited rules. */
    text: string
    /** The server's embedded rules. */
    server: string
    /** Null: the edited rules are good to render with. */
    problem: string | null
  } = $props()

  let checking = $state(false)
  const edited = $derived(text !== server)
  const lines = $derived(text.split('\n').length)

  let timer: ReturnType<typeof setTimeout> | undefined
  let asking: AbortController | null = null
  $effect(() => {
    const t = text
    clearTimeout(timer)
    asking?.abort()
    const local = jsonProblem(t)
    if (local || t === server) {
      problem = local
      checking = false
      return
    }
    checking = true
    timer = setTimeout(() => {
      const ctl = new AbortController()
      asking = ctl
      labCheck(t, ctl.signal)
        .then((a) => {
          if (ctl.signal.aborted) return
          problem = a.ok ? null : a.text
          checking = false
        })
        .catch(() => {})
    }, 500)
    return () => clearTimeout(timer)
  })

  function download(): void {
    const url = URL.createObjectURL(new Blob([text.endsWith('\n') ? text : text + '\n'], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'wilds.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function load(e: Event): Promise<void> {
    const f = (e.currentTarget as HTMLInputElement).files?.[0]
    if (f) text = await f.text()
    ;(e.currentTarget as HTMLInputElement).value = ''
  }

  function tidy(): void {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2) + '\n'
    } catch {
      // jsonProblem already says why.
    }
  }
</script>

<div class="rules">
  <p class="what">
    Your copy of <code>content/wilds.json</code>. Renders with “edited rules” use it, in a worker process of their own; the server’s rules never change. It stays in this browser until you reset it.
  </p>
  <div class="bar">
    <span class="state" data-state={problem ? 'bad' : checking ? 'checking' : edited ? 'edited' : 'same'} role="status">
      {problem ? 'Has a problem' : checking ? 'Checking…' : edited ? 'Edited, valid' : 'Same as the server’s'}
    </span>
    <button type="button" class="small" onclick={tidy} disabled={!!jsonProblem(text)}>Tidy</button>
    <button type="button" class="small" onclick={() => (text = server)} disabled={!edited}>Reset to the server’s</button>
    <button type="button" class="small" onclick={download}>Download</button>
    <label class="small file">Load a file<input type="file" accept=".json,application/json" onchange={load} /></label>
  </div>
  {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
  <textarea bind:value={text} spellcheck="false" autocomplete="off" aria-label="The edited wilds rules, JSON" rows={Math.min(40, lines)}></textarea>
</div>

<style>
  .rules {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    flex: 1;
  }
  .what {
    margin: 0;
    font-size: 13px;
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .state {
    flex: 1 1 100%;
    font-size: 12px;
    font-weight: 700;
  }
  .state[data-state='bad'] {
    color: var(--danger-text);
  }
  .state[data-state='edited'] {
    color: var(--accent);
  }
  .small {
    padding: 5px 10px;
    font-size: 13px;
    min-height: 34px;
  }
  .file {
    display: inline-flex;
    align-items: center;
    cursor: pointer;
    font-family: var(--font-display);
    border: 2px solid var(--wood-dark);
    border-radius: 9px;
    background: linear-gradient(180deg, #fff6dd 0%, #f0dcae 100%);
  }
  .file:focus-within {
    outline: 3px solid var(--gold);
  }
  .file input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  .problem {
    margin: 0;
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--danger-wash);
    color: var(--danger-text);
    font-size: 13px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  textarea {
    flex: 1;
    min-height: 240px;
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    font: 12px/1.45 ui-monospace, 'SFMono-Regular', Menlo, monospace;
    tab-size: 2;
    padding: 8px;
    border: 2px solid var(--paper-line);
    border-radius: 8px;
    background: var(--cream-hi);
    color: var(--text);
  }
</style>
