"""Hearthwick 2 blockout sketch. Throwaway: renders docs/design/img/hearthwick-2-sketch.png.

Block-local tiles: X = world x + 48, Y = world y - 24. The fixed block is X 0..119, Y 0..95
(cx -2..2, cy 1..4). Run: python3 scripts/hearthwick-2-sketch.py
"""
import math, random, sys
from PIL import Image, ImageDraw, ImageFont

S = 10                      # px per tile
MX, MY = 8, 10              # Wilds margin drawn around the block, in tiles
W, H = 120, 96
img = Image.new('RGB', ((W + 2 * MX) * S, (H + 2 * MY) * S), '#2f3d26')
d = ImageDraw.Draw(img)
F = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', 11)
FB = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', 14)
FS = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', 9)
rnd = random.Random(7)

def px(x, y): return ((x + MX) * S, (y + MY) * S)
def rect(x, y, w, h, fill, outline=None, width=1):
    d.rectangle([px(x, y), (px(x + w, y + h)[0] - 1, px(x + w, y + h)[1] - 1)], fill=fill, outline=outline, width=width)
def disk(cx, cy, r, fill, outline=None, width=1):
    a, b = px(cx - r, cy - r), px(cx + r, cy + r)
    d.ellipse([a, b], fill=fill, outline=outline, width=width)
def label(x, y, text, font=F, fill='#1d1a14', anchor='mm'):
    light = fill.lower() in ('#f4ecd8', '#e8e0c8', '#f3e2a8')
    d.text(px(x, y), text, font=font, fill=fill, anchor=anchor, stroke_width=2, stroke_fill='#1d1a14' if light else '#f4ecd8')
def tree(x, y, r=1.2, col='#3f6b35'):
    disk(x, y, r, col, '#22361d')

# --- Wilds around and the Tangle to the north ------------------------------------------------
for i in range(900):
    x, y = rnd.uniform(-MX, W + MX), rnd.uniform(-MY, H + MY)
    if 0 <= x < W and 0 <= y < H: continue
    tree(x, y, rnd.uniform(0.9, 1.6), rnd.choice(['#2e4a28', '#36552c', '#24401f', '#40603a']))
rect(24, -MY, 72, MY, '#263220')
for i in range(220):
    tree(rnd.uniform(24, 96), rnd.uniform(-MY, -0.5), rnd.uniform(0.9, 1.5), rnd.choice(['#1f3a1c', '#2a4524', '#33502b']))
label(60, -6, 'THE TANGLE (still)', FB, '#e8e0c8')
rect(49, -MY, 3, MY, '#8a7350')              # Tangle south road to the arch
label(-MX / 2, 48, 'WILDS', FB, '#e8e0c8'); label(W + MX / 2, 48, 'WILDS', FB, '#e8e0c8')
label(60, H + 6, 'WILDS (south)', FB, '#e8e0c8')

# --- Ground ----------------------------------------------------------------------------------
rect(24, 0, 72, 72, '#8db35a')               # town grass (painted, meadow palette)
rect(24, 72, 72, 24, '#93b45c')              # Southfields
# outer band feathering: Wilds creep into the town's last tiles
for i in range(260):
    side = rnd.random()
    if side < .5:
        x = rnd.uniform(27, 93); y = rnd.choice([rnd.uniform(0.3, 3), rnd.uniform(92.5, 95.7)])
    else:
        x = rnd.choice([rnd.uniform(27.3, 29), rnd.uniform(91, 92.7)]); y = rnd.uniform(0, 95)
    if not (47 <= x <= 63 and (y < 4 or y > 90)):
        tree(x, y, rnd.uniform(0.6, 1.1), rnd.choice(['#3d6234', '#4a7040', '#355a2e']))

# --- Lots (west tangle, east meadow) ---------------------------------------------------------
def lot(x0, y0, gate, west):
    g = '#3b5230' if west else '#86b04f'
    rect(x0, y0, 24, 24, g)
    # verge rows (hedge + trees), shared between stacked lots
    for vy in (y0, y0 + 23):
        rect(x0, vy, 24, 1, '#2f4426' if west else '#5f8a3a')
    # fences: sides on ly 1 and 22, front on the town side
    fx = x0 + 23 if west else x0
    bx = x0 if west else x0 + 23
    for ly in (1, 22):
        d.line([px(x0 + 0.5, y0 + ly + .5), px(x0 + 23.5, y0 + ly + .5)], fill='#6b4a2a', width=3)
    d.line([px(fx + .5, y0 + 1.5), px(fx + .5, y0 + 11)], fill='#6b4a2a', width=3)
    d.line([px(fx + .5, y0 + 13), px(fx + .5, y0 + 22.5)], fill='#6b4a2a', width=3)
    # back: lantern line, dashed stakes, open to the Wilds
    for ly in range(2, 22, 2):
        rect(bx + .35, y0 + ly + .3, .3, .5, '#d9b45a')
    # scattered Wilds trees in the plot
    rr = random.Random(gate * 13 + 1)
    for i in range(22 if west else 12):
        x, y = rr.uniform(x0 + 2, x0 + 22), rr.uniform(y0 + 2.5, y0 + 21)
        if x0 + 7 <= x <= x0 + 17 and y0 + 2 <= y <= y0 + 14: continue
        tree(x, y, rr.uniform(.8, 1.3), rr.choice(['#24401f', '#2e4a28', '#1f3a1c']) if west else rr.choice(['#4f7a3a', '#5b8a44', '#3f6b35']))
    if not west:
        for i in range(30):
            x, y = rr.uniform(x0 + 2, x0 + 22), rr.uniform(y0 + 2.5, y0 + 21)
            disk(x, y, .2, rr.choice(['#f3e27a', '#f0a3c0', '#ffffff']))
    # cottage site (lx 8..15, ly 3..8), path to the town-side gate
    rect(x0 + 8, y0 + 3, 8, 6, '#c9b48a', '#7a6440')
    label(x0 + 12, y0 + 6, 'home site', FS)
    rect(x0 + 11, y0 + 9, 2, 3, '#b89a68')
    if west: rect(x0 + 11, y0 + 11, 12, 2, '#b89a68')
    else: rect(x0 + 1, y0 + 11, 12, 2, '#b89a68')
    label(x0 + 12, y0 + 17, f'Lot {gate}', FB, '#f4ecd8' if west else '#1d1a14')

for row in range(4):
    lot(0, row * 24, row * 2, True)
    lot(96, row * 24, row * 2 + 1, False)
label(12, 98.5, 'WEST LOTS: tangle', F, '#f4ecd8'); label(108, 98.5, 'EAST LOTS: meadow', F, '#f4ecd8')

# wildgates between lots 2/4 and 3/5 (Y 47..48)
rect(0, 47, 24, 2, '#a48a5c'); rect(96, 47, 24, 2, '#a48a5c')
label(10, 48, 'west wildgate', FS); label(110, 48, 'east wildgate', FS)

# --- Lot Row lanes (X 24..26 and 93..95, through Southfields to the south edge) --------------
rect(24, 0, 3, 96, '#b8996a'); rect(93, 0, 3, 96, '#b8996a')
for y in range(4, 92, 12):
    disk(27.5, y, .45, '#f3c25a'); disk(92.5, y, .45, '#f3c25a')   # lane lamps on the verge
label(25.5, 60, 'Lot Row West', FS, anchor='mm'); label(94.5, 60, 'Lot Row East', FS)

# --- Town roads ----------------------------------------------------------------------------
C = (60.5, 36.5)
COB, LANE, ALLEY = '#cdb88e', '#c2a676', '#d6c7a2'
def ring(r0, r1, col):
    # rounded-square ring (superellipse) drawn per tile
    for y in range(0, 72):
        for x in range(27, 93):
            dx, dy = abs(x + .5 - C[0]), abs(y + .5 - C[1])
            n = (dx ** 4 + dy ** 4) ** .25
            if r0 <= n < r1: rect(x, y, 1, 1, col)
ring(16.5, 18.5, LANE)                                  # Ring Lane, 2 wide
# spokes, 3 wide
rect(59, 10, 3, 20, COB)                                # north spoke / Tangle Lane
for i in range(9):                                      # bends to the arch at X 49..51
    rect(59 - i - 1, 10 - i - 1, 3, 2, COB)
rect(49, 0, 3, 2, COB)
rect(27, 25, 16, 2, ALLEY_W := '#d6c7a2'); rect(77, 25, 16, 2, ALLEY_W)   # cross lanes, outer band
rect(27, 61, 66, 2, ALLEY_W)                                                 # Garden Lane
rect(59, 43, 3, 53, COB)                                # South Road, through Southfields to the gate
rect(27, 35, 27, 3, COB)                                # West Road to Lot Row West
rect(67, 35, 26, 3, COB)                                # Lantern Road to Lot Row East
# the square: a round cobbled plaza
disk(C[0], C[1], 8, COB, '#9c8558', 2)
# alleys (1 wide) on the diagonals inside the ring
for (ax, ay, bx, by) in [(53, 30, 47, 24), (68, 30, 74, 24), (53, 43, 47, 49), (68, 43, 74, 49)]:
    d.line([px(ax + .5, ay + .5), px(bx + .5, by + .5)], fill=ALLEY, width=S)

# --- The Wick Tree and square furniture ----------------------------------------------------
disk(C[0], C[1], 3.2, '#4d7a32', '#2a3f1a', 2)
for a in range(0, 360, 30):
    r = 2.6
    disk(C[0] + r * math.cos(math.radians(a)), C[1] + r * math.sin(math.radians(a)), .35, '#ffd36b')
disk(C[0], C[1] + 1.6, .9, '#8a8478', '#4a453c')           # hearth-stone at its foot
label(C[0], C[1] - 4.3, 'Wick Tree', FB)
disk(55.5, 40.5, 1.1, '#7fa6c9', '#4b5a66', 2); label(55.5, 42.4, 'well', FS)
rect(65, 31, 2, 1, '#7a5a34'); label(66, 30.2, 'board', FS)
rect(57, 40, 2, 1, '#8a6a44'); label(58, 41.8, 'bench', FS)
disk(67.5, 34, .4, '#7a5a34'); label(69.2, 33.6, 'sign', FS, anchor='lm')
for i, (x, y) in enumerate([(62.5, 42), (65, 40.3), (56, 32.5)]):   # Carting stalls around the square
    rect(x - 1, y - .6, 2, 1.2, ['#c96a4a', '#d9b45a', '#6a8fc9'][i], '#5a4632')

# --- Buildings (south-facing; door marked) -------------------------------------------------
ROOF = {'shop': '#a0533b', 'home': '#7d5a44', 'civic': '#5a6f8a', 'work': '#6b6b5a', 'farm': '#8a4a34', 'keep': '#b07a3a'}
def bld(x, y, w, h, name, kind='home', door=None, small=False):
    rect(x, y, w, h, ROOF[kind], '#2b221a', 2)
    dx = x + (door if door is not None else w // 2)
    rect(dx, y + h - 1, 1, 1, '#f3c25a')
    if name: label(x + w / 2, y + h / 2 - .3, name, FS if small else F, '#f4ecd8' if kind not in ('keep', 'civic') else '#1d1a14')
def row(xs, y, w=4, h=4):
    for x in xs: bld(x, y, w, h, '', 'home', w // 2)

# core NW
row([46, 50, 54], 21)
bld(51, 26, 6, 4, 'Bakery', 'keep', 3)
bld(45, 26, 5, 4, '', 'home', 2)
bld(45, 31, 4, 4, '', 'home', 2)
bld(49, 31, 4, 4, 'Chandler', 'shop', 2, True)
# core NE
row([63, 67, 71], 21)
bld(63, 25, 8, 5, 'Inn', 'shop', 4)
bld(72, 26, 4, 4, '', 'home', 2)
bld(69, 31, 5, 4, 'Land office', 'civic', 2)
bld(74, 31, 3, 4, '', 'home', 1)
# core SW
bld(46, 38, 5, 4, 'Library', 'keep', 2)
row([45, 49], 43)
row([46, 50, 54], 48)
# core SE
bld(69, 38, 6, 4, 'Smithy', 'work', 2)
bld(63, 43, 7, 4, 'Guildhouse', 'civic', 3)
bld(71, 43, 5, 4, 'Orrin', 'work', 2, True)
row([63, 67, 71], 48)
# outer band north: houses facing the ring, apron, camp, orchard
row([44, 48, 52], 13)
row([63, 67, 71, 75], 13)
rect(31, 3, 14, 8, '#bfae86', '#8a7450'); label(38, 6.5, "Carters' Apron", F); label(38, 8.5, '(hame on gatepost)', FS)
disk(55, 3.5, 1, '#5a4a3a'); label(57, 3.5, "Elara's camp", FS, anchor='lm')
for i in range(6):
    for j in range(2):
        tree(66 + i * 3.8, 3.5 + j * 4, 1, '#5d8f3f')
label(76, 11.3, 'Bloom orchard', FS)
# outer band west: blocks between cross lanes
bld(30, 20, 6, 4, 'Ada', 'keep', 4, True)
row([37], 20, 5)
row([30, 35], 30, 5); bld(40, 30, 3, 4, '', 'home', 1)
row([30, 35], 40, 5)
bld(30, 47, 7, 4, 'Middle house', 'keep', 3, True)
rect(38, 46, 5, 6, '#a98a5a', '#6b4a2a'); label(40.5, 49, "Pip's", FS)
# outer band east
row([80, 85], 20, 5); row([80, 85], 30, 5)
rect(86, 38, 3, 1, '#4a7a3a', '#22361d'); label(87.5, 39.8, 'Brackenwood Arch', FS)
rect(79, 43, 11, 8, '#6e9a48', '#4d6b33'); label(84.5, 47, 'kitchen gardens', FS)
# outer band south, along Garden Lane
row([33, 38, 43, 48], 57, 4); row([64, 68, 72, 76, 80, 85], 57, 4)
rect(30, 64, 26, 6, '#7aa452', '#4d6b33'); label(43, 67, 'allotments', FS)
for i in range(6): tree(66 + i * 4, 67, 1.1, '#5d8f3f')
label(76, 70.3, 'pear walk', FS)
# --- Southfields --------------------------------------------------------------------------
label(60, 73.5, 'SOUTHFIELDS', FB)
bld(32, 76, 6, 4, 'Silas', 'keep', 2, True)      # cottage-silas, in:commons:yard
bld(40, 75, 8, 5, 'Barn', 'farm', 4)
rect(31, 82, 18, 6, '#a6875a', '#6b4a2a'); label(40, 85, 'timber yard', F)
for fx in range(31, 55, 1):
    if fx % 2 == 0: rect(fx, 89, 1, 6, '#7a5a34')
    else: rect(fx, 89, 1, 6, '#8f6c40')
label(42, 92, 'fields', F, '#f4ecd8')
# mill, race and pond
rect(68, 76, 4, 4, ROOF['keep'], '#2b221a', 2); label(70, 77.6, 'Mill', F)
rect(72, 77, 1, 3, '#5d8fc0'); disk(72.5, 80.2, .9, '#7a5a34')
rect(73, 75, 9, 6, '#6f9fd0', '#4b6a88'); label(77.5, 78, 'mill pond', FS)
disk(83.5, 74, 1.4, '#6f9fd0', '#8a8478', 2); label(86, 72.6, 'spring', FS, anchor='lm')
for fx in range(64, 92):
    rect(fx, 86, 1, 8, '#7a5a34' if fx % 2 else '#8f6c40')
label(78, 90, 'fields', F, '#f4ecd8')

# --- Chunk grid and labels ------------------------------------------------------------------
for cx in range(6):
    x = cx * 24
    d.line([px(x, 0), px(x, 96)], fill='#ffffff', width=1)
for cy in range(5):
    y = cy * 24
    d.line([px(0, y), px(120, y)], fill='#ffffff', width=1)
for cx in range(5):
    label(cx * 24 + 12, -1, f'cx {cx - 2}', FS, '#e8e0c8')
for cy in range(4):
    label(-1.5, cy * 24 + 12, f'cy {cy + 1}', FS, '#e8e0c8')

# exits
for (x, y, t) in [(50.5, -.7, 'Tangle Arch'), (60.5, 96.6, 'South Gate'), (25.5, 96.6, 'SW lane end'), (94.5, 96.6, 'SE lane end')]:
    label(x, y, t, FS, '#f3e2a8')

out = sys.argv[1] if len(sys.argv) > 1 else 'docs/design/img/hearthwick-2-sketch.png'
img.save(out)
print(out, img.size)
