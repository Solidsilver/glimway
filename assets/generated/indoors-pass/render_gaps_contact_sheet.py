#!/usr/bin/env python3
"""Render the seven gap frames beside their existing states at 1x and 3x."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent
REPO = ROOT.parents[2]
OUT = REPO / ".agent" / "screens" / "gaps.png"
manifest = json.loads((ROOT / "manifest.json").read_text())
by_key = {frame["key"]: frame for frame in manifest["frames"]}
sources = {source["key"]: ROOT / "sheets" / source["file"] for source in manifest["sources"]}

groups = [
    ("Hazel's washtub", ["kitchen-washtub-front-default", "kitchen-washtub-front-risen"]),
    ("Finn's loft hoist", ["loft-hoist-front-default"] + [f"loft-hoist-front-working-{i}" for i in range(4)]),
    ("Elara at her desk", ["library-elara-desk-front-empty"] + [f"library-elara-desk-front-writing-{i}" for i in range(2)]),
]

def frame_canvas(key):
    frame = by_key[key]
    sw, sh = frame["sourceRect"]["w"], frame["sourceRect"]["h"]
    rect = frame["sourceRect"]
    source = Image.open(sources[frame["source"]]).convert("RGBA")
    art = source.crop((rect["x"], rect["y"], rect["x"] + sw, rect["y"] + sh))
    dest = frame["destinationRect"]
    w, h = frame["canvasSize"]["w"], frame["canvasSize"]["h"]
    art = art.resize((dest["w"], dest["h"]), Image.Resampling.BOX)
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.alpha_composite(art, (dest["x"], dest["y"]))
    return canvas

def checker(size, scale):
    w, h = size
    im = Image.new("RGB", (w * scale, h * scale), (238, 230, 210))
    d = ImageDraw.Draw(im)
    step = 8 * scale
    for y in range(0, im.height, step):
        for x in range(0, im.width, step):
            if ((x // step) + (y // step)) % 2:
                d.rectangle((x, y, x + step - 1, y + step - 1), fill=(226, 216, 194))
    return im

def composite(canvas, scale):
    if scale == 1:
        sprite = canvas
    else:
        sprite = canvas.resize((canvas.width * scale, canvas.height * scale), Image.Resampling.NEAREST)
    bg = checker(canvas.size, scale).convert("RGBA")
    bg.alpha_composite(sprite)
    return bg.convert("RGB")

font = ImageFont.load_default()
margin, gap, title_h, label_h, scale_gap = 24, 14, 28, 18, 18
section_images = []
for title, keys in groups:
    canvases = [frame_canvas(key) for key in keys]
    row_sizes = []
    for scale in (1, 3):
        cells = []
        for key, canvas in zip(keys, canvases):
            img = composite(canvas, scale)
            cell = Image.new("RGB", (max(img.width, 82), label_h + img.height), (248, 244, 232))
            draw = ImageDraw.Draw(cell)
            label = key.replace("library-elara-desk-front-", "").replace("kitchen-washtub-front-", "").replace("loft-hoist-front-", "")
            draw.text((2, 2), label, fill=(50, 43, 35), font=font)
            cell.paste(img, ((cell.width - img.width) // 2, label_h))
            cells.append(cell)
        row_w = sum(cell.width for cell in cells) + gap * (len(cells) - 1)
        row_h = max(cell.height for cell in cells)
        row = Image.new("RGB", (row_w, row_h + 22), (248, 244, 232))
        draw = ImageDraw.Draw(row)
        draw.text((0, 3), f"{scale}×", fill=(70, 57, 42), font=font)
        x = 0
        for cell in cells:
            row.paste(cell, (x, 20))
            x += cell.width + gap
        row_sizes.append(row)
    section_w = max(im.width for im in row_sizes)
    section_h = title_h + row_sizes[0].height + scale_gap + row_sizes[1].height
    section = Image.new("RGB", (section_w, section_h), (248, 244, 232))
    draw = ImageDraw.Draw(section)
    draw.text((0, 4), title, fill=(47, 41, 33), font=font)
    y = title_h
    for row in row_sizes:
        section.paste(row, (0, y))
        y += row.height + scale_gap
    section_images.append(section)

width = max(im.width for im in section_images) + margin * 2
height = margin + sum(im.height for im in section_images) + gap * (len(section_images) - 1) + margin
sheet = Image.new("RGB", (width, height), (248, 244, 232))
y = margin
for section in section_images:
    sheet.paste(section, (margin, y))
    y += section.height + gap
OUT.parent.mkdir(parents=True, exist_ok=True)
sheet.save(OUT)
print(f"wrote {OUT} ({sheet.width}×{sheet.height})")
