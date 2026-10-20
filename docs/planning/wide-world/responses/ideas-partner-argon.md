# Wide World Live Brainstorm Notes (Argon)

*Session on 2026-10-20 with the owner.*

---

## 1. The Whitequiet (Settled)

### Lore & Emotional Core (for Canon §2.4 rewrite)
- **The earth has "stopped trying" to remember itself:**
  - In the green Wilds, the weekly Turning is the hurting earth *still trying*—doing the hard work of reaching for its trees, streams, and seasons.
  - *"the land has 'stopped trying' to remember itself, and so it forgets, and it forgets those who enter (which is part of why people often get lost). It's a very sad place, seeing a place that has stopped trying, part of the earth that has basically given up the hard work."*
- **Tied to Fallbrine's Unyoking (§2.2):**
  - *"outside of hard work and community building, etc the curse of the past attempt at stopping the need for work has affected the whole world. But the whitequiet is one place where 'evil' has sort of won in a way. There is no work in the whitequiet. And it tries to lull you to a dreamy, sleepy end. The land itself is not angry, but has been overcome. It may even require additional power to reclaim and redeem."*
- **Why trinkets and Echoes surface there:**
  - They are the last stubborn sparks of human care and unfinished work in a place where the ground itself gave up, standing out in warm colour against the pale grass because *they* haven't forgotten who they belong to.

### Gameplay & Mechanics
1. **Thick Fog (reusing the height-lab fog system):**
   - Entering the Whitequiet surrounds the biome and the player with a fairly thick pale fog (reusing the mountain/height fog tech) so far landmarks are hard to discern (~12 tiles sight radius).
2. **Three-stage disorientation ("Walk by stone, not by path"):**
   - *Owner:* *"Actually, all of them mixed sounds great. It makes the whitequiet feel quite disconcerting."*
   - **Stage 1 — False Paths & Subtle Veer:** Faint tracks in the pale feather-grass curve in slow spirals; when **unmoored**, walking straight without a landmark gently pulls your heading a few degrees sideways while the map window blurs outside your sight halo. Physical **turncaps** (leaning toward the nearest held light) and **route stones** are your true compass.
   - **Stage 2 — Mist-Wrapped Chunk Slip:** Route stones, lamp stones, lit way-lamps, and turncaps pin the geometry around them. Walk out into blank white grass with no stone or light in sight, and crossing a chunk border seamlessly crossfades (3-tile white mist) to loop you back toward the stone you left—so the same leaning route stone emerges from the fog ahead of you again.
   - **Stage 3 — Memory Hollows (`layer −1` glades):** Stepping into weeping silver-willow rings—or slipping repeatedly in deep mist—crossfades in white onto `layer −1` into a hushed **Memory Glade** outside normal coordinates, holding an **Echo** or warm **trinket**. Leaving blind steps you out at a random willow ring chunks away; settling the Echo's owed lamp parts the mist back to a safe route stone.
3. **Staying together keeps you safe:**
   - Walking with a friend (staying within each other's lantern/sight halo) anchors you both so the Whitequiet cannot slip or loop you.
4. **Waking an island of the Whitequiet (Option #1 — harder than settling a plot/lamp elsewhere):**
   - A plain way-lamp set in the Whitequiet burns tiny and hollow (clearing only a small breather in the mist; the ground stays white and asleep).
   - To **wake a 1-chunk island** so the earth starts trying again, you find an old root/memory spot (an Echo, a lamp stone, or a dormant tree) and do three things:
     1. **Mend & Name:** Repair the base and speak a full **Keeper's naming**.
     2. **Higher Power/Fuel:** Kindle it with **storm-grade amber** (or glim-enriched hearth oil).
     3. **Bring Living Work:** Plant and tend live seeds/saplings brought from the waking woods.
   - Over 1–2 wicks of kept light, green grass, wildflowers, and birdsong bloom back inside that Woken Island.
5. **Penalty for falling asleep in the Whitequiet (Options #2 + #3):**
   - Once fully unmoored in the Whitequiet, the sleepy cold ticks your HP down to **1 HP** until you doze off in the pale grass.
   - **Glims burned for warmth (#3):** A handful of glims in your purse spend their light to keep you from freezing in your sleep (turning back into dull unlit amber beads).
   - **Forage washes to Pell's crate (#2):** You wake up back at safe ground at **1 HP**, and the forage/loot bundle from your outing slipped from your sleepy hands and washed through the drift into **Pell's recovery crate**—requiring a walk of shame to Pell's office and a small clerk's recovery fee (Rule-3 safe: zero permanent item loss, no free teleport exploit).

---

## 2. Creatures in the Wide World (Settled)

### 0.14 Biome Creature Roster & Readable Behaviours
- *Owner:* *"I love mountain goats that climb, and the fen-lanterns sound awesomely creepy."*

| Biome | Ordinary animal (harmless, client-clock; reveals things) | Unmoored beast (fevered animal) | Thing of the Dark (disperses when beaten) |
|---|---|---|---|
| **Woods & Meadow** | **Red squirrel / Hare** — bolts along clear trails or hops up to a hollow log with turncaps/nuts | **Iron-horn beetle & Bracken-boar** — short telegraph charge down lanes | **Gloom-wisp** — drifts between tree shadows, fires slow cold bolts at lantern-bearers |
| **Lake Country** | **Duck / Kingfisher** — ducks paddle where fish stock is high; kingfisher darts straight toward clay banks or sunken gravel spits | **Mire-toad / Marsh-crab** — toad puffs up and croaks a knockback ring; crab sidesteps and guards reed-beds | **Fen-lantern** — mimics the warm golden glow of a communal lamp from far off, then turns cold violet when you step within 6 tiles |
| **The Tops (Mountains)** | **Mountain goat** — walks up and down valid switchbacks and ledges (literally showing you how to climb a cliff) | **Fevered ram / Crag-beetle** — charges along narrow ledges or curls into a rolling boulder down ramps | **Draught-mote (Wind-wisp)** — swirls on windy saddles and tries to gust you back down a ramp |
| **Caves (`layer −1`)** | **Glow-moth / Blind cave-fish** — moths flutter toward the nearest exit mouth's daylight; fish gather near your lantern | **Cave-cricket / Rock-back beetle** — hides looking like a stalagmite or boulder until your light touches it, then leaps | **Shadow-leech / Silence-tendril** — hugs the dark rim just outside your lantern's radius and shrinks your light circle until you hit it with Fingersnap |
| **The Whitequiet** | **Pale hart & White moths** — moths spiral over buried trinkets; walk *slowly* behind a hart and it leads you to a route stone or exit | *(None — no fights in the Whitequiet)* | *(None)* |

### Moral Choice with Unmoored Beasts: Defeat vs. Break the Spell
- **Owner's call:** Allow players to **either defeat the unmoored beast outright OR break them out of their spell**, giving a real moral choice in encounters (mirroring canon §5.5's choice with the fallen):
  - **How you choose (#1 — Stagger window + Glim/Light or Working):** When fought down to low HP (~15%), the beast staggers. Since **Fingersnap** may become a spell-specific/Practice-specific working, *either* specific spellcasters/Practices can break the spell with their working, *or* any player can supply a **glim** or hold up a **light** to break the fever.
  - **Break the spell (Option A + Redeemed Animal):** A dark smoky fever-crust shatters off their back (dropping shed carapace / fever-slag / tangled tuft), their eyes return from cold violet to warm brown, and they either flee into the woods **or turn into a peaceful ordinary animal in that chunk** for the rest of the wick.
  - **Defeat by force:** Keep striking with your weapon through the stagger to slay them outright for direct beast drops/trophies.
- **Full canon lore draft:** Written up in [creature-lore-argon.md](creature-lore-argon.md) (with proposed additions to `canon.md` §2.5 and replacement for §5.4).

### Rejected / Skipped Ideas
- **Pre-fight ground warning signs around territories:** Owner passed on adding special ground decals (gouged bark, frost patches) around creature territories—keep the ground clean and simple.

---

## 3. Open Threads for Next Time
- Sketching tile-by-tile ASCII places for the next height-lab round (three-ring lake shores with sunken spits, skylight cenotes, saddle passes).
- Macro-landform rules across independent 24×24 chunks (rivers stepping downhill `2 → 1 → 0`, mountain ranges, cave layouts).
- Frets (how they contrast with the Whitequiet and how light repaints them).
- Seasons/marks on the land and long-walk rewards in the far Wilds.
