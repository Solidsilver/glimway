# World Bible Rewrites

These are line-level suggested rewrites of existing text in `world.ts` and `expansion-writing.ts`, aligning the content with the new World Bible.

## `src/content/world.ts`

### `locations.ruin.tagline`
**Old:**
> "Something made of stone is still keeping watch."

**New:**
> "A stone warden stands here. Not to guard a treasure, but to block a path."

### `DIALOGUE.mara` (stage: `clue-found`), `lines[1]`
**Old:**
> "So the road was not abandoned, it was closed. Something about a warden on the shrine path. Be careful up there — careful, not slow."

**New:**
> "So the road was not abandoned, it was closed. Grandmother left the warden to seal the shrine path. It won't fight you, but it won't let you pass easily either."

### `DIALOGUE.pip` (stage: `clue-found`), `lines[1]`
**Old:**
> "A stone warden. That's what the miller's dad used to call it. He said it is not mean, it is just still doing its job. Which is a lot like Orrin, actually."

**New:**
> "A stone warden. The miller's dad said Orrin built it in a hurry after the Two Storms to keep people from wandering off. It's not mean, just stubborn."

### `DIALOGUE.orrin` (stage: `accepted`), `lines[0]`
**Old:**
> "The warden on the shrine path is stone, and it is not cruel — it is dutiful, which is harder to deal with. It tests whether you know why the road was closed."

**New:**
> "The warden on the shrine path is stone. I built it to be heavy, not cruel. It's just doing the last thing I told it: stop anyone who doesn't respect the closure."

### `DIALOGUE.lantern` (stage: `new`, `accepted`, `clue-found`), `lines[0]`
**Old:**
> "The shrine lantern hangs cold in its iron frame, soot-streaked and patient. The stone warden stands between you and the lighting ledge, unmoving."

**New:**
> "The shrine lantern hangs cold in its iron frame. The stone warden stands blockading the lighting ledge, built to keep carters from going further into the Wilds."

### `JOURNAL_BY_STAGE['clue-found'][0].body`
**Old:**
> "A charcoal rubbing from the ruin’s route stone: two weaves and a break. Orrin says it is a closure mark, cut after the winter of two storms. The road was shut on purpose — and the warden is still keeping that decision."

**New:**
> "A charcoal rubbing from the ruin’s route stone: two weaves and a break. Orrin says it is a closure mark, cut after the Winter of Two Storms. The road was shut on purpose to keep carters from being swallowed by the shifting woods."

## `src/content/expansion-writing.ts`

### `HEARTHWICK_COMMONS.description`
**Old:**
> "A wide clearing of tall grass and stumps just east of the village gate. Old wagon ruts suggest this used to be a staging ground for the lantern road."

**New:**
> "A wide clearing of tall grass and stumps. The deep ruts here were left by carters who refused to heed the closure mark, right before the Winter of Two Storms."

### `BUILDER_NPC_DATA.dialogue.firstMeeting`, `lines[0]` (Silas)
**Old:**
> "Well now, a traveler settling down. I used to drive carts through here before the road closed. Now I mostly turn good timber into better roofs."

**New:**
> "A traveler settling down. I drove the last cart out of the Tangle before the Winter of Two Storms. Never went back. Now I just turn timber into roofs."

### `POIS` (id: `abandoned-cart`), `discoveryText`
**Old:**
> "Its axle is split, and the canvas is rotted. The carters must have abandoned it when the road was first closed."

**New:**
> "Its axle isn't split by wear, but by a thick oak root that grew straight through it. Whatever happened here was fast, and the carters left in a hurry."

### `POIS` (id: `frozen-pond`), `discoveryText`
**Old:**
> "The ice is thick and cloudy all year round. A carter's glove is perfectly preserved near the center, lost during a sudden frost."

**New:**
> "The ice is thick all year round. A carter's glove is preserved in the center. The ledger in Hearthwick says no carters were lost to mere frost."

### `NEW_NPC_LINES.mara[1]`
**Old:**
> "The Wilds beyond your home are restless. The old routes shift every season, just like the stories say."

**New:**
> "The Wilds beyond your home are restless. The old routes shift every season... sometimes revealing things that were swallowed during the Two Storms."
