<script lang="ts">
  /**
   * The Character panel's Abilities section (crafts.md 4.2): the basic
   * attack, the signature and the level-20 move, with a locked line for
   * any move still ahead ("At level 20: Ward-light"). A hero without a craft
   * fights with what's in hand, and the section says so.
   */
  import type { CombatKit, KitMove } from '../lib/combat'
  import { isTouchFirst } from './device'
  import Icon from './Icon.svelte'
  import ArtIcon from './ArtIcon.svelte'

  let { kit }: { kit: CombatKit } = $props()

  const touch = isTouchFirst()
  const n = (v: number) => Math.max(1, Math.round(v))
  const pct = (v: number) => Math.round(v * 100)
  const secs = (v: number) => (Math.round(v * 10) / 10).toString()
  const tiles = (v: number) => (Math.round(v * 10) / 10).toString()

  /** What a move does, in a line, from its numbers. */
  function does(m: KitMove): string {
    const x = m.numbers
    switch (m.id) {
      case 'cleave':
        return `Sweeps everything in front for about ${n(kit.signatureDamage)}.`
      case 'fingersnap':
        return `A snap of light that hits for about ${n(kit.signatureDamage)}.`
      case 'shadowstep':
        return `Dash through, striking for about ${n(kit.signatureDamage)}.`
      case 'mend':
        return `A pulse that hits for about ${n(kit.signatureDamage)} and mends ${n(kit.healAmount)} health.`
      case 'stand':
        return `Plant your feet for ${secs(x.durationSeconds)}s: a lunge that reaches you stops short and staggers.`
      case 'kindle':
        return `A patch of hollow light ${tiles(x.radiusTiles * 2)} tiles across, ahead of you, for ${secs(x.durationSeconds)}s. Anything inside slows.`
      case 'ward-light':
        return `A still circle at your feet for ${secs(x.durationSeconds)}s, mending anyone inside ${x.pulses} times${kit.wardPulseHeal > 0 ? ` (${n(kit.wardPulseHeal)} each)` : ''}.`
      case 'echo':
        return `Leave a faded copy of yourself; creatures go for it for ${secs(x.durationSeconds)}s.`
      default:
        return ''
    }
  }

  const moves = $derived([kit.signature, kit.move].filter((m): m is KitMove => !!m))
  const key = (m: KitMove) => (m.kind === 'signature' ? (touch ? '✦' : 'F') : touch ? '2nd ✦' : 'R')
</script>

<h3 class="section-title">Abilities</h3>
<div class="abilities" data-testid="abilities">
  <div class="ability">
    <div class="ai"><Icon name="sword" size={22} /></div>
    <div class="ab">
      <div class="ah"><b>{kit.basicName}</b> {#if !touch}<span class="kbd">E</span>{/if}</div>
      <p>Hits for about <b>{n(kit.meleeDamage)}</b>. Ready again in {secs(kit.basicAttackCooldown)}s.</p>
    </div>
  </div>
  {#each moves as m (m.id)}
      <div class="ability magic" data-ability={m.id}>
        <div class="ai"><ArtIcon art={m.icon} name="sparkle" size={32} /></div>
        <div class="ab">
          <div class="ah"><b>{m.name}</b> <span class="kbd">{key(m)}</span> <span class="cost"><Icon name="drop" size={10} />{m.mana}</span></div>
          <p>{does(m)}</p>
        </div>
      </div>
  {/each}
</div>
{#if !kit.class}
  <p class="plain">You fight with what’s in hand. A class chosen on Habitica brings its moves from level 10.</p>
{/if}
{#if kit.ahead.length}
  <ul class="ahead">
    {#each kit.ahead as m (m.id)}
      <li data-locked={m.id}><Icon name="key" size={12} /> At level {m.level}: {m.name}</li>
    {/each}
  </ul>
{/if}
<div class="chips">
  <span class="chip"><Icon name="star" size={12} /> {pct(kit.critChance)}% critical hits (2×)</span>
  <span class="chip"><Icon name="heart" size={12} /> Shrugs off {pct(kit.mitigation)}% of damage</span>
</div>

<style>
  .abilities {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .ability {
    display: flex;
    gap: 10px;
    padding: 10px;
    background: rgba(255, 255, 255, 0.4);
    border: 2px solid var(--paper-line);
    border-radius: 10px;
  }
  .ai {
    width: 42px;
    height: 42px;
    flex: none;
    display: grid;
    place-items: center;
    border: 2px solid var(--wood-dark);
    border-radius: 10px;
    background: linear-gradient(180deg, var(--paper-hi), var(--paper-dark));
    color: var(--wood-dark);
    overflow: hidden;
  }
  .magic .ai {
    background: linear-gradient(180deg, #d6e6ff, #8fb3ec);
    color: #20365c;
  }
  .ah {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-display);
    font-size: 16px;
  }
  .ah b {
    font-weight: 600;
  }
  .ab p {
    margin: 2px 0 0;
    font-size: 13.5px;
    color: var(--text-soft);
  }
  .cost {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 5px;
    font-size: 11px;
    color: #fff;
    background: var(--mana);
    border-radius: 6px;
  }
  .plain {
    margin: 8px 0 0;
    font-size: 13.5px;
    color: var(--text-soft);
  }
  .ahead {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  .ahead li {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-faint);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px;
    font-size: 12.5px;
    font-weight: 700;
    color: var(--text-soft);
    background: rgba(255, 255, 255, 0.45);
    border: 1.5px solid var(--paper-line);
    border-radius: 999px;
  }
  .chip :global(.icon) {
    color: var(--gold-deep);
  }
  /* Phones: one column. */
  @media (max-width: 560px) {
    .abilities {
      grid-template-columns: 1fr;
    }
  }
</style>
