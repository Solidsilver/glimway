# Licensing and funding

Status: draft for the owner, 2026-10-07. Not legal advice. Each finding below says whether it is
**certain** (read in the primary source), **likely** (good secondary source) or my
**interpretation**. Related: [habitica-policy.md](habitica-policy.md) (Habitica's third-party
rules and the publish plan), [habitica-boundary.md](habitica-boundary.md) (what the game takes
from Habitica) and `ASSETS.md` (the asset register).

## Decisions so far

- **2026-10-07: no donations for now.** The game stays free, with no tip jar. Revisit only if it
  grows enough that hosting costs matter. The funding research below stays as the reference for
  that day.
- **2026-10-07: the game becomes Glimway**, renamed before the repo is published. "Glim" is an old
  word for a light or candle, so a glimway is a road of little lights. Knockout check in section 8;
  rename scope in "Renaming to Glimway" below.

- **2026-10-07: code is AGPL-3.0-or-later.**
- **2026-10-07: outside contributions use the DCO** (a `Signed-off-by` line on each commit).
- **2026-10-07: AI is disclosed plainly** in the README and the Habitica form. The game was built
  by AI agents, and the art was generated with OpenAI's image generation through Codex (the packs'
  `prompts.json` record "Codex built-in image generation"; confirm the exact model name before
  publishing). The owner would prefer human-made art and generated it only to make the game
  playable first. Say that too, and welcome artists.
- **2026-10-07: lean on Habitica art for now, and keep a way out.** Make it a standing goal that
  everything Habitica supplies (avatar, gear, pets and the sprites) has a backup of our own, so a
  spin-off not tied to Habitica stays possible.
- **2026-10-07: our current art is CC0.** All of the non-Habitica art is AI-generated today, so
  there's nothing to attribute. A licence is chosen per work, so future human-made art can carry a
  different licence (for example CC BY-SA 4.0). Keep it in its own folder with its own `LICENSE`,
  and record each asset's licence in `ASSETS.md`. CC0 can't be withdrawn from art already released
  under it.

## Summary

The owner's guess is half right. Habitica's art is CC BY-NC-SA 3.0, so any instance that serves it
must not be run mainly to make money. That limit attaches to the Habitica sprites and to how an
instance uses them. It does not make our own code or our own art non-commercial, and ShareAlike
doesn't spread to them as long as we show the sprites unmodified.

In practice: a free game with an optional tip jar and a public cost ledger is fine today, with
the art as it is. That's what several Habitica tools already do, and nothing in Habitica's rules
forbids it. Paid tiers, ads and anything sold inside the game are the things that need either
Habitica's written permission or a game with no Habitica art in it.

Two findings change the picture more than the NC question does:

- **Our own art is almost all AI-generated**, and US law gives no copyright to purely
  prompt-generated images (settled when the Supreme Court declined *Thaler* in March 2026). We can
  label it with any licence, but we can't stop anyone copying it. The thing we can actually own is
  the **name**, through trademark. That makes the rename the most valuable licensing decision on
  this page.
- **Habitica's culture is wary of AI.** Its repo now refuses LLM-written code, and its art was made
  by volunteer pixel artists. A game built by AI agents, mixing generated art with that volunteer
  art, should say so plainly when it's published and when it's submitted to staff.

### Decision table

| Option | What it allows | What it costs | Risk while Habitica art ships |
|---|---|---|---|
| **Tip jar** (GitHub Sponsors, Ko-fi tips, Liberapay), no perks | Covers the server and some dev time | GitHub Sponsors 0% from personal accounts; Liberapay 0% plus ~3-5% processing; Ko-fi 0% on tips | Low. Existing Habitica tools do it. |
| **Public cost ledger** | Shows donations pay for hosting; builds trust | A page we keep current | Lowers risk: it's the clearest sign the use isn't "directed toward monetary compensation" |
| **Open Source Collective** (fiscal host) | Ledger built in; can take company money and invoices | 10% host fee; wants an OSI licence and an org repo; suggests other tools under ~$600/yr | Low. Hosts games already (Veloren, Space Station 14). |
| **Patreon or Ko-fi membership**, perks outside the game (credits line, devlogs, Discord role) | Recurring income | Patreon 10% plus processing; Ko-fi 5% on memberships (free plan) | Low to moderate |
| **Supporter perks inside the game** (a name on a village board, a badge) | More reason to give | Design and art work | Grey. Money buys something in an instance that serves NC art. Also cuts against Habitica's "play to win, not pay to win" culture. |
| **Merch of our own art** | Shirts, prints, stickers | Print-on-demand margins | Fine for NC (our art isn't NC). But AI art has no copyright, so others can sell the same images; only the name is protectable. Never put Habitica sprites on merch. |
| **Paid hosted tier, premium features, ads, sold cosmetics** | Real revenue | Engineering, plus the problems in the next column | High. Needs Habitica's written permission or no Habitica art. A paid tier built on Habitica accounts is worth asking staff about even without their art (see the ToS note in section 1). |
| **Grants** (NLnet, Prototype Fund, Sovereign Tech Fund, Epic MegaGrants) | Lump sums | Applications | Not eligible or a poor fit for a US solo game (section 7) |
| **Path A: replace all Habitica art** | Commercial freedom for the art | A full avatar, gear, pet and mount art set, **and** it breaks the boundary rule "show the player's real gear" | None, but the game loses the "play as your Habitica hero" look |
| **Path B: ask Habitica for permission** | Whatever they grant | One email to admin@habitica.com | No known precedent of a grant; staff have been relaxed in public |
| **Path C: live mirror only, never bundled** | Less copying on our side | Reworking how avatars load (S3 sends no CORS headers) | Still NC-bound. Reduces exposure, doesn't remove it. |

## Recommendation

1. **Rename before publishing.** Everything in this doc gets cheaper if the name is settled before
   the repo, the Habitica form and any donation pages exist. Shortlist in section 8.
2. **Code: AGPL-3.0-or-later.** A self-hostable game server is exactly what the AGPL is for: anyone
   who runs a modified copy for others has to publish it, which also keeps forks inside Habitica's
   "tools used by others must publish their code" rule. It matches Lichess, Mastodon and
   Plausible, and it's compatible with Habitica's GPL-3.0 if we ever need their code. As the sole
   copyright holder, the owner isn't bound by it and can still offer other terms later, as long as
   outside contributions come in under terms that allow it (see question 4).
3. **Our art and writing: CC BY-SA 4.0**, with a plain note that much of it is AI-generated and may
   not be copyrightable, so the licence covers whatever rights exist (the human edits, selection
   and arrangement). It matches the open-game norm (Luanti, Wesnoth, 0 A.D.), is one-way compatible
   with GPLv3, and asks for credit, which most people give whether or not it's enforceable. CC0 is
   the honest alternative; "all rights reserved" doesn't work, because self-hosters need
   permission to serve the art.
4. **Habitica's material stays under its own terms**, kept apart and labelled: the sprites under
   CC BY-NC-SA 3.0 with a `LICENSE` file in `public/assets/habitica/`, the gear numbers under a
   GPL-3.0 notice. Fix the credits (section 2).
5. **Funding (deferred; owner chose no donations for now):** if it's ever needed, free for
   everyone, a tip jar, and a public cost ledger. GitHub Sponsors (no fee) as
   the main link, plus Ko-fi or Liberapay for people without GitHub. Thanks go outside the game: a
   supporters list in the credits and the README. No ads, no paid tier and nothing sold in the game
   while Habitica art ships. Revisit Open Source Collective if donations pass a few hundred dollars
   a year or other people start contributing.
6. **If a tip jar is ever added, tell Habitica** (by then the app form will have gone in, so a
   short email to admin@habitica.com), and ask whether a donation link on an instance that serves
   their sprites is fine. CC's own advice for
   NC doubts is to ask the rights holder, and doing it at submission costs nothing.
7. **Keep the commercial door cheap to open later.** The player body (art round 3) already moves
   the hero toward our own art. If the Habitica art stays in one folder plus the sprite proxy, and
   the game can run with it switched off, then a paid tier later becomes "turn Habitica art off on
   that instance, or get permission", not a rewrite. Don't build that switch now; just don't
   spread Habitica art further.
8. **Don't call the owner's server "official".** Habitica's staff rules say not to use "official"
   in a tool's name or description. Call it "the main world" or "the home server".

## 1. Habitica's licences and rules

**Code: GPL-3.0, no "or later" and no exceptions.** Certain. Habitica's
[LICENSE](https://github.com/HabitRPG/habitica/blob/develop/LICENSE) is ten lines:

> Code is GPL v3 licensed …
> Assets and content designed for Mozilla BrowserQuest are licensed under CC-BY-SA 3.0
> Assets and content designed for HabitRPG are licensed under CC-BY-NC-SA 3.0

It lists no directories and names no copyright holder.

**Art: CC BY-NC-SA 3.0, owned by HabitRPG, Inc.** Certain.
- The founder wrote in 2014 that assets "have been copyright-assigned to HabitRPG by the permission
  of their creators … For commercial use of art assets, please contact us"
  ([#2609](https://github.com/HabitRPG/habitica/issues/2609)), and that commercial users "will
  still need to redesign the assets, or request permission from Habit"
  ([#2596](https://github.com/HabitRPG/habitica/issues/2596)).
- In June 2026 staff confirmed the licence covers the S3-hosted images we use: "The LICENSE you
  linked does pertain to the asset files … So long as you're not causing any confusion about which
  site/app is official Habitica, you should be ok!"
  ([#15659](https://github.com/HabitRPG/habitica/issues/15659)).
- "Weirdly Wonderful", which our credits name as an owner, appears nowhere in Habitica's licence,
  terms or code. It should come out.

**Name: "Habitica" is a US registered trademark** (likely; reg. 6292967, HabitRPG, Inc., seen on
trademark aggregators, USPTO pages blocked). Staff's own rules for third-party tools
([Template:Third Party Tool Rules](https://habitica.fandom.com/wiki/Template:Third_Party_Tool_Rules),
"written by staff") say:
- "Try names like "Habitica Chat Extension" or "Skin for Habitica"", so "for Habitica players" is fine;
- "Do not use the word "official" in your tool's name or description";
- don't use purple as a main colour or in logos, and avoid the gryphon logo (Melior).

Our UI has no purple and no gryphon (checked).

**Terms of service** (certain; from the
[terms page](https://habitica.com/static/terms) source, updated 2025-09-01):
- "Third party applications may use one of the permitted logos and signifiers in order to represent
  their compatibility with the Service, but may not claim formal association with … HabitRPG."
- "We allow for personal, non-commercial uses like fanart under … CC-NC-SA 3.0 terms."
- "HabitRPG hereby grants you a non-commercial … license to use the Software", and "By using API
  you are automatically bound by the Agreement."

Interpretation: the terms frame use of Habitica's service, the API included, as non-commercial. A
free tool with tips is well inside that. A paid product built on people's Habitica accounts is a
question for staff even if it used none of their art.

**Third-party tool rules** ([API Usage Guidelines](https://github.com/HabitRPG/habitica/wiki/API-Usage-Guidelines),
[Guidance for Comrades](https://habitica.fandom.com/wiki/Guidance_for_Comrades)). Certain. Covered
in [habitica-policy.md](habitica-policy.md). Nothing in them mentions money, donations, ads or paid
features, for or against. The fandom page tells tools to load images from
`habitica-assets.s3.amazonaws.com/mobileApp/images/`, so staff expect tools to use that art.

**What staff have said about money.** Certain:
- 2014, founder: commercial use of art means redraw or ask.
- 2025: asked whether internal company self-hosting is non-commercial, staff replied only "send
  this question over to admin@habitica.com" ([#15480](https://github.com/HabitRPG/habitica/issues/15480)).
  They don't interpret NC in public.
- I found no case of Habitica granting a commercial art licence (unknown, not "never").

**Tools that already take donations** (certain): habitica-sync (Ko-fi), HabitSailor (Liberapay,
Ko-fi), octogriffin (GitHub Sponsors, Ko-fi), bumbleshoot's scripts (a "Donate" link on the fandom
wiki's own pages), Habitica Pomodoro SiteKeeper (Ko-fi). Most are API tools without art, so they
show the culture more than they settle the NC question.

**Culture.** Habitica is free with optional subscriptions ($5/month) and gems, and the wiki has a
"Play to Win, Not Pay to Win" page. Since August 2026 its repo takes no community pull requests and
"prohibits the submission of code generated by large language models". Interpretation: tip jars
fit; anything that looks like paying for advantage, or hides how the game was made, won't.

## 2. How the game uses Habitica material today

From the code, 2026-10-07:

| Use | Where | What it is under CC 3.0 | Notes |
|---|---|---|---|
| 41 sprites bundled, exact copies | `public/assets/habitica/` (+ `manifest.json` with sha256s) | Reproduced and distributed (in the repo and every build), and publicly performed by every instance | Body, hair, a few class sets, the wolf pet and mount |
| Sprite proxy and disk cache | `server/internal/api/sprites.go`, `GET /api/sprites/{name}` | Reproduced and publicly performed by whoever runs the server | Fetches any catalogued piece from Habitica's S3 the first time it's needed. Needed because S3 sends no CORS headers, so WebGL can't load it directly. |
| Avatar layering | `src/lib/habitica/avatar.ts`, `src/game/avatar-render.ts` | Most plausibly display of unmodified works, not an Adaptation (interpretation) | Stacks layers in Habitica's own order and scales them. Nothing tinted, recut or saved as a new image. |
| Other players' avatars | `loadPresenceAvatar` | Same as above | |
| Guests | Wren, our own generated demo hero | No Habitica art | Habitica art appears only for connected players |
| Gear stats | `content/habitica-gear.json`, embedded in the Go binary | Numbers from Habitica's GPL content | Text and descriptions stripped. Bare numbers are probably uncopyrightable facts (interpretation). |
| Habitica code | none found | n/a | Layer order and stat formulas were reimplemented from documented facts, not copied |
| Planned player body | art round 3 | Our art | "Recoloured from your Habitica look" uses colour values, which are facts. Draw it fresh; don't trace Habitica sprites. |

**Does NC make the whole game NC?** No, but it binds every instance that serves the art.
Interpretation, built on the CC 3.0 legal code (certain quotes):
- NC (§4(c)) limits *how the sprites are used*: not "in any manner that is primarily intended for or
  directed toward commercial advantage or private monetary compensation". That's a limit on the
  main instance and on every self-hoster, whatever licence our code has. Our code and our art
  stay under whatever we choose.
- A server that sends the sprites to browsers is "publicly performing" them ("make available to
  the public … from a place and at a time individually chosen by them"), so the licence conditions
  apply to the server operator, not only to people who copy the repo.

**Does ShareAlike reach our code or art?** No, as long as the sprites stay unmodified. A game that
includes the sprites "in unmodified form along with … separate and independent works" is a
**Collection**, and "a work that constitutes a Collection will not be considered an Adaptation"
(certain quotes; applying them to us is interpretation). SA applies only to Adaptations. If we ever
recolour, recut or redraw from a Habitica sprite, that result is an Adaptation and must be
BY-NC-SA. Composing layers at runtime the way Habitica itself does is display, not a new work
(interpretation; CC 3.0 §3 also allows changes "technically necessary" to use a work in another
format).

**Does the gear data bring in the GPL?** Only weakly. If it's copyrightable at all, it's GPL-3.0
data in an aggregate (the GPL FAQ allows aggregates). If our code is AGPL-3.0 the question goes
away, since AGPL can combine with GPLv3 (§13). With MIT we'd keep the file under its own GPL-3.0
notice. Habitica's licence also says "content designed for HabitRPG" is NC-SA, which plausibly
covers item names and descriptions. We strip those; keep it that way.

**Gaps to fix before publishing** (fixed 2026-10-07 with the rename: the credits name HabitRPG,
Inc. with the licence link and the not-affiliated line, `public/assets/habitica/LICENSE` exists, and
the README's licence section says which licence covers which folder):
- The in-game credits (`src/ui/MenuPanel.svelte`) and `ASSETS.md` name "Weirdly Wonderful"; change
  to **HabitRPG, Inc.**
- The in-game credits lack the licence link and the "not affiliated with or endorsed by Habitica"
  line that `ASSETS.md` has.
- Add a `LICENSE` (CC BY-NC-SA 3.0 notice) inside `public/assets/habitica/`, and a top-level
  `LICENSE`/`NOTICE` that says which licence covers which folder.
- `ASSETS.md` says "no public deployment" until an art licence is chosen. The game is already
  deployed; choosing the licence closes that.

## 3. What "non-commercial" allows

CC doesn't rule on cases. Its FAQ says "CC cannot advise you on what is and is not commercial use.
If you are unsure, you should either contact the rights holder…" and that NC "does not turn on the
type of user" (a nonprofit can break it, a company might not) (certain,
[FAQ](https://creativecommons.org/faq/#does-my-use-violate-the-noncommercial-clause-of-the-licenses)).
CC has no statement on donations, cost recovery or ads (certain: searched).

What there is:
- CC's 2009 [Defining Noncommercial](https://wiki.creativecommons.org/wiki/Defining_Noncommercial)
  study: people rate ads as commercial (about 84 on a 1-100 scale). A non-profit covering hosting
  with ads scored 59-72, so even that was seen as mostly commercial. CC says the study isn't its
  official view.
- Education projects treat recovering actual costs as non-commercial "so long as there is no
  profit motive" (likely; [MIT OCW](https://support.learn.mit.edu/hc/en-us/articles/42909296669339-How-does-MIT-define-non-commercial-use)).
- Precedents: Goonstation (Space Station 13) licenses its whole codebase CC BY-NC-SA 3.0 and pays
  for hosting through Patreon (about $360/month). Space Station 14 ships some BY-NC-SA 3.0 assets,
  funds itself with Patreon and Open Collective, and warns in its README that those assets "will
  need to be removed if you wish to use this project commercially". These are practice, not law.

Case by case (interpretation):

| Model | Verdict | Why |
|---|---|---|
| Donations with no perks, framed as covering costs | Fine | Nothing about the use of the art changes with payment |
| Tips that also pay the owner's time | Fine in practice | "Private monetary compensation" is the grey word, but a free game with an optional tip jar isn't *primarily directed* at it. Every Habitica tool with a tip jar sits here. |
| Open Collective with a public ledger | Fine | Strongest evidence of cost-covering |
| Memberships with perks outside the game | Mostly fine | Money buys thanks, not access to the art |
| Pay-what-you-want with $0 allowed | Grey | Free to play, but harder to call a donation once it earns real money |
| Perks or cosmetics inside the game | Grey to risky | Money buys something inside an instance that serves NC art |
| Merch of our own art | Fine for NC | NC binds the Habitica art only |
| Paid tier, ads, sold cosmetics | Not without permission | Directed toward monetary compensation |

## 4. Paths to commercial freedom

**A. Replace every Habitica asset.** Unlocks: no NC limit on the art. Costs: our own body, hair,
skin, every gear slot, pets and mounts, which is far beyond the planned player body. The bigger
cost is design: the boundary says "Habitica gear decides how you look" and "show the player's real
one". Without Habitica art we'd show no gear at all, or draw our own versions of Habitica gear,
which rule 2 forbids. So path A means rewriting the boundary, not only redrawing. The ToS caveat
about building a paid product on Habitica accounts still applies.

**B. Ask Habitica.** Unlocks: whatever they agree to, in writing. Costs: an email to
admin@habitica.com. Odds: unknown; I found no grant, but staff answered a similar question
helpfully in June 2026. Best done after the game is public and polished, together with the app
submission. A narrow ask ("donations and a supporter page while serving your sprites: OK?") is more
likely to get a yes than a broad commercial licence.

**C. Mirror live, never bundle.** Unlocks less than it seems. Dropping the 41 bundled files means
the repo no longer distributes Habitica art, which helps forks. But the proxy still copies and
serves the art, so every instance is still bound by NC. Going further, letting browsers load
straight from Habitica's S3, needs a non-WebGL rendering path because S3 sends no CORS headers, and
whether showing hotlinked images counts as using them is unsettled in US courts. Interpretation:
worth doing only as part of A (an instance option to turn Habitica art off), not alone.

**Cheapest real option:** stay non-commercial, and keep the art isolated so A or B is a contained
change if it's ever needed (recommendation 7).

## 5. Our own licences

### Code

| Licence | Hosted forks must share changes | Fits a self-hosted game server | Notes |
|---|---|---|---|
| MIT | No | Yes | Most reuse; a company can run a closed fork |
| Apache-2.0 | No | Yes | MIT plus a patent grant; GPLv3-compatible |
| GPL-3.0 | No (running a server isn't distributing; only the browser JS is) | Partly | Habitica's own licence |
| **AGPL-3.0** | **Yes** (§13: users "interacting with it remotely" must be offered the source) | **Yes** | Lichess, Mastodon, Plausible. Only modified copies have the extra duty; plain self-hosters don't. |

Sources: [AGPL text](https://www.gnu.org/licenses/agpl-3.0.txt), [GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html),
[licence list](https://www.gnu.org/licenses/license-list.html) (certain).

Contributions: with AGPL, outside code under the same licence ("inbound = outbound", a DCO sign-off)
means the owner can't later relicense those parts alone. A CLA keeps that option, but puts
contributors off. Decide before the first outside pull request.

### Art and writing, and AI

- Copyright Office, March 2023 guidance and January 2025 report: "Copyright does not extend to
  purely AI-generated material", and "prompts do not alone provide sufficient control". Humans keep
  copyright in creative selection, arrangement and modification (certain,
  [Part 2 report](https://www.copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-2-Copyrightability-Report.pdf)).
- *Thaler v. Perlmutter*: D.C. Circuit affirmed in March 2025 that human authorship is required;
  the Supreme Court denied review on 2026-03-02 (certain,
  [SCOTUSblog](https://www.scotusblog.com/cases/case-files/thaler-v-perlmutter)). *Allen v.
  Perlmutter* (Midjourney, 600+ prompts) is still pending (likely).
- CC: a licence applies to "the creative work that you contribute", and "We encourage the use of
  CC0 for those works that do not involve a significant degree of human creativity" (certain,
  [CC, 2023](https://creativecommons.org/2023/08/18/understanding-cc-licenses-and-generative-ai/)).

Interpretation for Glimway:
- `ASSETS.md` records every art pack as generated with image_gen from prompts, with frames measured
  and cut but not repainted. That's the uncopyrightable case. Whatever licence we pick is a request,
  not a right. The atlas layouts, cleanup and arrangement may carry thin human authorship.
- The same rule applies to code and lore written by agents. The owner's direction, review and
  editing count for something, but nobody knows how much yet. Still license the code: it covers
  whatever is copyrightable, states intent, and its no-warranty clause protects the owner either way.
- Keep the provenance records (`ASSETS.md`, prompts in the repo). They're what would show which
  parts are human work if it ever mattered.
- Generated art that imitates Habitica's style is fine; a generated image that closely copies a
  specific Habitica sprite could still be argued to be a derivative of it.

### Trademark

- No US mark "FINGERSNAP" exists. Nearby: FINGERSNAPS MEDIA ARTS (live, class 41, entertainment
  services) and SNAP FINGER CLICK (live, game software) (certain, USPTO search 2026-10-07).
- Rights come from use; you can write ™ without filing. Registration is $350 per class (since
  January 2025), and a game would want class 9 (software) and 41 (online game services), so about
  $700 plus maintenance fees later (certain,
  [USPTO fees](https://www.uspto.gov/trademarks/fees-payment-information/summary-2025-trademark-fee-changes)).
- Open-source projects keep the code free and the name controlled: Mozilla makes forks rebrand,
  Rust forbids looking "official, affiliated, or endorsed" (certain). A short `TRADEMARKS.md` would
  do: anyone may self-host and say "a [Name] world"; a fork offered to the public under its own
  changes needs its own name.
- Interpretation: register only if the name starts to matter (a fork confusing players, merch). Use
  it consistently with ™ from day one; that costs nothing.

## 6. Funding models

| Platform | Fee | Fits | Notes |
|---|---|---|---|
| GitHub Sponsors | 0% (personal account) | Yes | US supported. Donors need GitHub. |
| Liberapay | 0% plus ~3-5% processing | Yes | Donations only; it forbids rewards, which suits NC |
| Ko-fi | 0% on tips; 5% on memberships and shop (free plan) | Yes | Familiar to players, no account needed |
| Patreon | 10% plus processing (new pages since August 2025) | Possible | Built for perks, which we'd keep outside the game |
| Open Source Collective | 10% | Later | Ledger built in. Wants an org repo and an OSI licence; suggests other tools under ~$600/yr. Open Collective Foundation, the other big host, closed at the end of 2024. |
| itch.io pay-what-you-want | Seller-chosen cut (default 10%) | Maybe | For a downloadable build; we're a web game, so less useful |

Sources: GitHub [Sponsors docs](https://docs.github.com/en/sponsors/getting-started-with-github-sponsors/about-github-sponsors),
[Liberapay FAQ](https://liberapay.com/about/faq), [OSC fees](https://docs.oscollective.org/welcome-and-introduction-to-osc/fees.md),
[itch payments](https://itch.io/docs/creators/payments) (certain); Ko-fi and Patreon fees likely
(their help pages blocked us).

**Examples that fit.** Lichess is free forever and funded by donations; patrons get "Patron wings"
on their profile and nothing that affects play ([lichess.org/patron](https://lichess.org/patron)).
Veloren and Space Station 14 use Open Source Collective. Plausible and Ghost fund open-source code
with a paid hosted service, which is the model we can't use while Habitica art ships.

**Grants don't fit** (certain unless noted): NLnet wants "a strong European dimension", open
licences for all content, and says "We are not interested in AI-generated projects"; the Prototype
Fund is for people living in Germany (likely); the Sovereign Tech Fund is "not looking for
user-facing applications"; Epic MegaGrants targets Unreal and 3D tools (likely).

**A cost ledger** can be one page: what the home server costs (power, domain, backups, any paid
services), what came in, and where any surplus goes (art commissions, a better server, saved for
next year). Lichess and Open Collective projects show how much trust this buys.

### The gold purse

Habitica gold isn't money and can't be bought. But subscribers can turn 20 gold into one gem, up
to 24 or more gems a month, and gems are also sold for money (certain,
[planGemLimits.js](https://github.com/HabitRPG/habitica/blob/develop/website/common/script/libs/planGemLimits.js)).
So gold has a small, indirect, capped link to real money.

Interpretation: a one-way purse that never pays out, isn't sold and isn't traded for cash is far
from money-transmission rules, and spending it on fixed-price goods is not gambling. Three lines
keep it that way, and they line up with funding:
- never sell purse gold, embers or items for money, and never let a donation buy them;
- no real-money trading between players, and say so in the rules;
- no chance-based rewards (loot draws, gacha) that cost purse gold. Fishing-style random finds that
  cost time are fine.

## 7. AI and the Habitica audience

Not a licence issue, but it shapes everything above. Habitica's repo refuses LLM-generated code.
NLnet refuses AI projects. Habitica's art was drawn by volunteers who signed it over to Habitica. A
game made by AI agents that shows that art next to generated art will draw questions. I'd say how
it was made in the README, in `ASSETS.md` (already done), and in the app-submission form, rather
than have players find out. That's a choice for the owner (question 6).

## 8. The name

The owner is open to a new name. Now is the cheapest time: before the repo is public, before the
Habitica form (the `x-client` header carries the app name) and before any donation page. About
1,300 mentions across 260 files. Rename what players see; keep internal storage keys such as the
`fingersnap` IndexedDB database, or migrate them, so saves on the live instance survive.

What a good name needs: no Habitica marks in it; fits lanterns, embers and a road walked a little
each day; nothing similar already in games; a free domain; registrable later.

Quick knockout search (USPTO, Steam, itch.io, GitHub, domains, one web search each), 2026-10-07:

| Name | Rating | What we found |
|---|---|---|
| **Lanternwend** | Clear | Nothing anywhere; .com, .gg, .app, .dev all free. "Wend" means to go on your way: lanterns along the way. |
| **Wickroad** | Clear | Nothing beyond street names; all four domains free. Short; reads a bit like an address. |
| **Lamplight Road** | Clear | No exact match; all domains free. "Lamplight" is a crowded prefix (Lamplight City), so harder to search for. |
| **Wickwarden** | Clear | Nothing found; all domains free. Ties to the warden; a little more fantasy than cozy. |
| **Wickwend** | Clear | Nothing found; all domains free. |
| **Lampwend** | Clear | Nothing found; all domains free. |
| **Wickhollow** | Clear | .com registered but parked; others free. Sounds like a village. |
| **Wickmere** | Clear | .com taken; others free. |
| **Emberway** | Mostly clear | .com parked; near names Emberwake, Emberward exist. |
| **Lampwright** | Mostly clear | Ordinary word, so hard to protect; .com newly registered. |
| Fingersnap (current) | Some conflict | FINGERSNAPS MEDIA ARTS mark (class 41); fingersnap.app is another product; .com parked for sale. No link to the theme. |
| Hearthwick | Some conflict | Live HEARTHWICK candle mark (WoodWick), brand holds the .com. Fine as the village name. |
| Lanternwake | Some conflict | Two itch games |
| Emberstead | Some conflict | A new itch colony game |
| Kindlewick, Tinderwick | Avoid | Kindle and Tinder are policed hard |
| Emberwick, The Lantern Road, Hearthlight, Lanternfall | Crowded | Each is already a game, some cozy browser games |

Second round, shorter names (same method), 2026-10-07:

| Name | Rating | What we found |
|---|---|---|
| **Glimway** | Mostly clear | No US mark, nothing on Steam or itch, no GitHub account, one repo. .gg, .app, .dev free; the .com was caught by a drop-catch reseller in 2025 (likely for sale). Searches drift to "Gliway", a diabetes drug. Owner's favourite. |
| **Wendwick** | Clear | Nothing anywhere; all four domains free. Sounds like a village. |
| **Lampwend** | Clear | Nothing; .com free. |
| **Glimwend** | Clear | Nothing; .com free. Faint echo of *Songs of Glimmerwick* (a cozy Steam RPG). |
| **Wickwend**, **Lightwend**, **Lanwend** | Clear | Nothing; .com free. Wickwend is easy to misread as "weekend"; Lanwend reads as LAN. |
| **Waylamp** | Mostly clear | .com registered (no site); everything else free. |
| **Wendlight** | Mostly clear | .com taken (no site). |
| **Emberwend** | Minor | .com is a live dating site. |
| Glimwick | Some conflict | Too close to *Songs of Glimmerwick*; GitHub org squatted. |
| Lanthorn | Some conflict | A pending US filing LANTHORN (2026-06) for goal-tracking software, right next to Habitica's space; also an itch game. |
| Lamplit | Some conflict | LAMPLIT lamps mark; *Lamplit Farms*, a cozy itch game. |
| Glim, Tallow | Crowded | Many marks and games each. |

A formal knockout (USPTO plus EUIPO) is worth doing on the final pick before registering anything.

## Renaming to Glimway

**Done 2026-10-07.** What was kept under the old name, and what the owner changes on the home
server, is in [deploy-notes/glimway-rename.md](deploy-notes/glimway-rename.md). The plan as it was
written:

Do it before publishing, as one brief. "Fingersnap" appears about 1,300 times in 260 files.

Rename freely (players and the public see these, or nothing depends on them):
- the README, page `<title>` (`index.html`), UI text, docs, `ASSETS.md` and the credits line;
- the repo name on GitHub;
- the Go module (`module fingersnap` in `go.mod`) and `server/cmd/fingersnap-server`;
- the Habitica `x-client` default, `<owner id>-fingersnap` to `<owner id>-glimway`
  (`server/cmd/fingersnap-server/main.go`), before the app-submission form goes in. The
  `clientTag` inside `content/habitica-gear.json` is a historical record of how the snapshot was
  fetched; leave it;
- Phaser texture and cache keys such as `fingersnap-props` and `fingersnap-packed` (internal only).

Keep, or migrate with care (renaming breaks the live instance):
- **Browser storage.** IndexedDB `fingersnap` (guest saves, `src/lib/save.ts`) and
  `fingersnap-connected` (`src/lib/api/cache.ts`), and `localStorage` keys `fingersnap:*`
  (client id, mute, held tool, guide pin, heard-day). Renaming them silently wipes saves and
  settings. Keep the names with a one-line "old name, kept so saves load" comment.
- **The session cookie** `fingersnap_session` (`server/internal/api/api.go`). Renaming it signs
  everyone out once. Harmless, but either keep it or accept that.
- **Server config and deploy.** 14 `FINGERSNAP_*` environment variables, the database path
  (`.data/fingersnap.sqlite`, `/var/lib/fingersnap-server/` on the home server), and the NixOS
  modules `deploy/nixos/fingersnap*.nix` with `services.fingersnap-server`. The owner runs
  deploys, so either keep these names for now or rename them with a deploy note: read
  `GLIMWAY_*` first and fall back to `FINGERSNAP_*` for one release, and move the state directory
  as a deliberate step.

Also: the in-game lore can use the word. "Glim" is old slang for a candle ("douse the glim").

## Questions for the owner

1. ~~The goal.~~ Decided: free, no donations for now.
2. ~~The name.~~ Decided: Glimway.
3. ~~Code licence.~~ Decided: AGPL-3.0-or-later.
4. ~~Outside contributions.~~ Decided: the DCO (`CONTRIBUTING.md`).
5. ~~Art licence.~~ Decided: CC0 for the current AI-generated art; future human art licensed per work.
6. ~~AI disclosure.~~ Decided: said plainly, in the README and on the Habitica form.
7. ~~Platforms~~, 8. ~~asking Habitica about donations~~, 9. ~~supporter thanks~~: deferred with
   donations.
10. **The long term.** Should the game one day be able to run with Habitica art switched off (our
    own body, no gear shown)? It changes the boundary rule about showing real gear, so it's a
    design call as much as a licensing one.
