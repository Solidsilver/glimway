#!/usr/bin/env python3
"""Rebuild Yard frame canvases and metadata from the preserved generated sheets."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent
JOBS = json.loads((ROOT / "jobs.json").read_text())
SHEETS = ROOT / "sheets"
FRAMES = ROOT / "frames"
FRAMES.mkdir(exist_ok=True)

sources = []
manifest_frames = []
atlas_frames = {}

def alpha_clean(image):
    image = image.convert("RGBA")
    a = image.getchannel("A").point(lambda v: 0 if v < 8 else v)
    image.putalpha(a)
    return image

def contain(panel, canvas_size, dest, stretch=False):
    panel = alpha_clean(panel)
    box = panel.getchannel("A").getbbox()
    if box:
        panel = panel.crop(box)
    dx, dy, dw, dh = dest
    if stretch:
        size = (dw, dh)
        x, y = dx, dy
    else:
        scale = min(dw / panel.width, dh / panel.height)
        size = (max(1, round(panel.width * scale)), max(1, round(panel.height * scale)))
        x = dx + (dw - size[0]) // 2
        y = dy + dh - size[1]
    panel = panel.resize(size, Image.Resampling.NEAREST)
    output = Image.new("RGBA", canvas_size, (0,0,0,0))
    output.alpha_composite(panel, (x, y))
    return output, {"x":x,"y":y,"w":size[0],"h":size[1]}

used_sources = {job["source"] for job in JOBS["jobs"]} | {JOBS["resident"]["source"]}
for key, rel in JOBS["sources"].items():
    if key in used_sources:
        sources.append({"key":key,"file":rel})

for job in JOBS["jobs"]:
    source = Image.open(ROOT / JOBS["sources"][job["source"]]).convert("RGBA")
    x,y,w,h = job["crop"]
    panel = source.crop((x,y,x+w,y+h))
    canvas, destination = contain(panel, tuple(job["canvas"]), job["destination"], job.get("stretch", False))
    filename = f"{job['key']}.png"
    canvas.save(FRAMES / filename)
    cw,ch = job["canvas"]
    frame = {
        "key":job["key"], "source":job["source"],
        "sourceRect":{"x":x,"y":y,"w":w,"h":h},
        "canvasSize":{"w":cw,"h":ch}, "destinationRect":destination,
        "footprint":job["footprint"], "footPoint":{"x":cw//2,"y":ch},
        "origin":[0.5,1], "role":job["kind"],
        "file":f"frames/{filename}"
    }
    manifest_frames.append(frame)
    atlas_frames[job["key"]] = {
        "filename":job["source"],"frame":{"x":x,"y":y,"w":w,"h":h},
        "rotated":False,"trimmed":True,
        "spriteSourceSize":{"x":0,"y":0,"w":w,"h":h},
        "sourceSize":{"w":w,"h":h},
        "canvasSize":{"w":cw,"h":ch},"destinationRect":destination
    }

resident = JOBS["resident"]
resident_source = Image.open(ROOT / JOBS["sources"][resident["source"]]).convert("RGBA")
canvas_size = tuple(resident["canvas"])
cell_x = 0
active_pell = set()
for col,state in enumerate(resident["columns"]):
    cell_w = resident["grid"]["cellWidths"][col]
    cell_h = resident["grid"]["height"]
    crop = resident_source.crop((cell_x,0,cell_x+cell_w,cell_h))
    canvas,destination = contain(crop,canvas_size,resident["destination"])
    key=f"pell-{state}"
    filename=f"{key}.png"
    active_pell.add(filename)
    canvas.save(FRAMES/filename)
    cw,ch=canvas_size
    frame={"key":key,"source":resident["source"],"sourceRect":{"x":cell_x,"y":0,"w":cell_w,"h":cell_h},
           "canvasSize":{"w":cw,"h":ch},"destinationRect":destination,
           "footprint":[1,2],"footPoint":{"x":cw//2,"y":ch},"origin":[0.5,1],"role":"resident",
           "facing":"front","state":"idle","file":f"frames/{filename}"}
    manifest_frames.append(frame)
    atlas_frames[key]={"filename":resident["source"],"frame":{"x":cell_x,"y":0,"w":cell_w,"h":cell_h},
                       "rotated":False,"trimmed":True,"spriteSourceSize":{"x":0,"y":0,"w":cell_w,"h":cell_h},
                       "sourceSize":{"w":cell_w,"h":cell_h},"canvasSize":{"w":cw,"h":ch},"destinationRect":destination}
    cell_x += cell_w

# Retire the prior round's directional walk/idle cells from the active frame directory.
for stale in FRAMES.glob("pell-*.png"):
    if stale.name not in active_pell:
        stale.unlink()

animations=[{"key":"pell-breathing","frames":["pell-idle-0","pell-idle-1"],"frameRate":1.5,"repeat":-1}]

manifest={"id":"glimway-yard-pass","date":"2026-10-10","tool":"built-in image_gen","density":JOBS["density"],
          "sources":sources,"frames":manifest_frames,"animations":animations,
          "notes":["Frames are nearest-neighbour aspect-contained on native transparent canvases.",
                   "Pell is front-facing idle only, on the same 186x283 canvas as the in-game resident sheet.",
                   "The cottage retains the existing 96x92 canvas."]}
(ROOT/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
(ROOT/"atlas.json").write_text(json.dumps({"sources":sources,"frames":atlas_frames,"animations":animations},indent=2)+"\n")

# Contact sheet shows every finished canvas at true pixel size, with labels and checker backing.
cards=[]
for frame in manifest_frames:
    im=Image.open(ROOT/frame["file"]).convert("RGBA")
    label=frame["key"]
    cards.append((label,im))
cols=4
cellw,cellh=220,320
rows=(len(cards)+cols-1)//cols
sheet=Image.new("RGB",(cols*cellw,rows*cellh),(48,43,40))
draw=ImageDraw.Draw(sheet)
font=ImageFont.load_default()
for i,(label,im) in enumerate(cards):
    ox=(i%cols)*cellw; oy=(i//cols)*cellh
    # checkerboard at native size makes alpha edges inspectable; sprites themselves remain 1x.
    for yy in range(oy+20,min(oy+20+im.height,oy+cellh),16):
        for xx in range(ox+8,min(ox+8+im.width,ox+cellw-8),16):
            c=(90,82,76) if ((xx-ox)//16+(yy-oy)//16)%2 else (69,63,59)
            ImageDraw.Draw(sheet).rectangle((xx,yy,xx+15,yy+15),fill=c)
    sheet.paste(im,(ox+8,oy+20),im)
    draw.text((ox+8,oy+2),label,fill=(245,230,205),font=font)
sheet.save(ROOT/"contact-sheet.png")

# True-scale comparison board: each prop canvas sits beside two native indoors-kit canvases.
INDOORS = ROOT.parent / "indoors-pass"
COMMONS = ROOT.parent / "commons-pass"
indoor_manifest = json.loads((INDOORS / "manifest.json").read_text())
indoor_sources = {item["key"]: item["file"] for item in indoor_manifest["sources"]}
indoor_frames = {item["key"]: item for item in indoor_manifest["frames"]}


def load_indoor_canvas(key):
    item = indoor_frames[key]
    source = Image.open(INDOORS / "sheets" / indoor_sources[item["source"]]).convert("RGBA")
    rect = item["sourceRect"]
    crop = source.crop((rect["x"], rect["y"], rect["x"] + rect["w"], rect["y"] + rect["h"]))
    canvas_size = (item["canvasSize"]["w"], item["canvasSize"]["h"])
    dest = item["destinationRect"]
    crop = crop.resize((dest["w"], dest["h"]), Image.Resampling.NEAREST)
    canvas = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    canvas.alpha_composite(crop, (dest["x"], dest["y"]))
    return canvas


def commons_frame(key):
    atlas = json.loads((COMMONS / "fingersnap-residents-v2.atlas.json").read_text())
    rect = atlas["frames"][key]["frame"]
    sheet = Image.open(COMMONS / "fingersnap-residents-v2.png").convert("RGBA")
    return sheet.crop((rect["x"], rect["y"], rect["x"] + rect["w"], rect["y"] + rect["h"]))


def portrait_frame(key):
    atlas = json.loads((COMMONS / "fingersnap-portraits-residents.atlas.json").read_text())
    rect = atlas["frames"][key]["frame"]
    sheet = Image.open(COMMONS / "fingersnap-portraits-residents.png").convert("RGBA")
    crop = sheet.crop((rect["x"], rect["y"], rect["x"] + rect["w"], rect["y"] + rect["h"]))
    output, _ = contain(crop, (64, 64), (0, 0, 64, 64))
    return output


prop_pairs = [
    ("yard-counter", "kitchen-worktable-front-default", "doorway"),
    ("yard-timber-rack", "library-shelf-front-full", "kitchen-jar-shelf-front-default"),
    ("yard-mending-bench", "library-shelf-tall-left-full", "wall-pegs-front-tools"),
    ("kit-side-doorway", "interior-wall-0", "interior-wall-2"),
    ("deeds-pigeonholes", "library-shelf-front-full", "back-wall-window"),
    ("deeds-clerk-desk", "library-elara-desk-front-empty", "stool-front-default"),
    ("deeds-table", "kitchen-worktable-front-default", "chair-front-default"),
    ("cottage-silas", "back-wall-0", "back-wall-2"),
]
card_w, row_h, board_w = 272, 232, 816
board_h = 28 + len(prop_pairs) * row_h + 354 + 104
board = Image.new("RGB", (board_w, board_h), (48, 43, 40))
draw = ImageDraw.Draw(board)
font = ImageFont.load_default()
draw.text((8, 6), "YARD PASS / INDOORS KIT — native canvas scale", fill=(250, 231, 202), font=font)
frames_by_key = {item["key"]: item for item in manifest_frames}


def paste_card(image, col, top, bottom, label):
    x0 = col * card_w
    draw.text((x0 + 8, top + 3), label, fill=(245, 230, 205), font=font)
    w, h = image.size
    x = x0 + (card_w - w) // 2
    y = bottom - h
    for yy in range(y, bottom, 16):
        for xx in range(x, x + w, 16):
            color = (90, 82, 76) if ((xx-x)//16 + (yy-y)//16) % 2 else (69, 63, 59)
            draw.rectangle((xx, yy, min(xx+15, x+w-1), min(yy+15, bottom-1)), fill=color)
    board.paste(image, (x, y), image if image.mode == "RGBA" else None)

for index, (new_key, ref_a, ref_b) in enumerate(prop_pairs):
    top = 28 + index * row_h
    bottom = top + 208
    paste_card(Image.open(FRAMES / f"{new_key}.png").convert("RGBA"), 0, top, bottom, new_key)
    paste_card(load_indoor_canvas(ref_a), 1, top, bottom, ref_a)
    paste_card(load_indoor_canvas(ref_b), 2, top, bottom, ref_b)

resident_top = 28 + len(prop_pairs) * row_h
resident_bottom = resident_top + 336
paste_card(Image.open(FRAMES / "pell-idle-0.png").convert("RGBA"), 0, resident_top, resident_bottom, "pell-idle-0")
paste_card(commons_frame("silas-idle-0"), 1, resident_top, resident_bottom, "silas-idle-0")
paste_card(commons_frame("hazel-idle-0"), 2, resident_top, resident_bottom, "hazel-idle-0")
portrait_top = resident_top + 354
portrait_bottom = portrait_top + 72
paste_card(Image.open(FRAMES / "portrait-pell.png").convert("RGBA"), 0, portrait_top, portrait_bottom, "portrait-pell")
paste_card(portrait_frame("portrait-mara"), 1, portrait_top, portrait_bottom, "portrait-mara")
paste_card(portrait_frame("portrait-orrin"), 2, portrait_top, portrait_bottom, "portrait-orrin")
board.save(ROOT / "compare-kit.png")

print(f"built {len(manifest_frames)} frames and {len(animations)} animations")
