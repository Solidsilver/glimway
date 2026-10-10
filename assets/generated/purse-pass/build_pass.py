#!/usr/bin/env python3
"""Rebuild the purse-pass frames, metadata, and contact sheet from preserved sheets."""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent
SHEET = "purse-icons.png"
SRC = ROOT / "sheets" / SHEET
FRAMES = ROOT / "frames"
FRAMES.mkdir(exist_ok=True)

# Equal source cells in the generated 3x2 sheet. The last cell is intentionally empty.
PIECES = [
    ("gold-coin", (0, 0, 512, 512), (64, 64), "Glimway's single lamp-stamped brass coin"),
    ("gold-coin-hud", (0, 0, 512, 512), (32, 32), "Simplified-size HUD version of the same coin"),
    ("purse", (512, 0, 1024, 512), (64, 64), "Drawstring leather purse with coin at the mouth"),
    ("wardrobe", (1024, 0, 1536, 512), (64, 64), "Coat and hat on a peg rail"),
    ("price-tag", (0, 512, 512, 1024), (32, 32), "Blank paper shelf tag on a string"),
    ("gold-letter", (512, 512, 1024, 1024), (64, 64), "Folded letter with a coin pressed into its wax seal"),
]


def normalize(sheet: Image.Image, roi: tuple[int, int, int, int], canvas: tuple[int, int]) -> Image.Image:
    crop = sheet.crop(roi).convert("RGBA")
    # Keep the generator's true transparent background and discard faint edge noise.
    alpha = crop.getchannel("A").point(lambda a: 255 if a >= 96 else 0)
    crop.putalpha(alpha)
    box = alpha.getbbox()
    if box is None:
        raise RuntimeError(f"empty crop: {roi}")
    crop = crop.crop(box)
    w, h = canvas
    # Native nearest-neighbour resampling preserves the stepped silhouette.
    scale = min((w - 8) / crop.width, (h - 8) / crop.height)
    size = (max(1, round(crop.width * scale)), max(1, round(crop.height * scale)))
    crop = crop.resize(size, Image.Resampling.NEAREST)
    out = Image.new("RGBA", canvas, (0, 0, 0, 0))
    out.alpha_composite(crop, ((w - crop.width) // 2, (h - crop.height) // 2))
    return out


def main() -> None:
    sheet = Image.open(SRC).convert("RGBA")
    if sheet.size != (1536, 1024):
        raise RuntimeError(f"expected 1536x1024 source sheet, got {sheet.size}")
    sources = {SHEET: {"file": f"sheets/{SHEET}", "width": sheet.width, "height": sheet.height}}
    frames = {}
    for key, roi, canvas, _notes in PIECES:
        image = normalize(sheet, roi, canvas)
        filename = f"frames/{key}.png"
        image.save(ROOT / filename)
        frames[key] = {
            "source": SHEET,
            "sourceRect": {"x": roi[0], "y": roi[1], "w": roi[2] - roi[0], "h": roi[3] - roi[1]},
            "file": filename,
            "canvasSize": {"w": canvas[0], "h": canvas[1]},
            "footprint": None,
            "footPoint": {"x": canvas[0] // 2, "y": canvas[1] // 2},
            "alpha": True,
            "gutter": 4,
            "anchor": "center",
        }
    manifest = {"density": {"texelsPerTile": 64, "worldTilePx": 16}, "sources": sources, "frames": frames}
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    atlas = {
        "sources": sources,
        "frames": {key: {"source": v["source"], "rect": v["sourceRect"], "file": v["file"], "canvasSize": v["canvasSize"]} for key, v in frames.items()},
        "groups": {"purse-pass": {"frames": list(frames), "frameSize": "per-frame canvas in manifest"}},
    }
    (ROOT / "atlas.json").write_text(json.dumps(atlas, indent=2) + "\n")
    # Real-size review strip: each icon is shown at its actual texel canvas.
    # The 32px coin additionally appears at the 8 game-pixel HUD display size.
    cell_w, cell_h = 192, 160
    contact = Image.new("RGBA", (cell_w * 3, cell_h * 2), (91, 79, 65, 255))
    draw = ImageDraw.Draw(contact)
    font = ImageFont.load_default()
    for index, (key, _roi, canvas, note) in enumerate(PIECES):
        x, y = (index % 3) * cell_w, (index // 3) * cell_h
        im = Image.open(ROOT / f"frames/{key}.png").convert("RGBA")
        # Checker backing is only in this review image, never in frame assets.
        tile = Image.new("RGBA", canvas, (0, 0, 0, 0))
        d = ImageDraw.Draw(tile)
        for yy in range(0, canvas[1], 4):
            for xx in range(0, canvas[0], 4):
                if (xx // 4 + yy // 4) % 2 == 0:
                    d.rectangle((xx, yy, xx + 3, yy + 3), fill=(182, 174, 160, 255))
        tile.alpha_composite(im)
        scale = 2 if canvas == (64, 64) else 3
        shown = tile.resize((canvas[0] * scale, canvas[1] * scale), Image.Resampling.NEAREST)
        contact.alpha_composite(shown, (x + 8, y + 8))
        label_y = y + 8 + shown.height + 4
        draw.text((x + 8, min(label_y, y + 104)), key, font=font, fill=(255, 250, 236, 255))
        if key == "gold-coin-hud":
            tiny = im.resize((8, 8), Image.Resampling.NEAREST)
            contact.alpha_composite(tiny.resize((24, 24), Image.Resampling.NEAREST), (x + 112, y + 8))
            draw.text((x + 112, y + 36), "8px HUD", font=font, fill=(255, 250, 236, 255))
    contact.convert("RGB").save(ROOT / "contact-sheet.png")


if __name__ == "__main__":
    main()
