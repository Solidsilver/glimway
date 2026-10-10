#!/usr/bin/env python3
"""Rebuild glim-pass frames and metadata from the preserved generated source images."""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent
FRAMES = ROOT / "frames"
FRAMES.mkdir(exist_ok=True)

PIECES = [
    {
        "key": "glim",
        "source": "glim-64-source.png",
        "canvas": (64, 64),
        "notes": "Single round faceted amber bead with bright warm core and small glint",
    },
    {
        "key": "glim-hud",
        "source": "glim-hud-source.png",
        "canvas": (32, 32),
        "notes": "Simplified HUD bead, reviewed at an 8x8 game-pixel display size",
    },
    {
        "key": "glims-few",
        "source": "glims-few-source.png",
        "canvas": (64, 64),
        "notes": "Exactly three amber beads grouped together for log, letters and toast",
    },
]


def normalize(source: Image.Image, canvas: tuple[int, int]) -> tuple[Image.Image, tuple[int, int, int, int]]:
    """Trim transparent source margin and fit the art inside a 4-texel gutter."""
    rgba = source.convert("RGBA")
    # Generated sources carry true alpha; threshold faint edge noise to keep frame edges crisp.
    alpha = rgba.getchannel("A").point(lambda value: 255 if value >= 96 else 0)
    box = alpha.getbbox()
    if box is None:
        raise RuntimeError("source image has no visible pixels")
    crop = rgba.crop(box)
    crop.putalpha(alpha.crop(box))
    w, h = canvas
    scale = min((w - 8) / crop.width, (h - 8) / crop.height)
    size = (max(1, round(crop.width * scale)), max(1, round(crop.height * scale)))
    crop = crop.resize(size, Image.Resampling.NEAREST)
    frame = Image.new("RGBA", canvas, (0, 0, 0, 0))
    frame.alpha_composite(crop, ((w - crop.width) // 2, (h - crop.height) // 2))
    validate_frame(frame, canvas)
    return frame, box


def validate_frame(frame: Image.Image, canvas: tuple[int, int]) -> None:
    if frame.size != canvas or frame.mode != "RGBA":
        raise RuntimeError(f"expected RGBA frame {canvas}, got {frame.mode} {frame.size}")
    alpha = frame.getchannel("A")
    if alpha.getextrema()[0] != 0:
        raise RuntimeError("frame background is not transparent")
    box = alpha.getbbox()
    if box is None:
        raise RuntimeError("normalized frame is empty")
    left, top, right, bottom = box
    w, h = canvas
    if min(left, top, w - right, h - bottom) < 4:
        raise RuntimeError(f"frame does not retain its 4-texel gutter: {box} in {canvas}")


def make_contact_sheet() -> None:
    """Show all canvases over a review-only checker and the HUD icon at 8x8 game pixels."""
    cell_w, cell_h = 192, 160
    contact = Image.new("RGBA", (cell_w * len(PIECES), cell_h), (91, 79, 65, 255))
    draw = ImageDraw.Draw(contact)
    font = ImageFont.load_default()
    for index, piece in enumerate(PIECES):
        x = index * cell_w
        frame = Image.open(FRAMES / f"{piece['key']}.png").convert("RGBA")
        w, h = piece["canvas"]
        backing = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        checker = ImageDraw.Draw(backing)
        for yy in range(0, h, 4):
            for xx in range(0, w, 4):
                if (xx // 4 + yy // 4) % 2 == 0:
                    checker.rectangle((xx, yy, xx + 3, yy + 3), fill=(182, 174, 160, 255))
        backing.alpha_composite(frame)
        scale = 2 if w == 64 else 3
        shown = backing.resize((w * scale, h * scale), Image.Resampling.NEAREST)
        contact.alpha_composite(shown, (x + 8, 8))
        draw.text((x + 8, 8 + shown.height + 4), piece["key"], font=font, fill=(255, 250, 236, 255))
        if piece["key"] == "glim-hud":
            tiny = frame.resize((8, 8), Image.Resampling.NEAREST)
            contact.alpha_composite(tiny.resize((24, 24), Image.Resampling.NEAREST), (x + 112, 8))
            draw.text((x + 112, 36), "8px HUD", font=font, fill=(255, 250, 236, 255))
    contact.convert("RGB").save(ROOT / "contact-sheet.png")


def main() -> None:
    sources: dict[str, dict[str, object]] = {}
    frames: dict[str, dict[str, object]] = {}
    for piece in PIECES:
        source_name = piece["source"]
        source_path = ROOT / "sheets" / source_name
        source = Image.open(source_path).convert("RGBA")
        frame, crop = normalize(source, piece["canvas"])
        frame_file = f"frames/{piece['key']}.png"
        frame.save(ROOT / frame_file)
        if source_name not in sources:
            sources[source_name] = {
                "file": f"sheets/{source_name}",
                "width": source.width,
                "height": source.height,
            }
        cw, ch = piece["canvas"]
        frames[piece["key"]] = {
            "source": source_name,
            "sourceRect": {"x": crop[0], "y": crop[1], "w": crop[2] - crop[0], "h": crop[3] - crop[1]},
            "file": frame_file,
            "canvasSize": {"w": cw, "h": ch},
            "footprint": None,
            "footPoint": {"x": cw // 2, "y": ch // 2},
            "alpha": True,
            "gutter": 4,
            "anchor": "center",
        }

    manifest = {
        "density": {"texelsPerTile": 64, "worldTilePx": 16},
        "sources": sources,
        "frames": frames,
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    atlas = {
        "sources": sources,
        "frames": {
            key: {"source": value["source"], "rect": value["sourceRect"], "file": value["file"], "canvasSize": value["canvasSize"]}
            for key, value in frames.items()
        },
        "groups": {"glims-pass": {"frames": list(frames), "frameSize": "per-frame canvas in manifest"}},
    }
    (ROOT / "atlas.json").write_text(json.dumps(atlas, indent=2) + "\n")
    make_contact_sheet()


if __name__ == "__main__":
    main()
