<script lang="ts">
  import type { Session } from '../game/session'
  import { HOME_EV, SILAS, homesteadsFor } from '../game/homestead'
  import { bus } from '../game/events'
  import { HOMESTEAD_DATA, type HomeItem } from '../lib/homestead'
  import { DECORATIONS_EMBER, DECORATIONS_MATERIAL, HOMESTEAD_TIERS } from '../content/expansion-writing'
  import { MATERIALS } from '../content/expansion-writing'
  import { focusTrap } from './focus'
  import { ui } from './store.svelte'
  import Icon from './Icon.svelte'
  import { home } from './home.svelte'
  import { workshopShort } from '../game/entities/homesteads'
  import { costPhrase } from '../lib/village'

  // Silas's yard: the cottage, and the pieces he has finished. Prices come
  // from content/homestead.json; the server charges what it says, not us.
  let { session, onClose }: { session: Session; onClose: () => void } = $props()

  const homes = $derived(homesteadsFor(session))
  let version = $state(0)
  let busy = $state<string | null>(null)
  let message = $state<{ text: string; kind: 'ok' | 'error' } | null>(null)

  $effect(() => {
    const bump = () => (version += 1)
    bus.on(HOME_EV.changed, bump)
    return () => bus.off(HOME_EV.changed, bump)
  })

  const blurb = (id: string) => [...DECORATIONS_EMBER, ...DECORATIONS_MATERIAL].find((d) => d.id === id)?.blurb ?? ''
  const materialName = (id: string) => MATERIALS.find((m) => m.id === id)?.name ?? id
  const where = (it: HomeItem) => (it.where.length === 2 ? 'Indoors or out' : it.where[0] === 'indoor' ? 'Indoors' : 'Outdoors')

  const view = $derived.by(() => {
    void version
    const mine = homes.mine
    return {
      connected: homes.connected,
      ready: homes.status === 'ready' && !!mine && homes.claimed,
      tier: mine?.tier ?? 0,
      materials: homes.materials,
      owned: (id: string) => homes.ownedCount(id),
    }
  })

  const emberItems = HOMESTEAD_DATA.items.filter((i) => i.embers > 0)
  const materialItems = HOMESTEAD_DATA.items.filter((i) => i.embers === 0)
  const cottage = HOMESTEAD_DATA.tiers[1]
  const cottageBlurb = HOMESTEAD_TIERS[1].blurb
  const workshop = HOMESTEAD_DATA.tiers[2]
  const workshopBlurb = HOMESTEAD_TIERS[2].blurb
  const workshopWhy = $derived.by(() => {
    void version
    return workshopShort(ui.stats.embers, homes.materials)
  })

  function why(it: HomeItem): string | null {
    if (view.tier < it.minTier) return 'Needs the cottage'
    if (it.embers > 0 && ui.stats.embers < it.embers) return `Needs ${it.embers} embers`
    for (const [m, n] of Object.entries(it.materials)) if ((view.materials[m] ?? 0) < n) return `Needs ${n} ${materialName(m).toLowerCase()}`
    return null
  }

  async function buy(it: HomeItem): Promise<void> {
    if (busy) return
    busy = it.id
    message = null
    const r = await homes.buy(it.id)
    busy = null
    message = r.ok
      ? { text: `${it.name} is yours. It’s in your storage: arrange it at your place.`, kind: 'ok' }
      : { text: r.code === 'insufficient-embers' ? SILAS.dialogue.notEnoughEmbers.lines[0] : r.text, kind: 'error' }
  }

  async function raise(): Promise<void> {
    if (busy) return
    busy = 'cottage'
    message = null
    const r = await homes.upgrade()
    busy = null
    message = r.ok ? { text: homes.mine?.tier === 2 ? 'There. Deep eaves, a heavy bench, and a chest that won’t drink the damp. Go and make something.' : SILAS.dialogue.afterUpgrade.lines[0], kind: 'ok' } : { text: r.code === 'insufficient-embers' ? SILAS.dialogue.notEnoughEmbers.lines[0] : r.text, kind: 'error' }
  }

  const cost = (it: HomeItem) =>
    it.embers > 0 ? `${it.embers} embers` : Object.entries(it.materials).map(([m, n]) => `${n} ${materialName(m).toLowerCase()}`).join(' · ')
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="shop-title">
  <div class="panel" use:focusTrap>
    <button type="button" class="modal-close" onclick={onClose} aria-label="Close Silas’s yard"><Icon name="close" size={14} /></button>
    <h2 class="panel-title" id="shop-title"><Icon name="home" size={20} /> Silas’s Yard</h2>

    <div class="silas">
      {#if ui.portraits[SILAS.name]}<img src={ui.portraits[SILAS.name]} alt="" class="portrait" />{/if}
      <p>“{SILAS.dialogue.sellDecorations.lines[0]}”</p>
    </div>

    {#if !view.connected}
      <p class="msg">Plots on the Commons are for people with a world. Sign in to your world from the Menu, and Silas will stake you one.</p>
    {:else if !view.ready}
      <p class="msg">Talk to Silas about your plot first: he likes to walk it with you.</p>
    {:else}
      <p class="balance" aria-live="polite">
        <span><Icon name="ember" size={14} /> {ui.stats.embers} embers</span>
        {#each MATERIALS as m (m.id)}
          {#if (view.materials[m.id] ?? 0) > 0}<span>{view.materials[m.id]} {m.name.toLowerCase()}</span>{/if}
        {/each}
      </p>
      {#if message}<p class="msg {message.kind}" role="status">{message.text}</p>{/if}

      {#if view.tier === 0}
        <section aria-label="The cottage">
          <h3 class="section-title">The cottage</h3>
          <div class="row feature">
            <span class="txt">
              <span class="name">{cottage.name}</span>
              <span class="desc">{cottageBlurb} Unlocks the inside and setting things out.</span>
            </span>
            <button type="button" class="primary small" disabled={busy !== null || ui.stats.embers < cottage.embers} onclick={raise}>
              {busy === 'cottage' ? 'Raising…' : `Raise it · ${cottage.embers}`}
            </button>
          </div>
        </section>
      {/if}

      {#if view.tier === 1}
        <section aria-label="The workshop">
          <h3 class="section-title">The workshop</h3>
          <div class="row feature">
            <span class="txt">
              <span class="name">{workshop.name}</span>
              <span class="desc">{workshopBlurb} Unlocks the storage chest and the crafting bench.</span>
              <span class="meta">{workshop.embers} embers · {costPhrase(workshop.materials ?? {})}</span>
            </span>
            <button type="button" class="small" class:primary={!workshopWhy} data-testid="build-workshop" disabled={busy !== null || !!workshopWhy} onclick={raise}>
              {busy === 'cottage' ? 'Building…' : workshopWhy ?? 'Build it'}
            </button>
          </div>
        </section>
      {/if}

      {#each [{ title: 'Finished pieces', list: emberItems }, { title: 'From the Wilds', list: materialItems }] as group (group.title)}
        <section aria-label={group.title}>
          <h3 class="section-title">{group.title}</h3>
          <ul>
            {#each group.list as it (it.id)}
              {@const reason = why(it)}
              <li class="row">
                <span class="thumb" aria-hidden="true">{#if home.thumbs[it.id]}<img src={home.thumbs[it.id]} alt="" />{/if}</span>
                <span class="txt">
                  <span class="name">{it.name}{#if view.owned(it.id) > 0}<span class="owned">· own {view.owned(it.id)}</span>{/if}</span>
                  <span class="desc">{blurb(it.id)}</span>
                  <span class="meta">{where(it)} · {it.footprint[0]}×{it.footprint[1]} · {cost(it)}</span>
                </span>
                <button type="button" class="small" class:primary={!reason} data-buy={it.id} disabled={busy !== null || !!reason} onclick={() => buy(it)} title={reason ?? ''}>
                  {busy === it.id ? 'Buying…' : reason ?? 'Buy'}
                </button>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    {/if}
  </div>
</div>

<style>
  .silas {
    display: flex;
    gap: 10px;
    align-items: center;
    margin: 0 0 10px;
  }
  .silas p {
    margin: 0;
    font-style: italic;
    color: var(--text-soft);
    font-size: 14px;
  }
  .portrait {
    width: 42px;
    height: 42px;
    image-rendering: pixelated;
    border: 2px solid var(--wood);
    border-radius: 8px;
    background: var(--paper-dark);
    flex: none;
  }
  .balance {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    margin: 0 0 8px;
    font-weight: 800;
    color: var(--wood-dark);
  }
  .balance span {
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  .msg {
    margin: 8px 0;
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 14px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.4);
  }
  .msg.error {
    border-color: rgba(196, 82, 58, 0.6);
  }
  .msg.ok {
    border-color: rgba(47, 127, 122, 0.55);
  }
  .section-title {
    text-transform: none;
    letter-spacing: 0.04em;
    font-size: 14px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 9px;
    border: 2px solid var(--paper-line);
    background: rgba(255, 255, 255, 0.22);
  }
  .row.feature {
    border-color: var(--gold-deep);
    background: rgba(255, 233, 160, 0.3);
  }
  .txt {
    display: grid;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }
  .name {
    font-weight: 800;
    color: var(--wood-dark);
  }
  .owned {
    margin-left: 6px;
    font-weight: 600;
    font-size: 12.5px;
    color: var(--accent);
  }
  .desc {
    font-size: 13px;
    color: var(--text-soft);
    line-height: 1.35;
  }
  .meta {
    font-size: 12px;
    color: var(--text-faint);
  }
  .thumb {
    flex: none;
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: rgba(107, 76, 46, 0.12);
  }
  .thumb img {
    image-rendering: pixelated;
    max-width: 36px;
    max-height: 36px;
    transform: scale(1);
  }
  .small {
    flex: none;
    padding: 5px 10px;
    font-size: 13.5px;
    max-width: 9.5em;
    white-space: normal;
  }
</style>
