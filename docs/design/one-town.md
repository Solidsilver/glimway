# One town: Hearthwick in the Wilds

2026-10-14. Design for step 4 of the agreed seamless path ([location-seam.md §0](location-seam.md#0-owner-decisions-2026-10-13)), written against `exp/one-town-design` at `9d803cc` (0.10.0, where seam S1–S6 shipped). No game source changes; `.agent/render-one-town.mjs` renders `.agent/one-town-preview.png`.

The seamless-world order is: Commons/Tangle join (**done in 0.10**) → **one town** → holds engine, then Lamps → hearths. This document designs **one town**: merging the village and the Commons into a single fixed town (`hearthwick`) in the middle of the Wilds, placing the eight home plots beside it as seamless one-chunk (`24×24`) lots on `outdoors`, opening roads into the Wilds on all four sides, and retiring the separate `village` and `home:<g>` outdoor spaces.

## 0. Owner decisions (2026-10-14)

Agreed in the design conversation for this lane, building on [location-seam.md §0](location-seam.md#0-owner-decisions-2026-10-13) and [continuous-village.md](continuous-village.md):

1. **One unified town (`hearthwick`), 3×3 chunks (`cx = -1..1, cy = 1..3`, 72×72 tiles).** The village and the Commons merge into a single fixed place (`id: "hearthwick"`, layout `hearthwick`) occupying cell `(0, 1)` immediately south of the Tangle (`cx = -1..1, cy = -2..0`). It matches the Tangle's three-chunk width and the Wilds' 3×3 cell grid (`cellChunks: 3, originCx: -1, originCy: -2`), so standing in the town square `(0, 2)` keeps the entire town resident in the 3×3 window. The separate `commons` place and `village` space go away, and the temporary `location.Resolve` bridge is deleted.
2. **One well and one notice board.** The Town Square holds the town's single well (`well-rope` repair, `well-canopy` project) and single notice board (serving both Turning notices and shared village projects). The northern Carters' Apron keeps the brass hame (`gate-hame`), Carting Day market stalls and bunting, Bloom flower patches, and Elara's camp beside the Tangle arch.
3. **Roads into the Wilds on all four sides; Brackenwood stays a trailhead portal for now.** Four roads leave the town into continuous `outdoors` Wilds: North through the Tangle Arch (`(1..3, 24)`) into the Tangle, East down Lantern Road (`(47, 58..60)`), South down South Road (`(8..10, 95)`), and West down West Road through the plot area (`(-72, 68..71)`). Brackenwood (`woodland`) and Ashwatch (`ruin`) stay curated transition spaces entered through the leafy **Brackenwood Arch** (`exit:woodland`) on Lantern Road just inside the East Gate, preserving personal client-side story combat (`finger-wisp`, `stone-warden`) and the three paid road lanterns until the later Outposts pass ([location-seam.md §0 #9](location-seam.md#0-owner-decisions-2026-10-13)).
4. **Seamless Wilds-look home plots beside the town: 1 lot = 1 chunk (`24×24` tiles).** Rather than keeping homes behind gate transitions or reserving 45 chunks of 48×48 envelopes, the eight indexed lots (`lot:0`..`lot:7`, mapped 1:1 from `gate:0`..`gate:7`) sit in a `2×4` chunk neighbourhood immediately west of the town (`cx = -3..-2, cy = 1..4`, world tiles $x = -72..-25,\ y = 24..119$). Each lot is a single `24×24` chunk on `outdoors`, pre-generated with the Wilds/Tangle look (moss, woods, trees, stumps, boulders) and `safe: true` (no enemy camps or mob spawning). Players walk straight off the public lane onto their plot with no portal; only the cottage front door (`in:home:<g>`) is an indoor transition. Because outer lots border generated Wilds chunks directly, players can later extend lamplight into the Wilds or claim a 1-chunk hearth farther out using the same 1-chunk unit.

---

## 1. Layout

### 1.1 District and chunk overview

North is negative $y$. Each chunk is $24\times24$ tiles ($384\times384\text{ px}$). Chunk `(0, 0)` covers world tiles $x = 0..23,\ y = 0..23$.

- **The Tangle** stays at `cx = -1..1, cy = -2..0` ($x = -24..47,\ y = -48..23$). Its south gate is at world tiles $x = 1..3,\ y = 23$.
- **Hearthwick (`hearthwick`)** occupies `cx = -1..1, cy = 1..3` (3×3 = **9 chunks**, $72\times72$ tiles, world tiles $x = -24..47,\ y = 24..95$), with layout origin `(-24, 24)`.
- **The Plot Area (`lot:0`..`lot:7`)** occupies `cx = -3..-2, cy = 1..4` (2×4 = **8 chunks**, $48\times96$ tiles, world tiles $x = -72..-25,\ y = 24..119$).
- **Generated Wilds outskirts** surround the town and plot area on the west (`cx <= -4`), north-west (`cx = -3..-2, cy <= 0`), east (`cx >= 2`), and south (`cy >= 4` under the town, `cy >= 5` under the lots).

```text
                                     N ^ (negative y)
chunk cx     -4        -3        -2        -1         0         1         2
   cy
   -1      [Wilds]   [Wilds]   [Wilds]  [Tangle]  [Tangle]  [Tangle]   [Wilds]
    0      [Wilds]   [Wilds]   [Wilds]  [Tangle]  [Tangle v][Tangle]   [Wilds]
                                                   arch (1..3,24)
                  +-------------------+------------------------------+
    1      [Wilds]| [Lot 0] | [Lot 1] | [Verge/  | [Carters'| [Silas's| [Wilds]
                  | (-3, 1) | (-2, 1) |  Woods]  |  Apron & |  Yard & |
                  |=========+=========|==========|  Hame Wy]|  Pell]  |
    2      [Wilds]| [Lot 2] | [Lot 3] | [Bakery/ | [Town    | [Ada &  | [Wilds]
           <======+=========+=========+==West Rd=|  Square] |  Lantern+===> East Gate
           West Gt|=========|=========| [Library]|          |  Rd/Brk]|     & Brackenwood
    3      [Wilds]| [Lot 4] | [Lot 5] | [Hearth  | [Pip's   | [Finn's | [Wilds]
                  | (-3, 3) | (-2, 3) |  Lane]   |  Garden &|  Mill & |
                  |=========+=========|          |  South Rd|  Pond]  |
    4      [Wilds]| [Lot 6] | [Lot 7] |----------+----v-----+---------+ [Wilds]
                  | (-3, 4) | (-2, 4) |   [Wilds]  South Gt   [Wilds]
                  +---------+---------+            (8..10,95)
    5      [Wilds]   [Wilds]   [Wilds]    [Wilds]   [Wilds]   [Wilds]   [Wilds]
```

A rendered pixel preview of this exact tile blockout is in [img/one-town-preview.png](img/one-town-preview.png).

| District | Chunk(s) | World tile bounds | Job and contents |
|---|---|---|---|
| **Town Square** | `(0, 2)` | $x = 1..18,\ y = 55..68$ ($18\times14$) | Conversation and story centre. Town Well (`well-rope`, `well-canopy`), Town Lantern (`hearth` rest, `village-lamp`), Hazel's patched bench (`bench-slat`), Town Notice Board (`board`), Mara, Hazel's `square` spot, Orrin and his crooked signpost (`trail-sign`) at the east lip. |
| **North Frontage** | `(0, 2)` | $x = 1..18,\ y = 50..53$ | `house-middle` ($x = 1..7,\ y = 50..53$), 3-tile walk passage ($x = 8..10$) to Hame Way, and reserved frontage ($x = 11..18,\ y = 50..53$) for **Orrin's Workshop** and the **Wheel & Wick Guildhouse**. |
| **Carters' Apron & Tangle Arch** | `(-1, 1)`, `(0, 1)` | $x = -10..16,\ y = 24..43$ | Departure, building and festival apron (the merged Commons). Tangle Arch at $(1..3, 24)$; Elara's camp (pack, cold fire ring, `camp` post) at $(6..8, 26..28)$; cobbled apron ($x = -10..16,\ y = 30..43$) for Carting Day stalls (`madder-stall`, `stall-b`, `stall-c`) and `bunting-96`; `bloom-patch` gathering spots on the east grass verge; `lane-glove` pickup; brass **hame** (`gate-hame`) on the gatepost at $(0, 43)$. |
| **Silas's Yard** | `(1, 1)` | $x = 27..41,\ y = 29..44$ | Fenced timber yard east of Mill Way. `cottage-silas` at $(32..37, 31..34)$ with front door to `in:commons:yard` and Pell's office `in:commons:yard:deeds`; Silas's `yard` post and sawhorse; `toolbox`, `firebox`, `timber-stack`, `skids`, `woodpile`. |
| **Bread & Book West** | `(-1, 2)`, `(-1, 3)` | $x = -15..-7,\ y = 50..78$ | West of Hearth Lane, split by West Road ($y = 66..71$). North: **Hazel's Bakery** (`house-west`, $x = -14..-9,\ y = 55..58$, door to `in:village:bakery`, bread basket). South: **Hearthwick Library** (`commons-art:hearthwick-library`, $x = -13..-9,\ y = 73..76$, door to `in:village:library`, `library-roof` repair). |
| **Ada & Lantern Road** | `(1, 2)` | $x = 26..47,\ y = 49..65$ | East of Mill Way. **Ada's House** (`house-ada`, $x = 28..33,\ y = 50..53$, lit window `ADA_HOUSE_WINDOW` at $(32, 52)$, Ada's `window` spot at $(32, 55)$, `oatcake-parcel`, `why-the-tide-fox-has-one-long-ear`). **Lantern Road** ($x = 26..47,\ y = 57..62$) leads to the **Brackenwood Arch** (`exit:woodland` at $x = 41..43,\ y = 64$) and the **East Gate** ($x = 47,\ y = 58..60$). |
| **Pip's Garden & South Road** | `(0, 3)` | $x = 0..18,\ y = 70..95$ | **Pip's Fenced Garden** ($x = 6..12,\ y = 71..76$, `fence-rail` gap at $(9, 76)$, Pip at $(10, 75)$, `pip-copybook-warden-corrections` at $(7, 72)$). Framed by **South Way** ($x = -6..25,\ y = 79..84$), from which **South Road** ($x = 7..12,\ y = 85..95$) runs to the **South Gate** ($x = 8..10,\ y = 95$). |
| **Finn's Mill & Pond** | `(1, 3)` | $x = 26..41,\ y = 68..82$ | **Tolley Mill** (`mill-house`, $x = 28..31,\ y = 73..76$, door at $(29, 76)$ to `in:village:mill` and loft `in:village:mill:2`, hopper at $(27, 76)$, Finn's `door` spot at $(30, 77)$, kiln reserve at $x = 28..31,\ y = 68..70$). **Mill-race** ($x = 32,\ y = 74..76$, wheel) and **Mill Pond** ($x = 33..38,\ y = 73..76$ water, sandy rim at $y = 72$ and $x = 39$, `north`/`east`/`race` fishing banks, Mudrise `freshet-shore`, Quiet `pond-ice`, Breaking candle hulls, `elaras-note-in-pips-copybook` at $(40, 76)$). |
| **Plot Area (`lot:0`..`lot:7`)** | `(-3..-2, 1..4)` | $x = -72..-25,\ y = 24..119$ | Eight 1-chunk (`24×24`) seamless lots in two columns (`cx = -3` even lots `0, 2, 4, 6`; `cx = -2` odd lots `1, 3, 5, 7`) along **Homestead Lane** ($x = -50..-47$) and cross-lanes (`Lane 1` $y = 44..47$, `West Road` $y = 68..71$, `Lane 3` $y = 92..95$, `Lane 4` $y = 116..119$). |

### 1.2 Roads and widths

The town keeps `continuous-village.md`'s 6-tile district roads around the compact 18×14 square so carts and neighbours can pass without cutting through the square itself.

| Road | Width & surface | World tile bounds | Course and riding rule |
|---|---|---|---|
| **Tangle Lane** | 3 tiles at arch, widening to 6 cobbled tiles | $x = 1..3,\ y = 24$; $x = 0..5,\ y = 25..43$ | North from Hame Way through the Carters' Apron to the Tangle Arch. **Ride allowed** north of Hame Way ($y \le 43$). |
| **Hame Way** | 6 cobbled tiles | $x = -24..25,\ y = 44..49$ | East–west street between the Carters' Apron (north) and the Square's houses (south); continues west at $y = 44..47$ into `Lot Lane 1`. **On foot** in town ($x \ge -24$). |
| **Hearth Lane** | 6 cobbled tiles | $x = -6..-1,\ y = 44..84$ | North–south street along the Square's west side, between the Square/Garden and the Bakery/Library. **On foot.** |
| **Mill Way** | 6 cart-worn tiles | $x = 20..25,\ y = 34..84$ | North–south street along the Square's east side, linking Silas's Yard, Ada's House, Lantern Road, Finn's Mill, and South Way. **On foot.** |
| **South Way & South Road** | 6 cart-worn tiles, 3 at gate | $x = -6..25,\ y = 79..84$; $x = 7..12,\ y = 85..92$; $x = 8..10,\ y = 93..95$ | Connects the south ends of Hearth Lane and Mill Way below Pip's Garden, then exits south into chunk `(0, 4)`. **On foot** to the South Gate posts ($y = 92$), **ride allowed** beyond. |
| **West Road** | 6 tiles in town, 4 through lots | $x = -24..-7,\ y = 66..71$; $x = -72..-25,\ y = 68..71$ | Leaves Hearth Lane between the Bakery and Library, runs west between `Lot 2..3` and `Lot 4..5` to the **West Gate** at $(-72, 68..71)$. **On foot** in town ($x \ge -24$), **ride allowed** across the plot lanes ($x < -24$). |
| **Lantern Road** | 6 cobbled tiles, 3 at gate | $x = 26..44,\ y = 57..62$; $x = 45..47,\ y = 58..60$ | Leaves Mill Way past Orrin's signpost and Ada's window to the **Brackenwood Arch** ($x = 41..43,\ y = 64$) and the **East Gate** ($x = 47,\ y = 58..60$). **On foot** to the boundary posts ($x = 44$), **ride allowed** beyond. |
| **Homestead Lane & Lot Lanes 1–4** | 4 trodden/moss tiles | Spine $x = -50..-47,\ y = 24..119$; cross-lanes at $y = 44..47,\ 68..71,\ 92..95,\ 116..119$ | Public lanes between the eight `24×24` lots; spine opens north at $(-50..-47, 24)$ into `(-3..-2, 0)` and south at $(-50..-47, 119)$ into `(-3..-2, 5)`. **Ride allowed.** |

### 1.3 Tile-scale map of `hearthwick` (`cx = -1..1, cy = 1..3`)

One character is **one world tile** ($x = -24..47$, 72 columns; $y = 24..95$, 72 rows).
Legend: `g` = gate mouth into Wilds; `e` = Elara's camp; `C` = Carters' Apron cobbles; `Y` = Silas's Yard (`S` = Yard cottage); `=` / `|` / `+` = 6-tile roads; `:` = walking approach / doorway; `B` = Hazel's Bakery; `L` = Library; `h` = Middle House; `r` = reserved Workshop/Guildhouse frontage; `A` = Ada's House; `s` = Town Square (`o` = Town Lantern, `w` = Well, `b` = Notice Board, `q` = Orrin's signpost); `p` = Pip's fenced garden; `m` = Tolley Mill (`k` = kiln reserve, `~` = Mill Pond, `.` = sandy rim); `W` = Brackenwood Arch (`exit:woodland`); `#` = outer woods verge.

```text
   x=-24                  x=0                   x=24                  x=47
24 [########################ggg############################################]
25 [########################||||###########################################]
26 [###                     ||||   eee                                  ###]
27 [###                     |||||| eee                                  ###]
28 [###                     |||||| eee                                  ###]
29 [###                     ||||||                 YYYYYYYYYYYYYYY      ###]
30 [###           CCCCCCCCCC||||||CCCCCCCCCC       YYYYYYYYYYYYYYY      ###]
31 [###           CCCCCCCCCC||||||CCCCCCCCCC       YYYYYSSSSSSYYYY      ###]
32 [###           CCCCCCCCCC||||||CCCCCCCCCC       YYYYYSSSSSSYYYY      ###]
33 [###           CCCCCCCCCC||||||CCCCCCCCCC       YYYYYSSSSSSYYYY      ###]
34 [###           CCCCCCCCCC||||||CCCCCCCCCC ||||||YYYYYSSSSSSYYYY      ###]
35 [###           CCCCCCCCCC||||||CCCCCCCCCC ||||||::YYY::SSSSYYYY      ###]
36 [###           CCCCCCCCCC||||||CCCCCCCCCC ||||||YYYYYYYYYYYYYYY      ###]
37 [###           CCCCCCCCCC||||||CCCCCCCCCC ||||||YYYYYYYYYYYYYYY      ###]
38 [###           CCCCCCCCCC||||||CCCCCCCCCC ||||||YYYYYYYYYYYYYYY      ###]
39 [###           CCCCCCCCCC||||||CCCCCCCCCC ||||||YYYYYYYYYYYYYYY      ###]
40 [###           CCCCCCCCCC||||||CCCCCCCCCC ||||||YYYYYYYYYYYYYYY      ###]
41 [###           CCCCCCCCCC||||||CCCCCCCCCC ||||||YYYYYYYYYYYYYYY      ###]
42 [###           CCCCCCCCCC||||||CCCCCCCCCC ||||||YYYYYYYYYYYYYYY      ###]
43 [###           CCCCCCCCCCh|||||CCCCCCCCCC ||||||YYYYYYYYYYYYYYY      ###]
44 [gggg==================++++++==============++++++YYYYYYYYYYYYYYY     ###]
45 [gggg==================++++++==============++++++                    ###]
46 [gggg==================++++++==============++++++                    ###]
47 [gggg==================++++++==============++++++                    ###]
48 [###                   ++++++==============++++++                    ###]
49 [###                   ++++++==============++++++                    ###]
50 [###                   |||||| hhhhhhh:::rrrrrrrr ||||||  AAAAAA      ###]
51 [###                   |||||| hhhhhhh:::rrrrrrrr ||||||  AAAAAA      ###]
52 [###                   |||||| hhhhhhh:::rrrrrrrr ||||||  AAAAAA      ###]
53 [###                   |||||| hhhhhhh:::rrrrrrrr ||||||  AA:AAA      ###]
54 [###                   ||||||        :::         ||||||   :          ###]
55 [###       BBBBBB      |||||| ssssssssssssssssss ||||||              ###]
56 [###       BBBBBB      |||||| ssssssssssssbsssss ||||||              ###]
57 [###       BBBBBB      |||||| ssssssssssssssssss ||||||==================]
58 [###       BBB:BB      |||||| ssssssssssssssssss ||||||==================]
59 [###          :        ||||||:ssssssssssssssqss::||||||==================]
60 [###                   ||||||:sssssssssoswssssss ||||||==================]
61 [###                   |||||| ssssssssssswwsssss ||||||===============###]
62 [###                   |||||| ssssssssssssssssss ||||||===============###]
63 [###                   |||||| ssssssssssssssssss ||||||           WWW ###]
64 [###                   |||||| ssssssssssssssssss ||||||           WWW ###]
65 [###                   |||||| ssssssssssssssssss ||||||              ###]
66 [###===================++++++ ssssssssssssssssss ||||||              ###]
67 [###===================++++++ ssssssssssssssssss ||||||              ###]
68 [gggg==================++++++ ssssssssssssssssss ||||||  kkkk        ###]
69 [gggg==================++++++                    ||||||  kkkk        ###]
70 [gggg==================++++++                    ||||||  kkkk        ###]
71 [gggg==================++++++      ppppppp       ||||||              ###]
72 [###                   ||||||      p     p       ||||||      ........###]
73 [###        LLLLL      ||||||      p     p       ||||||  mmmm.~~~~~~.###]
74 [###        LLLLL      ||||||      p     p       ||||||  mmmm~~~~~~~~###]
75 [###        LLLLL      ||||||      p     p       ||||||  mmmm~~~~~~~~###]
76 [###        LL:LL      ||||||      ppp:ppp       ||||||::m:mm~~~~~~~~###]
77 [###          :        ||||||         :          ||||||   :  ........###]
78 [###                   ||||||                    ||||||              ###]
79 [###                   ++++++====================++++++              ###]
80 [###                   ++++++====================++++++              ###]
81 [###                   ++++++====================++++++              ###]
82 [###                   ++++++====================++++++              ###]
83 [###                   ++++++====================++++++              ###]
84 [###                   ++++++====================++++++              ###]
85 [###                                ||||||                           ###]
86 [###                                ||||||                           ###]
87 [###                                ||||||                           ###]
88 [###                                ||||||                           ###]
89 [###                                ||||||                           ###]
90 [###                                ||||||                           ###]
91 [###                                ||||||                           ###]
92 [###                                ||||||                           ###]
93 [########################            |||            ####################]
94 [########################            |||            ####################]
95 [########################            ggg            ####################]
```

### 1.4 Anchors, doors, residents, repairs and spots

Every content position that used to name `area: "village"` or `area: "commons"` becomes a world tile or anchor in `hearthwick` (with layout tile `lx = tx + 24, ly = ty - 24`):

| Feature | Kind / file | World tile `(tx, ty)` | Layout tile `(lx, ly)` | Notes |
|---|---|---|---|---|
| `hearthwick:spawn` | Anchor (`places.json`) | `(4, 60)` | `(28, 36)` | New-player arrival & fallback on the Square's west lip, facing Orrin |
| `hearthwick:well` | Anchor (`places.json`) | `(11, 62)` | `(35, 38)` | Defeat recovery spot beside the Town Well |
| `hearthwick:arch` | Anchor (`places.json`) | `(2, 26)` | `(26, 2)` | Just inside the north Tangle Arch (`homing-turncap` & fallback arrival) |
| `hearthwick:east-road` | Anchor (`places.json`) | `(42, 62)` | `(66, 38)` | Return tile outside the Brackenwood Arch (`exit:woodland`) |
| `hearthwick:south-gate` | Anchor (`places.json`) | `(9, 92)` | `(33, 68)` | Just inside the South Gate |
| `hearthwick:west-gate` | Anchor (`places.json`) | `(-22, 69)` | `(2, 45)` | Where West Road leaves `hearthwick` into the Plot Area |
| `hearthwick:bakery-door` | Anchor & `rooms.json` `in:village:bakery` | door `(-11, 58)`, step `(-11, 59)` | door `(13, 34)`, step `(13, 35)` | Hazel's kitchen front door (`window: (-9, 57)`) |
| `hearthwick:library-door` | Anchor & `rooms.json` `in:village:library` | door `(-11, 76)`, step `(-11, 77)` | door `(13, 52)`, step `(13, 53)` | Library reading room front door (`window: (-10, 74)`) |
| `hearthwick:yard-door` | Anchor & `rooms.json` `in:commons:yard` | door `(34, 34)`, step `(34, 35)` | door `(58, 10)`, step `(58, 11)` | Silas's Yard front door (`in:commons:yard:deeds` opens inside) |
| `hearthwick:mill-door` | Anchor & `rooms.json` `in:village:mill` | door `(29, 76)`, step `(29, 77)` | door `(53, 52)`, step `(53, 53)` | Finn's mill front door (`window: (30, 74)`, hopper `(27, 76)`) |
| `hearthwick:lot:0`..`7` | Anchors (`places.json`) | `(-60, 44)`, `(-36, 44)`, `(-60, 68)`, `(-36, 68)`, `(-60, 92)`, `(-36, 92)`, `(-60, 116)`, `(-36, 116)` | — | Public-lane step outside each lot's south gate (`lx = 12, ly = 20` of the lot's chunk) |
| **Mara** | `npc-post` + `ROUTINES` | `(14, 61)` | `(38, 37)` | Loops `(14,61) → (16,61) → (16,59) → (14,59) → (14,61)` |
| **Orrin** | `npc-post` + `ROUTINES` | `(17, 57)` | `(41, 33)` | Beside signpost `(16, 59)`; road-check walk to `(19, 57)` |
| **Pip** | `npc-post` + `ROUTINES` | `(10, 75)` | `(34, 51)` | Inside garden; laps `(10,75) → (8,75) → (8,73) → (10,73) → (10,75)` |
| **Hazel (`square`)** | `npc-post` + `residents.json` | `(11, 63)` | `(35, 39)` | 20 min/hr outside; walks to sit on patched bench at `(8, 61)` |
| **Finn (`door`)** | `npc-post` + `residents.json` | `(30, 77)` | `(54, 53)` | 25 min/hr outside mill door |
| **Ada (`window`)** | `npc-post` + `residents.json` | `(32, 55)` | `(56, 31)` | All hour under `ADA_HOUSE_WINDOW` `(32, 52)` |
| **Elara (`camp`)** | `npc-post` + `residents.json` | `(6, 27)` | `(30, 3)` | 30 min/hr at cold fire ring `(7, 28)` and pack `(7, 26)` |
| **Silas (`yard`)** | `npc-post` + `residents.json` | `(29, 36)` | `(53, 12)` | 20 min/hr by sawhorse `(29, 35)` inside Yard fence |
| **Repairs (6)** | `repairs.json` | `well-rope` `(12, 60)`, `village-lamp` `(10, 60)`, `bench-slat` `(8, 61)`, `fence-rail` `(9, 76)`, `library-roof` `(-11, 76)`, `gate-hame` `(0, 43)` | — | All six repairs preserved with identical IDs and world flags |
| **Pickups (3 in town)** | `items.json` | `well-rope-coil` `(9, 57)`, `oatcake-parcel` `(29, 55)`, `lane-glove` `(8, 36)` | — | `dropped-bucket` stays in `woodland` `(12, 18)` |
| **Placed papers (3 in town)** | `src/content/papers.ts` | `pip-copybook-warden-corrections` `(7, 72)`, `why-the-tide-fox-has-one-long-ear` `(36, 49)`, `elaras-note-in-pips-copybook` `(40, 76)` | — | `woodland` and `ruin` paper placements unchanged |
| **Fishing banks (3)** | `fishing.json` | `north`: `(34..38, 72)` S; `east`: `(39, 73..76)` W; `race`: `(32, 73)` S | — | `water:village:mill-pond` (24 water tiles at `33..38, 73..76` + 3 race tiles `32, 74..76`) |
| **Seasonal gathering** | `gathering.json` + layout `gather` | `bloom-patch`: `(11..13, 37..38)` (5); `freshet-shore`: `(34, 72), (36, 72), (38, 72)`; `pond-ice`: `(34, 73), (37, 73), (38, 75)` | — | All served as `gather` objects in `hearthwick.json` tagged with `festival` (`Bloom`, `Mudrise`, `Quiet`) |

### 1.5 Walk times

Hero walking speed is $110\text{ px/s} = 6.875\text{ tiles/s}$; riding is $155\text{ px/s} = 9.6875\text{ tiles/s}$.

| Route | Routed distance | On foot | With mount (where riding is allowed) |
|---|---:|---:|---:|
| Spawn `(4, 60)` → Orrin `(17, 57)` | 16 tiles | **2.3 s** | On foot (Square) |
| Square `(10, 60)` → Hazel's Bakery `(-11, 59)` | 22 tiles | **3.2 s** | On foot (Hearth Lane) |
| Square `(10, 60)` → Library `(-11, 77)` | 38 tiles | **5.5 s** | On foot (Hearth Lane) |
| Square `(10, 60)` → Finn's Mill `(29, 77)` | 36 tiles | **5.2 s** | On foot (Mill Way) |
| Bakery `(-11, 59)` → Finn's Mill `(29, 77)` | 58 tiles | **8.4 s** | On foot |
| Square `(10, 60)` → Silas's Yard `(34, 35)` | 49 tiles | **7.1 s** | On foot (Mill Way) |
| Square `(10, 60)` → Tangle Arch `(2, 24)` | 44 tiles | **6.4 s** | **5.8 s** (24 tiles on foot + 20 ridden on Tangle Lane) |
| Orrin `(17, 57)` → Brackenwood Arch `(42, 64)` | 32 tiles | **4.7 s** | On foot (Lantern Road) |
| Square `(10, 60)` → South Gate `(9, 95)` | 36 tiles | **5.2 s** | On foot to posts `(9, 92)` |
| Square `(10, 60)` → nearest lot gate (`lot:3`, `(-36, 68)`) | 54 tiles | **7.9 s** | **7.3 s** (34 tiles on foot + 20 ridden on West Road) |
| Square `(10, 60)` → farthest lot gate (`lot:6`, `(-60, 116)`) | 126 tiles | **18.3 s** | **15.0 s** (34 tiles on foot + 92 ridden on lot lanes) |

Every town errand is **3 to 8 seconds**, and even the farthest of the eight seamless home plots is **15–18 seconds** from the well (down from 43 seconds in `continuous-village.md` H1).

---

## 2. Where it sits on the grid

### 2.1 Relationship to today's Commons and the Tangle

| Region | In 0.10 (step 3) | In One Town (step 4) | What changes |
|---|---|---|---|
| **The Tangle** | `cx = -1..1, cy = -2..0` (`still`) | `cx = -1..1, cy = -2..0` (`still`) | **Unchanged.** Gate opening stays at $(1..3, 23)$; stored chunks, seeds, sites (`plank`), and camp IDs are untouched. |
| **The Whitequiet** | `cx = -1..1, cy = -5..-3` (`wick`) | `cx = -1..1, cy = -5..-3` (`wick`) | **Unchanged.** Crossing, Lantern Road north opening, Echoes, and dealt sites untouched. |
| **Town (`commons` → `hearthwick`)** | `commons` at `cx = -1..1, cy = 1..2` (3×2 chunks), origin `(-21, 24)` | `hearthwick` at `cx = -1..1, cy = 1..3` (3×3 chunks), origin `(-24, 24)` | Expands south by one chunk row (`cy = 3`) to merge the village and Commons into cell `(0, 1)`. North arch stays at $(1..3, 24)$. |
| **Plot Area (`lot:0`..`lot:7`)** | Separate `home:0`..`home:7` 40×30 spaces behind Commons fence gates | `cx = -3..-2, cy = 1..4` (2×4 chunks on `outdoors`), 1 chunk (`24×24`) per lot | Seamless outdoor chunks west of `hearthwick`. `home:<g>` space is retired; `in:home:<g>` cottage rooms remain. |
| **Brackenwood & Ashwatch** | Separate spaces `woodland` (56×30) and `ruin` (34×24) | Separate spaces `woodland` and `ruin`, entered at `exit:woodland` `(41..43, 64)` | **Unchanged** inside their spaces; only the village return anchor moves to `hearthwick:east-road` `(42, 62)`. |
| **Outskirts frontier** | `reach: 3` around Tangle/Whitequiet, clipped at `southLimit: 0` (`cx = -4..4, cy = -8..0`) | `reach: 3` around Tangle, Whitequiet, `hearthwick`, and the Plot Area, no `southLimit: 0` (`cx = -6..4, cy = -8..7`) | Generated `wick` chunks open on the west, south, and east of the town and plot area. |

### 2.2 What survives and what moves or breaks cleanly

There are only the owner and a few friends on the live server, so clean breaks are fine where noted, while all player progress, homes, items, and Tangle/Wilds discoveries survive:

1. **Saved player positions (`player_place`, migration `037_one_town.sql`):**
   - `area = 'village'` → `area = 'outdoors'` at anchor `hearthwick:spawn` `(4, 60)` (`x = 72, y = 968`), bumping `players.version` and `place_set_version`. (Because the village layout is recomposed rather than translated as a rigid rectangle, placing `village` saves cleanly at the Square spawn avoids dropping anyone inside a moved roof or pond.)
   - `area = 'outdoors'` with `y >= 384` (players saved on the step-3 Commons at `cy = 1..2`) → relocated to `hearthwick:arch` `(2, 26)` (`x = 40, y = 424`) with a version barrier bump so no one stands inside a moved fence or building.
   - `area = 'outdoors'` with `y < 384` (players in the Tangle, Whitequiet, or Beyond) → **kept at their exact `(x, y)` coordinates**.
   - `area = 'home:<g>'` (`g` in `0..7`) → `area = 'outdoors'` at the lot's doorstep (`lotOrigin(g) + (11.5 * 16, 8.5 * 16)`), bumping `players.version` and `place_set_version`.
   - `area = 'woodland'`, `'ruin'`, or `'in:*'` → **kept at their exact `(area, x, y)` coordinates**.
2. **Homes, members, storage, and placed items (`homesteads`, `homestead_*`, migration `037_one_town.sql`):**
   - Every `homesteads` row (`id`, `world_id`, `gate` `0..7`, `tier`, `posts_bought`, `vacant_since`), `homestead_members`, `item_stacks` (`storage`), `item_instances` (`storage`/`shelf`/`fitted`), `woodpile_stacks`, `homestead_stalls`, `gate_shelf_slots`, and indoor `homestead_items` (`scene = 'indoor'`) survives **100% untouched**.
   - Outdoor coordinates in `homestead_cleared`, `homestead_stumps`, `homestead_plants`, and `homestead_items` (`scene = 'outdoor'`) shift by `(-8, -3)` so the `8×6` home site (`(16, 6)` → `(8, 3)`) and everything around it keep their exact position relative to the cottage door and gate path.
   - **Clean break for far-margin outdoor placements:** any cleared tile, stump, or plant whose shifted `(x, y)` falls outside the lot's `2..21 × 1..18` buildable interior (or on the reserved site/path) is dropped; any outdoor `homestead_items` piece whose shifted footprint falls out of bounds or on a blocked tile is moved to `location = 'storage', scene = NULL, x = NULL, y = NULL, rotation = NULL` (returned to the home's chest, never deleted).
3. **Wilds epochs, seeds, and discoveries:**
   - The world's `still` epoch (the nine Tangle chunks) stays intact.
   - Because opening the frontier south (`cy = 1..7`) changes `frontierChunks()` (which `newRiver` in `wend.go` reads to place the Wend's southern exit `Y1`), migration `037_one_town.sql` expires the current `wick` epoch (`DELETE FROM wild_epochs WHERE kind = 'wick'`) so the new outskirts and the extended Wend generate cleanly together on the first read.

---

## 3. The plot area by the town

### 3.1 How the eight indexed 1-chunk lots work

The plot area sits immediately west of `hearthwick` in chunks `cx = -3..-2, cy = 1..4`:

| Lot index (`gate`) | Lot name (`lotName(n)`) | Chunk `(cx, cy)` | World tile origin `(x0, y0)` | Cottage doorstep `(tx, ty)` | Public lane anchor `hearthwick:lot:<n>` |
|---:|---|---|---|---|---|
| `0` | 1 West Lane | `(-3, 1)` | `(-72, 24)` | `(-61, 32)` | `(-60, 44)` |
| `1` | 1 East Lane | `(-2, 1)` | `(-48, 24)` | `(-37, 32)` | `(-36, 44)` |
| `2` | 2 West Lane | `(-3, 2)` | `(-72, 48)` | `(-61, 56)` | `(-60, 68)` |
| `3` | 2 East Lane | `(-2, 2)` | `(-48, 48)` | `(-37, 56)` | `(-36, 68)` |
| `4` | 3 West Lane | `(-3, 3)` | `(-72, 72)` | `(-61, 80)` | `(-60, 92)` |
| `5` | 3 East Lane | `(-2, 3)` | `(-48, 72)` | `(-37, 80)` | `(-36, 92)` |
| `6` | 4 West Lane | `(-3, 4)` | `(-72, 96)` | `(-61, 104)` | `(-60, 116)` |
| `7` | 4 East Lane | `(-2, 4)` | `(-48, 96)` | `(-37, 104)` | `(-36, 116)` |

Inside each `24×24` lot chunk (`lx = 0..23, ly = 0..23`), the local layout is **identical across all eight lots** (always south-facing, so cottage, stable, mailbox, and furniture art never rotate or mirror):

```text
   lx=0 1 2               10 11 12 13              21 22 23
ly=0 [ . . # # # # # # # # # # # # # # # # # # # # . . ]  <- north tree border (ly = 0)
   1 [ . . # . . . . . . . . . . . . . . . . . . # . . ]
   2 [ . . # . . . . . . . . . . . . . . . . . . # . . ]
   3 [ . . # . . . . . S S S S S S S S . . . . . # . . ]  <- 8x6 home site (lx = 8..15, ly = 3..8)
   4 [ . . # . . . . . S S S S S S S S . . . . . # . . ]
   5 [ . . # . . . . . S S S S S S S S . . . . . # . . ]
   6 [ . . # . . . . . S S S S S S S S . . . . . # . . ]
   7 [ . . # . . . . . S S S D D S S S . . . . . # . . ]  <- cottage door D at (11..12, 7)
   8 [ . . # . . . . . S S S @ * S S S . . . . . # . . ]  <- doorstep @ (11, 8), startLight * (12, 7, r=7)
   9 [ . . # . . . . . . . . p p . . . . . . . . # . . ]
  10 [ . . # . . . . . . . . p p . . . . . . . . # . . ]  <- wild plot ground (lx = 3..20, ly = 1..18):
  11 [ . . # . . . . . . . . p p . . . . . . . . # . . ]     trees, stumps, boulders, stream/slope
  12 [ . . # . . . . . . . . p p . . . . . . . . # . . ]     from land.Generate(seed, cfg)
  13 [ . . # . . . . . . . . p p . . . . . . . . # . . ]
  14 [ . . # . . . . . . . . p p . . . . . . . . # . . ]
  15 [ . . # . . . . . . . . p p . . . . . . . . # . . ]
  16 [ . . # . . . . . . . . p p . . . . . . . . # . . ]
  17 [ . . # . . . . . . . . p p . . . . . . . . # . . ]
  18 [ . . # . . . . . . . . p p m . . . . . . . # . . ]  <- mailbox m at (13, 18)
  19 [ . . f f f f f f f f g p p g f f f f f f f f . . ]  <- south fence f with gateposts g at (10,19), (13,19)
  20 [ = = = = = = = = = s = p p = h = = = = = = = = = ]  <- sign s (9, 20) & gift shelf h (14, 20) on verge
  21 [ = = = = = = = = = = = = = = = = = = = = = = = = ]  <- 4-tile east-west public lane (ly = 20..23)
  22 [ = = = = = = = = = = = = = = = = = = = = = = = = ]
  23 [ = = = = = = = = = = = = = = = = = = = = = = = = ]
```

- **Spine and lanes:** Columns `lx = 22..23` of `cx = -3` and `lx = 0..1` of `cx = -2` form the 4-tile north–south **Homestead Lane** ($x = -50..-47$). Rows `ly = 20..23` of every lot chunk form the 4-tile east–west cross-lanes (`y = 44..47, 68..71, 92..95, 116..119`). The outer two columns (`lx = 0..1` of `cx = -3` and `lx = 22..23` of `cx = -2`) are wooded verge (`Edge`) except where the cross-lanes pass through at `ly = 20..23`.
- **Plot interior (`lx = 3..20, ly = 1..18`, $18\times18 = 324$ buildable tiles):** `land.Generate(seed, cfg)` generates the lot's deterministic wild terrain (`Grass`, `Tree`, `Stump`, `Boulder`, optional `Water`/`Ford` stream in `lx = 3..6` or `17..20`, optional `Slope`), keeping the `8×6` home site (`lx = 8..15, ly = 3..8`) and the 2-tile gate path (`lx = 11..12, ly = 9..19`) clear.
- **Content config (`content/homestead.json` `land`):**
  - `generator: 2`, `width: 24`, `height: 24`
  - `site: { x: 8, y: 3, w: 8, h: 6 }`, `gate: { x: 11, w: 2 }`, `startLight: { x: 12, y: 7, radius: 7 }`
  - `trees: 48`, `stumps: 6`, `boulders: 4`, `streamPermille: 350`, `slopePermille: 350`
  - `outdoorReserved`: site `(8, 3, 8, 6)`, gate path `(11, 9, 2, 11)`, mailbox `(13, 18, 1, 1)`, and the public lane/fence margins (`x < 3`, `x > 20`, `y < 1`, `y > 18`).

### 3.2 How plot chunks are composed and rendered

1. **Server chunk composition (`SourcePlot` / `fixed` with `tangle` look):**
   - Each of the eight lot chunks `(-3..-2, 1..4)` is a `FixedPlace` zone (`place: "lot:<n>"`) with `rules: { safe: true, ride: true, sync: true, rest: "home" }`.
   - Unlike `hearthwick` (which uses curated tilemap ground), a lot chunk's base `WorldChunk` is composed from `land.Generate(land.Seed(worldID, lot, cfg), cfg)` using the Wilds `tangle` look (`Tangle` palette: `woods`, `moss`, `verge`, `path`, `trodden`, `water`, `road`) under the world's pseudo-epoch `plot:<worldID>:<lot>@<generatorVersion>`.
   - Because the base land depends only on `(worldID, lot, generatorVersion)`, it is immutable and cached in IndexedDB and the server chunk LRU just like any other chunk.
2. **Mutable home overlay (`HomesteadLayer` per-chunk hooks):**
   - What changes on a lot—whether it is claimed, its `tier` (`0` campsite vs `1+` cottage), `cleared` tiles, `stumps`, `plants`, `desolate` state, `stalls`, `yardPets`, `shelf`, and placed `homestead_items`—already comes from `/api/commons` (summary for signs/shelves) and `/api/homestead/gate/<n>` (full `HomeView`).
   - We extend `/api/commons` (or the near read when `cx, cy` covers a lot chunk) to include the `HomeView` of claimed lots in the world (there are at most 8 lots in a world, and only 3 on the live server), and broadcast a `home` presence event when someone places/moves/clears on a lot so neighbours see changes live.
   - When `WildsWindow` attaches lot chunk `(cx, cy)`, `HomesteadLayer.fixedHooks.attach(key)`:
     - Clears solid bodies and tree/stump/boulder sprites on `cleared` tiles, swaps felled trees to `stumps`, and draws `plants` and desolate grass tufts.
     - Draws the lot's south fence (`ly = 19`), gateposts, signpost (`(9, 20)`), and gift/sale shelf (`(14, 20)`).
     - If unclaimed: draws the `Unclaimed` stake at `(12, 8)` with its `"Read the sign"` interaction.
     - If claimed: draws the campsite (`tier == 0`, with bedroll rest interaction) or cottage (`tier >= 1`, with front door interaction entering `in:home:<lot>`), the mailbox at `(13, 18)`, placed outdoor `homestead_items`, the stable and its stalled mounts, wandering `HomesteadYard` pets, and lantern-post light pools.
     - While the member is in **Arrange** (`placement`) mode on their lot, the placement grid and saw-clearing tap handler operate in lot-local tiles `(tx - cx*24, ty - cy*24)` bounded to `lx = 3..20, ly = 1..18`.
   - When the lot chunk detaches from the window, `detach(key)` removes all of that lot's sprites, static bodies, yard pets, tweens, and interaction points.

### 3.3 Leaving room for Wilds expansion and remote hearths

Making **1 lot = 1 chunk (`24×24` tiles)** on `outdoors` unifies town plots, Wilds expansion, and future remote hearths into one model:

- **Expanding into the Wilds (with Lamps):** Lots `0, 2, 4, 6` border generated Wilds column `cx = -4` directly on their west edge; Lots `0, 1` border `cy = 0` on their north edge; Lots `6, 7` border `cy = 5` on their south edge. When Lamps land in the next release, a player who lights an extension lamp in the adjacent Wilds chunk holds that chunk across turnings and can clear/build outward from their plot fence.
- **Moving to a remote Wilds hearth (H3):** Because a home's outdoor geometry is already a single `24×24` chunk, claiming a hearth site out in the Wilds later is simply assigning `homesteads` a `(hearth_cx, hearth_cy)` chunk instead of a town `lot` (`0..7`). To prepare for that now with zero extra tables:
  - All door returns (`in:home:<g>` → outdoors), world-move arrivals (`arriveFromHome`), and goal guides resolve a home's outdoor position through one helper: `HomeEntrance(gate)` → anchor `hearthwick:lot:<g>` (and `HomeDoorstep(gate)` → `lotOrigin(g) + (11, 8)`).
  - Later, when a household moves its deed to a Wilds hearth chunk `(cx, cy)`, `HomeEntrance` and `HomeDoorstep` return that chunk's tile, and town lot `g` becomes vacant and claimable again.

---

## 4. The edges: meeting the outskirts and the Wilds

### 4.1 Opening the frontier around the town

Today `content/wilds.json` sets `frontier: { reach: 3, southLimit: 0 }`, and `wilds.NearestFootprint` only checks `wilds.json`'s `places` (the Tangle and the Whitequiet).

In One Town:
- `frontier.southLimit` is removed from `content/wilds.json` (or set to `7`, three chunks south of the plot area's `cy = 4`).
- `wilds.NearestFootprint(cx, cy)` and `frontier.Rect(world)` include the fixed places in `content/places.json` (`hearthwick` at `cx = -1..1, cy = 1..3` and the plot area at `cx = -3..-2, cy = 1..4`) alongside the Tangle and Whitequiet.
- With `reach: 3`, the initial open frontier spans **`cx = -6..4, cy = -8..7`**:
  - **North of town (`cx = -1..1, cy = -2..0`):** the still Tangle (unchanged).
  - **West of the lots (`cx = -6..-4, cy = -2..7`) and north/south of the lots (`cx = -3..-2, cy = -2..0` and `cy = 5..7`):** generated `wick` outskirts.
  - **South of town (`cx = -1..1, cy = 4..6`):** generated `wick` outskirts.
  - **East of town (`cx = 2..4, cy = -2..6`):** generated `wick` outskirts.
- **Tier scaling (`wilds.Tier`):** `NearestFootprint` distance from `hearthwick` and the lots counts as ring distance just like the Tangle, so the immediate outskirts around town (`ring 1`, within 3 chunks) are **Tier 2**, keeping early outskirts approachable.

### 4.2 Seams, routes, and the Wend beside fixed ground

Generated `wick` chunks must meet the fixed town and lot chunks cleanly at every turning without blocking any of the town's gates:

1. **Fixed chunks as kept neighbours (`base_v3.go`, `store/chunks.go`):**
   - `keptReader` and `seamMirror` treat any chunk where `location.SourceOf(cx, cy).Kind == SourceFixed` as a **kept** chunk, exactly like the Tangle's `still` chunks.
   - When `store.Chunks.make` generates a `wick` chunk at `(cx, cy)`, it passes any adjacent fixed chunk (`hearthwick` or lot) in `kept []chunks.Kept`.
   - Because `hearthwick`'s outer two tile rows/columns are solid woods (`#`) **except** at the four road mouths—North `(1..3, 24)`, East `(47, 58..60)`, South `(8..10, 95)`, and West `(-24, 44..47)` / `(-24, 68..71)`—and the plot area's outer edges are solid **except** at the West Gate `(-72, 68..71)`, North Spine `(-50..-47, 24)`, and South Spine `(-50..-47, 119)`, `seamMirror` automatically copies those exact 3–4-tile openings into the adjacent generated `wick` chunks and closes the rest of the border!
   - The `southLimit` two-row wall in `base_v3.go:154` is removed (the frontier edge itself already bounds the world).
2. **Cells and routes (`cells.go`, `routes.go`):**
   - `FootprintCell(cellX, cellY)` returns `true` for cell `(0, 1)` (`hearthwick`, `cx = -1..1, cy = 1..3`) and for the lot chunks (`cx = -3..-2, cy = 1..4`), so no random cell landmark is placed inside the town or lots.
   - `keptBoxes()` includes `hearthwick`'s box (`x = -24..47, y = 24..95`) and the plot area's box (`x = -72..-25, y = 24..119`), so cell-to-cell routes bend around the town and lots rather than cutting through them.
   - `port()` connects routes from the neighbouring cells—East cell `(1, 1)`, South cell `(0, 2)`, and West cell `(-2, 1)`—directly to `hearthwick`'s East Gate `(47, 59)`, South Gate `(9, 95)`, and the Plot Area's West Gate `(-72, 69)`.
3. **The Wend (`wend.go`):**
   - `newRiverBounds()` includes the plot area (`x0 = -72`) in `eastStill` for $y \ge 24 - \text{riverMargin}$, so as the Wend flows south from the north/west frontier, it bends west of the plot area (`cx <= -4`, $x \le -82$) and exits at the southern frontier (`cy = 7`), with fords where the West Road route crosses it.

### 4.3 Safe ground, combat, camps, and riding

| Rule | Town streets & Square (`town-walk` zone) | Carters' Apron & Plot Area (`hearthwick` & `lot:0..7`) | Generated outskirts & Tangle | Brackenwood (`woodland`) & Ashwatch (`ruin`) |
|---|---|---|---|---|
| **Place ID (`At().ID`)** | `"hearthwick"` | `"hearthwick"` / `"lot:<n>"` | `"tangle"`, `"whitequiet"`, `"beyond"` | `"woodland"`, `"ruin"` |
| **Safe (`At().Safe`)** | `true` | `true` | `false` | `false` |
| **Sync (`At().Sync`)** | `true` | `true` | `false` | `false` |
| **Ride (`At().Ride`)** | **`false` (on foot)** | **`true`** | **`true`** | **`true`** |
| **Paid rest (`At().Rest`)** | `"village"` (`hearth` lamp) | `"village"` (apron) / `"home"` (lots) | `"none"` (way-lamps later) | `"none"` (road lanterns via light rule) |
| **Combat & camps** | Refused; no camps | Refused; no camps | Server fight rooms (`fights.Key`); camp leash at chunk edge | Personal client-side story enemies (`finger-wisp`, `stone-warden`) |

- **Safety boundaries and cues:** Every exit from safe ground into generated `outdoors`—North at $y = 24$ (`(1..3, 24)`), East at $x = 47$ (`(47, 58..60)`), South at $y = 95$ (`(8..10, 95)`), West at $x = -72$ (`(-72, 68..71)`), and the north/south ends of Homestead Lane at $y = 24$ and $y = 119$—is marked by paired boundary gateposts, a transition from cobbles/lane to rough trodden earth, a warm lamp on the town side, and a readable destination sign.
- **Fights at the four seams:** `loadFightChunk` already sets `Geometry.Safe` per tile from `location.At` (shipped in S4), and `holdSafe` (`src/game/safe-barrier.ts`, hardened in S6) already slides and stops a zero-HP hero along any tile boundary where `safe(x, y)` flips from `true` to `false`. Because `location.At` returns `Safe: true` on `hearthwick` and `lot:0..7` and `Safe: false` on generated chunks, **every one of the new East, South, and West seams gets the exact same enemy-drop, bolt-stop, sync-safety, and zero-HP barrier behaviour as the Tangle mouth with zero new combat code.**
- **Riding zone (`PlaceZone`):** In `content/places.json`, `hearthwick`'s default rules are `{ safe: true, ride: true, sync: true, rest: "village" }`, and a single zone `town-walk` (`place: "hearthwick"`, layout rect covering $x = -24..44,\ y = 44..92$) sets `ride: false`. Walking a mount into the `town-walk` zone automatically dismounts (or leads the mount on foot), while Tangle Lane north of Hame Way ($y \le 43$), the entire Plot Area (`cx = -3..-2`), and the Wilds beyond the gateposts allow riding.

---

## 5. Story and onboarding

### 5.1 Tutorial path and guidance

The opening sequence stays **Orrin → east finger-wisp → Orrin → Journal → Orrin → Pip's walk-on / Mara → first road lamp (`road-1`) → Mara's Lantern Road → Brackenwood → Ashwatch → Mara**:

1. **Arrival (`hearthwick:spawn` at `(4, 60)`):** A new player spawns on the west lip of the Town Square facing east. Within one phone screen (6–12 tiles) are the Town Lantern `(10, 60)`, the Well `(12, 60)`, Mara `(14, 61)`, and Orrin up his ladder by the crooked signpost `(16, 59)`.
2. **Heading east to Brackenwood:** Orrin's signpost stands at the east mouth of the Square, pointing straight down **Lantern Road** ($y = 57..62$). Walking 25 tiles east along Lantern Road past Ada's lit window brings the player directly to the leafy **Brackenwood Arch** (`exit:woodland` at $x = 41..43,\ y = 64$, signed *"Brackenwood & Ashwatch"*). Stepping through enters `woodland` at `(2, 15)` with the weak `finger-wisp` waiting at `(6, 17)` and `road-1` at `(10, 14)`, completely isolated from shared Wilds camp fights.
3. **Open roads with clear guidance:** Tangle Lane (north), West Road (west to the lots and outskirts), South Road (south), and the East Gate (`(47, 58..60)` past the Brackenwood Arch) are physically open from arrival. Junction signs sit outside the Square so the first view is never cluttered with four competing arrows, and the HUD quest needle (`goal-guide.ts`) points directly to Orrin, then to the Brackenwood Arch (`exit:woodland`), then back to Orrin and Mara.
4. **Unified place ID in quests and story (`"hearthwick"`):**
   - In `content/quests.json`, steps that previously checked `"at": "village"` or `"where": { "area": "village" }` check `"hearthwick"`.
   - In `content/story.json`, `npcs` (`mara`, `orrin`, `pip`, `silas`), `spots.signpost`, `ids.found.areas.lantern-road-restored`, and `areas.home:met-silas` all name `"hearthwick"`.
   - In `src/game/entities/goal-guide.ts`, `ROAD` simplifies to:
     ```ts
     const ROAD: Record<string, string[]> = {
       hearthwick: ['woodland', 'tangle', 'beyond'],
       woodland: ['hearthwick', 'ruin'],
       ruin: ['woodland'],
       tangle: ['hearthwick', 'whitequiet', 'beyond'],
       whitequiet: ['tangle', 'beyond'],
       beyond: ['hearthwick', 'tangle', 'whitequiet']
     }
     ```
     When the goal is in `hearthwick` (or on a lot), `GoalGuide` points directly to the NPC, spot, door, or lot coordinate in `outdoors`!

### 5.2 NPC homes, hours, and routines on `outdoors`

- **Schedules (`content/residents.json`):** Hazel's `square` spot `(11, 63)`, Finn's `door` spot `(30, 77)`, Ada's `window` spot `(32, 55)`, Elara's `camp` spot `(6, 27)`, and Silas's `yard` spot `(29, 36)` all have `"area": "hearthwick"` (resolved as world tiles on `outdoors`) and are placed as `npc-post` objects in `content/layouts/hearthwick.json`.
- **Watched door walks (`src/game/resident-cycle.ts`):** `doorFor` already resolves front doors whose `to` is a fixed place onto `outdoors` (built in S5b for Silas). With `in:village:bakery`, `in:village:mill`, `in:village:library`, and `in:commons:yard` all naming `"to": "hearthwick"` with world-tile `outside` and `entry` coordinates, Hazel, Finn, Elara, and Silas all walk to and from their front doors on `outdoors` when their hour changes on screen.
- **Small routines (`src/game/npc-routines.ts`):** `ROUTINES.hearthwick` holds the world-tile loops for `mara`, `hazel`, `pip`, and `orrin` (table in §1.4). `Npcs` looks up `ROUTINES[world.areaId]` or, on `outdoors`, `ROUTINES.hearthwick` for NPCs attached from `hearthwick`.
- **Pip's tutorial walk-on (`src/game/entities/pip-walk-on.ts`):** `PipWalkOn` drops its `if (deps.world.areaId !== 'village') return` guard; when `signpost:set-post` completes on `outdoors` and Pip's sprite is attached in `this.deps.npcs.npcs`, Pip runs up from `(10, 75)` to the hero at the signpost, delivers Mara's message, and runs back to the garden.

### 5.3 Signs and the world map

- **Readable signs (`src/content/touches.ts`, `src/game/entities/touches.ts`):**
  - Orrin's signpost `(16, 59)`: *"East: Brackenwood & Ashwatch. North: The Commons & the Tangle. West: Homestead Lane."*
  - Boundary post signs at each gate:
    - North Arch `(1, 25)`: *"Beyond the arch: the Tangle."*
    - Brackenwood Arch `(41, 63)`: *"Brackenwood & the Old Lantern Road."*
    - East Gate `(46, 57)`: *"Beyond the posts: the Eastern Reaches."*
    - South Gate `(7, 92)`: *"Beyond the posts: the Southern Mere."*
    - West Gate `(-23, 67)`: *"Homestead Lane & the Western Drift."*
- **The World Map (`src/game/wilds/map-data.ts`, `src/lib/wilds/map-model.ts`, `src/ui/map-renderer.ts`):**
  - `fixedMapChunks()` in `map-data.ts` already includes every `PLACES.fixed` footprint on the map from arrival, independent of walked records!
  - Adding `hearthwick` (`cx = -1..1, cy = 1..3`) and the Plot Area (`cx = -3..-2, cy = 1..4`) to `PLACES.fixed` (with the lot chunks composed from `land.Generate`) means **the entire town, its roads, and all eight lots appear on the world map from the moment a player arrives**.
  - Map labels (`MAP_LABELS`): `"Hearthwick"` centred on the Square `(10, 60)`, `"Carters' Apron"` at `(2, 35)`, `"Silas's Yard"` at `(34, 35)`, `"Tolley Mill"` at `(33, 75)`, and `"Homestead Lane"` at `(-48, 68)` (plus occupied lot owner names at closer zoom).
  - Inside an indoor room (`in:village:bakery`, `in:commons:yard`, `in:home:<g>`), `loadMap` resolves the room's outdoor front door (`roomParent` → door `outside` tile or `HomeDoorstep(gate)`) so **the hero dot and "Centre on me" work indoors too**, showing the hero at the building they stepped into.

---

## 6. Server and client work

### 6.1 Content and proto changes

| File | Change |
|---|---|
| `proto/glimway/content/v1/places.proto` | Drop `village` and `home` from `SpaceRules` (only `woodland` and `ruin` remain separate curated spaces). Allow `FixedPlace.kind` (`"layout"` default, or `"plots"` for the `2×4` plot neighbourhood). |
| `proto/glimway/content/v1/layout.proto` | Add `"mill-wheel"` (or keep `mill` driven by `scenery:mill-house` + `mill-hopper` in `VillageLayer`) and allow `Layout.tx`/`ty` with `72×72` `hearthwick.json`. |
| `content/places.json` | Replace `commons` with `hearthwick` (`cx: -1, cy: 1, width: 3, height: 3, origin: {tx: -24, ty: 24}`, rules `{safe: true, ride: true, sync: true, rest: "village"}`, zone `town-walk` `{tx: 0, ty: 20, w: 68, h: 49, rules: {safe: true, ride: false, sync: true, rest: "village"}}`, anchors `spawn`, `well`, `arch`, `east-road`, `south-gate`, `west-gate`, `bakery-door`, `library-door`, `yard-door`, `mill-door`, `lot:0`..`lot:7`) and `homestead-lots` (`cx: -3, cy: 1, width: 2, height: 4`, rules `{safe: true, ride: true, sync: true, rest: "home"}`, zones `lot:0`..`lot:7`). |
| `content/layouts/hearthwick.json` | New `72×72` layout (replaces `content/layouts/commons.json`), generated once by an authoring/export script and checked into `content/layouts/`. |
| `content/homestead.json` | `land`: `generator: 2, width: 24, height: 24, site: {x: 8, y: 3, w: 8, h: 6}, gate: {x: 11, w: 2}, startLight: {x: 12, y: 7, radius: 7}, trees: 48, stumps: 6, boulders: 4`. Update `outdoorReserved`. |
| `content/wilds.json` | Remove `frontier.southLimit: 0` (set `southLimit: 7`). |
| `content/{rooms,residents,repairs,items,fishing,gathering,story,quests}.json`, `src/content/papers.ts` | Move all `village` and `commons` positions to `hearthwick` world tiles (§1.4). In `rooms.json`, `in:village:*` and `in:commons:yard*` keep their room IDs (`in:village:bakery`, `in:commons:yard`, etc.) so saved room IDs and quest references never break, while their `"parent"` and front-door `"to"` become `"hearthwick"`. |
| `content/vectors/location.json` | Update vectors for `hearthwick`, `lot:0`..`lot:7`, the `town-walk` zone, the expanded frontier, and the new anchors; remove `Resolve` vectors. |

### 6.2 Server changes

- **`server/internal/location`:**
  - Delete `Resolve(area, tx, ty)` (and its TypeScript twin `resolve` in `src/lib/location.ts`). Content files now carry world tiles directly.
  - `spaceRules`: remove `"village"` and `homeSpace` (`home:<g>`); a room `in:home:<g>` takes `RestHome`, `Safe: true, Sync: true, Ride: false`, and a room `in:village:*` or `in:commons:*` takes `hearthwick`'s rules with `Ride: false`.
- **`server/internal/chunks/fixed.go` & `server/internal/store/chunks.go`:**
  - Compose `hearthwick` (`9` fixed chunks under `fixed:hearthwick@1`).
  - Compose lot chunks (`cx = -3..-2, cy = 1..4`) from `land.Generate(land.Seed(world, lot, cfg), cfg)` plus the 4-tile public lane (`ly = 20..23`) and spine (`lx = 22..23` / `0..1`), served under `fixed:lot-<n>:<world>@2` (or `plot:<world>:<n>@2`).
- **`server/internal/frontier` & `server/internal/wilds`:**
  - `NearestFootprint` and `frontier.Rect` include `content.PlacesRules.GetFixed()`.
  - `base_v3.go`: `seamMirror` and `keptReader` treat `SourceFixed` chunks as kept neighbours; remove the `southLimit` two-row wall at `y = 22..23`.
  - `cells.go` / `routes.go` / `wend.go`: `FootprintCell`, `keptBoxes`, `port`, and `newRiverBounds` include `hearthwick` and `homestead-lots`.
- **Operations & rules (`server/internal/api`):**
  - `payload_validation.go`: `validArea` accepts `"outdoors"`, `"woodland"`, `"ruin"`, and `content.KnownRoom(area)` (`in:*`, including `in:home:0`..`in:home:7`). Both `"village"` and `"home:<g>"` are removed from `validArea`.
  - `presence_socket.go`: `validPresenceRoom` accepts `outdoors:<cx>:<cy>` (for any `OnGrid` chunk, which now includes `hearthwick` and `lot:0..7`), `"woodland"`, `"ruin"`, and `in:*`.
  - `spend_op.go`: `req.Kind == "rest"` checks `location.At(location.Space(s.State.Area), s.State.Position.X, s.State.Position.Y).Rest == location.RestVillage`. `req.Kind == "home-rest"` allows resting at a bedroll on your own lot in `outdoors` (`At().ID == fmt.Sprintf("lot:%d", home.Gate)`) as well as at the hearth in `in:home:<g>`.
  - `fishing.go`: `nearBank` checks `location.At(location.Space(s.State.Area), s.State.Position.X, s.State.Position.Y).ID == w.GetArea()` (`"hearthwick"`).
  - `home_placement.go` / `gathering.go`: validate lot placement, clearing, and gathering against the `24×24` lot land at `lotOrigin(gate)` on `outdoors`.
  - `story_ops.go` (`fall`) & `rules.go` (`NewState`): new players start at `Area: "outdoors"`, `Anchor("hearthwick:spawn")`; defeat recovery (`fall`) lands at `Anchor("hearthwick:well")`.
  - `worlds.go` & `store/rooms.go`: `arriveFromHome` resolves `Anchor(fmt.Sprintf("hearthwick:lot:%d", gate))` (fallback `hearthwick:arch`); `recoverRoom` resolves the room's front door `Entry` on `outdoors` (fallback `hearthwick:spawn`).
- **Migration `037_one_town.sql`:**
  - Relocate `player_place` rows with `area = 'village'` → `('outdoors', 72, 968)` (`hearthwick:spawn`); `area = 'outdoors' AND y >= 384` → `('outdoors', 40, 424)` (`hearthwick:arch`); `area LIKE 'home:%'` → `('outdoors', lotDoorstepX, lotDoorstepY)`; bump `players.version` and `place_set_version` for all affected accounts.
  - Shift `homestead_cleared`, `homestead_stumps`, `homestead_plants`, and outdoor `homestead_items` by `x = x - 8, y = y - 3`. Delete out-of-bounds/reserved rows from `homestead_cleared`, `homestead_stumps`, and `homestead_plants`; move out-of-bounds/blocked outdoor `homestead_items` rows to `location = 'storage', scene = NULL, x = NULL, y = NULL, rotation = NULL`.
  - `DELETE FROM wild_epochs WHERE kind = 'wick';` so the expanded outskirts and Wend regenerate together.

### 6.3 Client changes and code to delete

- **Attach per chunk in `FixedChunk` / `FixedLife` / `VillageLayer` / `HomesteadLayer`:**
  - `FixedChunk`: support `groundUnder` on building scenery objects (`p1:house-west`, `p1:house-middle`, `p1:house-ada`, `commons-art:hearthwick-library`, `mill-house`) so tile-house roofs are replaced cleanly when building textures exist; attach the Town Lantern (`light: "village"`) as a `glimSpot` (`id: "hearth"`).
  - `VillageLayer.attachChunk`: attach the Tolley mill's animated waterwheel (`millWheel`), hopper interaction (`village:hopper`), well canopy (`project:well-canopy:complete`), Ada's permanent window glow (`project:cooley-window-fund:complete`), and notice board interaction (`village:board`) to the chunk holding their tile.
  - `Fishing`: attach/detach the Mill Pond's three banks (`north`, `east`, `race`) when chunk `(1, 3)` attaches/detaches on `outdoors`, and read `world.open.groundAt(tx, ty)` in `floatSpot()` when `world.open` is set.
  - `PipWalkOn`: run on `outdoors` when Pip is attached in `npcs`.
  - `Hero`: passive HP regen for demo vitals checks `at(this.deps.world.areaId, this.sprite.x, this.sprite.y).rest === 'village'`.
  - `HomesteadLayer`: attach/detach each lot chunk `(-3..-2, 1..4)` on `outdoors` (ground decor, cleared tiles, fence, gateposts, sign, shelf, camp/cottage, mailbox, furniture, stable, yard pets, and lot-scoped Arrange mode).
- **Client code deleted:**
  - `buildVillage` and `villageForeground` in `src/game/worlds.ts`, plus the `village` entry in `AREA_KINDS`.
  - `src/game/homeland.ts` as a standalone `WorldData` builder (`homeLandKind` in `worlds.ts`, `prepareHomeLand` transitions in `WorldScene.ts`, `parseHomeArea` scene branches) — replaced by the per-chunk lot builder in `src/game/wilds/lot-chunk.ts`.
  - `resolve` and `contentTile` in `src/lib/location.ts` (and every call site in `items.ts`, `repairs.ts`, `papers.ts`, `resident-cycle.ts`, `doors.ts`, `village-life.ts`, `goal-route.ts`, `goal-guide.ts`).
  - Legacy `commons` warp/area shims in `src/lib/state.ts` and `src/game/scenes/world-dev-hooks.ts`.

---

## 7. Performance and the first-pass hitch

### 7.1 Chunk counts and window cost (using S6 numbers)

In 0.10, the Commons is `3×2 = 6` fixed chunks. In One Town:
- `hearthwick` is `3×3 = 9` fixed chunks (`cx = -1..1, cy = 1..3`).
- The Plot Area is `2×4 = 8` lot chunks (`cx = -3..-2, cy = 1..4`).
- Total authored/lot chunks = **17 chunks**, but **`WildsWindow` only ever attaches the `3×3 = 9` chunks around the hero** (plus up to 3 chunks held inside the 8-tile `SLACK_TILES` band before `dropBehind` drains them at 1 chunk per frame).

Using the measured S6 numbers (`perf/seam-results.json`, macOS arm64 Chromium, 4× CPU throttle, 390×844 @ DPR 3):

| Operation | S6 Desktop (ms) | S6 Phone 4× CPU (ms) | Impact in One Town |
|---|---:|---:|---|
| `attach:fixed` (sync: ground + collision) | 1.5 | 5.4 | Crossing a chunk edge attaches at most 1 chunk per frame (`step()` returns after one attach). |
| `build:slice` (budget 4 ms/frame) | 5.1 | 10.2 | Spreads trees, pieces, lights, signs, doors, and fixtures across frames after collision is live. |
| `detach` (1 chunk/frame drain) | 4.7 | 16.2 | `dropBehind` drains 1 chunk per frame even when stationary; no multi-chunk teardown spike. |
| Walking p50 / p95 / max (phone churn) | 16.7 / 16.8 / 16.8 | 16.7 / 16.8 / 50.0 | **0 browser tasks > 50 ms** across 10 full detach/reattach laps. |

Why the `3×3` town footprint (`cx = -1..1, cy = 1..3`) is particularly fast:
1. **Zero chunk churn during town errands:** When the hero stands anywhere in the center chunk `(0, 2)` (the entire 18×14 Square, Middle House, North Walk, and Pip's Garden approach), the `3×3` attached window is `cx = -1..1, cy = 1..3`—**all 9 chunks of `hearthwick` are attached at once**. Walking from the Square to the Bakery, Library, Carters' Apron, Silas's Yard, Ada's House, or Finn's Mill stays within the 8-tile slack of `(0, 2)` or shifts the window by one chunk only when stepping past $x = -8$, $x = 32$, $y = 40$, or $y = 80$.
2. **One tilemap for `hearthwick`:** `groundFor(fp)` builds one Phaser tilemap for the `72×72` `hearthwick` footprint behind the scene fade (`4,608` → `5,184` tiles, only 50% larger than the `72×48` step-3 Commons), and each `FixedChunk` lays a `24×24` layer slice in `0.4–0.9 ms` desktop / `3.7 ms` throttled phone.
3. **Bounded object density per chunk:** Splitting the town across 9 chunks keeps each chunk's object count at **40–90 objects** (vs ~180 in the densest step-3 Commons chunk), and each lot chunk has at most **~60 decor/furniture sprites** (comparable to an ordinary Tangle chunk's `5.0 ms` scenery build).

### 7.2 Fixing the first-pass hitch on the Commons: pre-warming code-drawn textures

**What the owner noticed:** On the first walk across the Commons in a fresh session, a single noticeable frame hitch occurred when a fixed chunk's `attach:fixed:pieces` slice ran for the first time (`S5 NOTES`: *"A single piece can exceed the slice the first time a code-drawn texture is made"*).

**Root cause in the code:**
1. **`ensureSceneryTexture(scene, key)` (`src/game/commons-art.ts:174`):**
   - While fixed textures like `commons-board`, `gatepost-small`, and `deco-*` are generated up front in `BootScene.create()`, modular hedge and fence runs (`fence-h-<n>`, `fence-v-<n>`, `hedge-h-<n>`, `hedge-v-<n>`) are generated **lazily on demand** the first time `FixedChunk.pieces()` calls `ensureSceneryArt(scene, s.key)` during a walking frame!
   - For each new run length `n` (e.g. `fence-h-14`, `fence-v-15`, `fence-v-6`), `deliveredRun` (`commons-art.ts:199–261`) allocates an HTML5 canvas at `artDensity = 4` (up to `896×64` texels), blits `n` frame pieces, calls `c.getImageData(0, 0, tw, h * k)` (a synchronous GPU→CPU readback), loops in JavaScript over every seam column to copy pixels, calls `c.putImageData`, and uploads a new WebGL texture via `addArtCanvas`—all inside one indivisible iteration of `FixedChunk.pieces()`!
2. **`ensureRepairTexture(scene, key)` (`src/game/entities/repairs.ts:177`):**
   - `RepairsLayer.place()` similarly calls `ensureRepairTexture(scene, 'repair-<target>-broken' | 'mended')` lazily when a repair chunk attaches, and even deletes unused repair textures on detach (`repairs.ts:148–151`), forcing them to be redrawn on canvas and re-uploaded to WebGL every time the player walks back into range!

**The fix:**
1. **Pre-warm all layout scenery runs behind the scene fade (`src/game/wilds/window.ts`):**
   - Add `prewarmFixedArt(scene: Phaser.Scene, fp: FixedFootprint)` and call it in `WildsWindow`'s constructor right beside `this.groundFor(fp)` (and on `EV.fixedReady` if the footprint arrives during the initial fade hold):
     ```ts
     export function prewarmFixedArt(scene: Phaser.Scene, fp: FixedFootprint): void {
       const seen = new Set<string>()
       for (const list of fp.objects.values()) {
         for (const o of list) {
           if (o.variant && !seen.has(o.variant)) {
             seen.add(o.variant)
             ensureSceneryArt(scene, o.variant)
           }
         }
       }
     }
     ```
2. **Pre-warm all 12 repair textures once in `BootScene.create()` (`src/game/repairs-art.ts`):**
   - Call `generateRepairArt(this)` in `BootScene.create()` to generate the 6 broken and 6 mended small repair textures once at boot (they total `< 32 KB` of RGBA), and remove the dynamic `this.scene.textures.remove(key)` churn from `RepairsLayer.sync()`.

With those two changes, **zero canvas drawing, zero `getImageData` readbacks, and zero WebGL texture uploads happen during `FixedChunk` attachment while walking.**

---

## 8. Build plan

Six shippable, testable lanes (`T1`–`T6`).

| Lane | Kind | Delivers | Depends on |
|---|---|---|---|
| **T1. Town layout & location contract** | Go + TS content/libs | `places.proto`/`places.json` (`hearthwick` 3×3, `town-walk` zone, `homestead-lots` 2×4, anchors), `layouts/hearthwick.json` (72×72), updated coordinates in `rooms`, `residents`, `repairs`, `items`, `fishing`, `gathering`, `story`, `quests`, `papers`. Delete `location.Resolve` / `resolve`. Shared location vectors. | — |
| **T2. Outskirts frontier & generator seams** | Go + TS wilds/frontier | Remove `southLimit: 0`; include fixed footprints in `NearestFootprint` and `frontier.Rect` (`cx = -6..4, cy = -8..7`). `base_v3.go` `seamMirror`/`keptReader` copy fixed road mouths; `cells.go`/`routes.go`/`wend.go` route around `hearthwick` and the lots and connect to the North, East, South, and West gates. | T1 |
| **T3. Town life & rules on `outdoors`** | Go + client | Server: `spend_op.go` `RestVillage` via lookup, `fishing.go` `nearBank` on `hearthwick`, `story.go` unified `hearthwick` rules, `fall` recovery to `hearthwick:well`, new-player spawn at `hearthwick:spawn`. Client: `FixedChunk` `groundUnder` + `hearth` glim spot, `VillageLayer` per-chunk mill wheel/hopper/well canopy/Ada window/board, `Fishing` per chunk on `outdoors`, `PipWalkOn` and `ROUTINES.hearthwick` on `outdoors`, `GoalGuide` simplified `ROAD`. | T1, T2 |
| **T4. Seamless 1-chunk plot lots** | Go + client | `homestead.json` `24×24` land config (`generator: 2`), `lot-chunk.ts` / fixed composer for `lot:0`..`lot:7` (`cx = -3..-2, cy = 1..4`) with 4-tile lanes, `HomesteadLayer` per-chunk attach/detach of camp/cottage, fence, sign, shelf, mailbox, furniture, stable, yard pets, and lot-scoped Arrange/clear mode. `in:home:<g>` doors return to lot doorstep on `outdoors`. | T1, T3 |
| **T5. Cutover migration, map & deletions** | Go + client | Migration `037_one_town.sql` (`player_place` from `village`, step-3 Commons, and `home:<g>` → `outdoors`; `(-8,-3)` shift for home items/clears/plants with storage fallback; expire old `wick` epoch). Drop `village` and `home:<g>` from `validArea` and presence rooms. World map labels for `hearthwick` and lots, plus indoor hero dot resolution. Delete `buildVillage`, `homeland.ts` standalone scene, and legacy `commons` shims. | T2, T3, T4 |
| **T6. Pre-warm fix, perf & playtest** | Client/perf | `prewarmFixedArt` behind the scene fade + `generateRepairArt` at boot; update `perf/seam.perf.ts` and `e2e/` specs for the 4 town seams and lot walks; phone playtest checklist. | T5 |

### Acceptance criteria

- **T1:** Go `content` and `location` tests and Node `tests/location.test.ts` pass on the shared vectors. Every door, anchor, NPC spot, repair, pickup, paper, and fishing bank in `hearthwick` checks as reachable open ground (or bordering open ground for targets) from `hearthwick:spawn` and all four gates. Zero references to `location.Resolve` or `resolve` remain.
- **T2:** Go `wilds` and `frontier` tests verify:
  - `frontier.Rect` is `(-6, -8)..(4, 7)`;
  - generated `wick` chunks at `(0, 4)` (South Gate), `(2, 2)` (East Gate), `(-4, 2)` (West Gate), `(-3, 0)` (North Homestead Spine), and `(-3, 5)` (South Homestead Spine) mirror the 3–4-tile road openings and close the rest of the shared edge;
  - every cell in the expanded frontier is dry-reachable from the Tangle and from `hearthwick`'s gates across 10 seeds;
  - the Wend never enters `hearthwick` or the plot area.
- **T3:** Go API tests pass for `spend` (`rest` in `hearthwick`, refused in the Tangle/outskirts), `fishing` at the Mill Pond on `outdoors`, `repairs` (all 6), `gathering` (Mudrise shore, Quiet ice, Bloom patches), and `quests` (`signpost`, `lantern-road`, `your-own-day`, `set-to-rise`, `stuck-hoist`, `seat-by-the-lamp`, `a-line-in-the-race`). Client unit tests verify attach/detach of mill wheel, fishing banks, house lights, and NPC routines leave zero leaked objects, timers, tweens, or listeners.
- **T4:** Go tests verify `24×24` lot generation, placement validation, saw clearing, gathering, and `home-rest` on `lot:0`..`lot:7`. Client unit and E2E tests (`e2e/homestead.spec.ts`, `e2e/yard.spec.ts`): walk from the Square down West Road onto `lot:0`, claim it at Pell's desk, walk onto the lot with no scene restart, place furniture and a stable, enter the cottage (`in:home:0`) and step back out onto the lot doorstep; a second player sees the cottage and furniture from the public lane.
- **T5:** Go upgrade test (`outdoors_upgrade_test.go`) verifies migration `037_one_town.sql` on fixtures with players in `village`, step-3 Commons, Tangle, `home:0`, and `in:village:bakery`, plus a home with in-bounds and out-of-bounds outdoor items (asserting the out-of-bounds item lands in `storage`). E2E suite passes with `buildVillage` and `homeland.ts` deleted.
- **T6:** `npm run perf:walk`:
  - `FixedChunk.pieces()` never calls canvas `getImageData` or creates a new WebGL texture during walking frames (asserted by a unit test and texture-count check);
  - desktop and throttled-phone walks across all four gates (North, East, South, West/Lots) record zero browser tasks `> 50 ms` and return to baseline display-object, body, texture, and listener counts.

### Risks

- **T1/T3 (Quest and E2E coordinate churn):** Many existing Go and E2E tests hardcode `area: "village"` or old village tile coordinates. Mitigate by updating `server/internal/api/test_helpers_test.go` and `e2e/helpers.ts` (`warp`, `waitForArea`) first in T1/T3 so `warp(page, 'village', ...)` or named anchor warps resolve onto `hearthwick` in `outdoors`.
- **T2 (Reachability around a larger kept footprint):** The `3×3` town + `2×4` plot block is larger than the `3×3` Tangle alone. Keep the 10-seed `ensureReach` test in `gen_v3_test.go` and verify that `wend.go`'s `west` bound leaves at least 2 chunks (`cx = -6..-5`) west of the plot area (`cx = -3..-2`).
- **T4 (Multiple claimed lots visible in one 3×3 window):** Standing on Homestead Lane (`x = -48`) attaches up to 6 lot chunks in the 3×3 window at once. Spread each lot's `HomesteadLayer.fixedHooks.attach(key)` steps across the `BUILD_MS` queue (1 step for ground/fence, 1 for cottage/mailbox/sign, 1 for furniture/plants, 1 for stable/pets), matching S5a/S6's per-gate slicing.

---

## 9. Decisions for the owner

Decisions 1–5 were settled in the design conversation for this lane (§0); the owner accepted 6–8 as recommended later the same day.

| # | Decision | Recommendation | Status |
|---|---|---|---|
| 1 | **Town footprint size** | **3×3 chunks (`cx = -1..1, cy = 1..3`, 72×72 tiles)**, matching the Tangle's width and cell `(0, 1)`. | **Decided 2026-10-14:** 3×3 chunks (§0 #1). |
| 2 | **Wells and notice boards** | Consolidate to **one well and one notice board** in the Town Square; keep the hame, Carting Day stalls, and Elara's camp on the northern Carters' Apron. | **Decided 2026-10-14:** one well, one board (§0 #2). |
| 3 | **Brackenwood & Ashwatch** | Keep `woodland` and `ruin` as transition spaces entered through the **Brackenwood Arch** on Lantern Road for now, while opening all four town sides (N, E, S, W) to the `outdoors` Wilds. | **Decided 2026-10-14:** Option A, trailhead portal for now (§0 #3). |
| 4 | **Canonical place ID** | **`"hearthwick"`** for the merged town footprint and layout. | **Decided 2026-10-14:** `"hearthwick"` (§0 #4). |
| 5 | **Home plots (`lot:0`..`lot:7`)** | **Seamless 1-chunk (`24×24`) lots on `outdoors`** in a `2×4` neighbourhood west of town (`cx = -3..-2, cy = 1..4`), drawn with the Wilds (`tangle`) look and `safe: true` (no camps/mobs); only the cottage door (`in:home:<g>`) transitions. | **Decided 2026-10-14:** seamless 1-chunk Wilds-look lots beside town (§0 #4). |
| 6 | **Existing outdoor home items outside the new `24×24` lot bounds** | Shift outdoor items by `(-8, -3)` so the cottage site (`16,6 → 8,3`) and nearby pieces keep their relative spot; return any piece in the old far margins to the home's **storage chest** (`location = 'storage'`) so nothing is lost. | **Decided 2026-10-14:** as recommended. |
| 7 | **Saved `village` and step-3 Commons player positions** | Move `village` saves to `hearthwick:spawn` `(4, 60)` and step-3 Commons saves (`y >= 384`) to `hearthwick:arch` `(2, 26)` with a version barrier bump; keep Tangle/Wilds (`y < 384`) and `in:*` room saves at their exact coordinates. | **Decided 2026-10-14:** as recommended. |
| 8 | **Room IDs (`in:village:bakery`, `in:commons:yard`, etc.)** | Keep the internal room IDs (`in:village:*`, `in:commons:yard*`, `in:home:*`) unchanged in `rooms.json` and saves while pointing their outdoor doors to `"hearthwick"` / lot doorsteps. Avoids churning room IDs in quests and saves. | **Decided 2026-10-14:** as recommended. |


### T5 local-save compatibility (owner decision, 2026-10-14)

New local saves carry `layout: "one-town-v1"`. Untagged version-1 files that
already say `outdoors` keep their coordinates: pre-0.10 Commons exports cannot
be distinguished reliably from current outdoor saves. Only the once-only
server migration 037 applies the `y >= 384` relocation. Explicit retired
village/Commons/home save names still import at the authored spawn/arch/doorstep.
Displaced plants return a seed to home storage and retain archived history;
a seed is compensation, not the preserved grown plant. Stored stables keep
their stalls and mounts, which become available after re-placement.
Plot services require private ground (`lx=3..20, ly=2..18`, plus the gate
cells `lx=11..12, ly=19`); public lanes remain outside. Whole-lot Arrange, including saw clearing,
requires presence inside that fence; tool gathering and planting also require
individual target reach.
