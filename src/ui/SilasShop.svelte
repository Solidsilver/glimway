<script lang="ts">
  import type { Session } from '../game/session'
  import { SILAS, homesteadsFor } from '../game/homestead'
  import { bus, EV } from '../game/events'
  import { HOMESTEAD_DATA, type HomeItem } from '../lib/homestead'
  import { DECORATIONS_EMBER, DECORATIONS_MATERIAL, HOMESTEAD_TIERS } from '../content/expansion-writing'
  import { MATERIALS } from '../content/expansion-writing'
  import { actionRunner, busVersion } from './panel-state.svelte'
  import { ui } from './store.svelte'
  import Icon from './Icon.svelte'
  import Panel from './Panel.svelte'
  import ArtIcon from './ArtIcon.svelte'
  import { home } from './home.svelte'
  import { workshopShort } from '../lib/village'
  import { costPhrase } from '../lib/village'

  // Silas's yard: the cottage, and the pieces he has finished. Prices come
  // from content/homestead.json; the server charges what it says, not us.
  let { session, onClose }: { session: Session; onClose: () => void } = $props()

  const homes = $derived(homesteadsFor(session))
  const changed = busVersion(bus, EV.homeChanged)
  const action = actionRunner()
  /** Silas's own word for being short of embers. */
  const refused = (r: { code: string; text: string }) => (r.code === 'insufficient-embers' ? SILAS.dialogue.notEnoughEmbers.lines[0] : r.text)

  const blurb = (id: string) => [...DECORATIONS_EMBER, ...DECORATIONS_MATERIAL].find((d) => d.id === id)?.blurb ?? ''
  const materialName = (id: string) => MATERIALS.find((m) => m.id === id)?.name ?? id
  const where = (it: HomeItem) => (it.where.length === 2 ? 'Indoors or out' : it.where[0] === 'indoor' ? 'Indoors' : 'Outdoors')

  const view = $derived.by(() => {
    void changed.value
    const mine = homes.mine
    return {
      connected: homes.connected,
      ready: homes.status === 'ready' && !!mine && homes.claimed,
      tier: mine?.tier ?? 0,
      materials: homes.materials,
      owned: (id: string) => homes.ownedCount(id),
    }
  })

  const emberItems = HOMESTEAD_DATA.items.filter((i) => i.embers > 0 && !i.craftOnly)
  const materialItems = HOMESTEAD_DATA.items.filter((i) => i.embers === 0 && !i.craftOnly)
  const cottage = HOMESTEAD_DATA.tiers[1]
  const cottageBlurb = HOMESTEAD_TIERS[1].blurb
  const workshop = HOMESTEAD_DATA.tiers[2]
  const workshopBlurb = HOMESTEAD_TIERS[2].blurb
  const workshopWhy = $derived.by(() => {
    void changed.value
    return workshopShort(ui.stats.embers, homes.materials)
  })

  /** What a piece costs right now: a lantern post costs more for each one the home has bought. */
  function price(it: HomeItem): Record<string, number> {
    void changed.value
    return it.id === HOMESTEAD_DATA.lanternPosts.item ? homes.mine?.nextPost ?? it.materials : it.materials
  }

  function why(it: HomeItem): string | null {
    if (view.tier < it.minTier) return 'Needs the cottage'
    if (it.embers > 0 && ui.stats.embers < it.embers) return `Needs ${it.embers} embers`
    for (const [m, n] of Object.entries(price(it))) if ((view.materials[m] ?? 0) < n) return `Needs ${n} ${materialName(m).toLowerCase()}`
    return null
  }

  async function buy(it: HomeItem): Promise<void> {
    await action.run(
      it.id,
      () => homes.buy(it.id),
      it.id === HOMESTEAD_DATA.lanternPosts.item ? `${it.name} is yours. Set it at the edge of your light and give it a name: the ground it lights is yours.` : `${it.name} is yours. It’s in your pack: arrange it at your place.`,
      refused
    )
  }

  async function raise(): Promise<void> {
    await action.run('cottage', () => homes.upgrade(), () => (homes.mine?.tier === 2 ? 'There. Deep eaves, a heavy bench, and a chest that won’t drink the damp. Go and make something.' : SILAS.dialogue.afterUpgrade.lines[0]), refused)
  }

  const cost = (it: HomeItem) =>
    it.embers > 0 ? `${it.embers} embers` : Object.entries(price(it)).map(([m, n]) => `${n} ${materialName(m).toLowerCase()}`).join(' · ')
</script>

<Panel id="shop" icon="home" title="Silas’s Yard" closeLabel="Close Silas’s yard" {onClose}>

  <div class="silas">
    {#if ui.portraits[SILAS.name]}<img src={ui.portraits[SILAS.name]} alt="" class="portrait" />{/if}
    <p>“{SILAS.dialogue.sellDecorations.lines[0]}”</p>
  </div>

  {#if !view.ready}
    <p class="msg">Talk to Silas about a deed first: pick a gate on the lane, and he’ll draw it up.</p>
  {:else}
    <p class="balance" aria-live="polite">
      <span><Icon name="ember" size={14} /> {ui.stats.embers} embers</span>
      {#each MATERIALS as m (m.id)}
        {#if (view.materials[m.id] ?? 0) > 0}<span><ArtIcon art={`icon-${m.id}`} size={16} /> {view.materials[m.id]} {m.name.toLowerCase()}</span>{/if}
      {/each}
    </p>
    {#if action.message}<p class="msg {action.message.kind}" role="status">{action.message.text}</p>{/if}

    {#if view.tier === 0}
      <section aria-label="The cottage">
        <h3 class="section-title">The cottage</h3>
        <div class="row feature">
          <span class="txt">
            <span class="name">{cottage.name}</span>
            <span class="desc">{cottageBlurb} Unlocks the inside and setting things out.</span>
          </span>
          <button type="button" class="primary small" disabled={action.busy !== null || ui.stats.embers < cottage.embers} onclick={raise}>
            {action.busy === 'cottage' ? 'Raising…' : `Raise it · ${cottage.embers}`}
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
          <button type="button" class="small" class:primary={!workshopWhy} data-testid="build-workshop" disabled={action.busy !== null || !!workshopWhy} onclick={raise}>
            {action.busy === 'cottage' ? 'Building…' : workshopWhy ?? 'Build it'}
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
              <button type="button" class="small" class:primary={!reason} data-buy={it.id} disabled={action.busy !== null || !!reason} onclick={() => buy(it)} title={reason ?? ''}>
                {action.busy === it.id ? 'Buying…' : reason ?? 'Buy'}
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  {/if}
</Panel>

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
    width: 64px;
    height: 64px;
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
    padding: 8px 10px;
    font-size: 14px;
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
    background: var(--wood-wash);
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
