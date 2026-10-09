#!/usr/bin/env python3
"""Build one-shelf library plaques from the original, transparent plaque art."""
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).parent
SHEETS = ROOT / "sheets"
JOBS = json.loads((ROOT / "small-signs-jobs.json").read_text())
manifest_path = ROOT / "manifest.json"
atlas_path = ROOT / "atlas.json"
content_furnishings_path = ROOT.parent.parent / ".." / "content" / "furnishings.json"

manifest = json.loads(manifest_path.read_text())
atlas = json.loads(atlas_path.read_text())
catalogue = json.loads((ROOT / "furnishings.json").read_text())

source_dir = SHEETS / JOBS["outputDirectory"].removeprefix("sheets/")
source_dir.mkdir(parents=True, exist_ok=True)
keys = {frame["key"] for frame in JOBS["frames"]}
manifest["sources"] = [s for s in manifest["sources"] if not s["key"].startswith("small-sign-")]
manifest["frames"] = [f for f in manifest["frames"] if f["key"] not in keys]
manifest["furnishings"] = [f for f in manifest["furnishings"] if f["frame"] not in keys]
atlas["sources"] = [s for s in atlas["sources"] if not s["key"].startswith("small-sign-")]
for key in keys:
    atlas["frames"].pop(key, None)
catalogue["pieces"] = [p for p in catalogue["pieces"] if p["id"] not in {f"library-section-sign-{name}" for name in ("stories", "histories", "recipes", "field-notes")}]

for row in JOBS["frames"]:
    source_path = SHEETS / "round2-crops" / row["source"]
    image = Image.open(source_path).convert("RGBA")
    reduced = image.resize(tuple(JOBS["canvas"]), Image.Resampling.NEAREST)
    out_file = f"{row['key']}.png"
    reduced.save(source_dir / out_file)

    source_key = f"small-sign-{row['key'].removeprefix('library-section-sign-front-')}"
    frame_rect = {"x": 0, "y": 0, "w": reduced.width, "h": reduced.height}
    frame = {
        "key": row["key"], "source": source_key,
        "sourceRect": frame_rect,
        "canvasSize": {"w": JOBS["frameCanvas"][0], "h": JOBS["frameCanvas"][1]},
        "destinationRect": {"x": JOBS["placement"][0], "y": JOBS["placement"][1], "w": JOBS["placement"][2], "h": JOBS["placement"][3]},
        "footprint": [2, 1], "footPoint": {"x": 64, "y": 48}, "origin": [0.5, 1], "role": "prop",
        "furnishing": {"id": f"library-section-sign-{row['key'].removeprefix('library-section-sign-front-')}", "facing": "front", "state": "default", "footprint": [2, 1], "base": [0, 0, 2, 1], "size": "small", "mount": "wall", "tags": [f"section:{row['key'].removeprefix('library-section-sign-front-')}"]},
    }
    manifest["sources"].append({"key": source_key, "file": f"section-signs-small/{out_file}"})
    manifest["frames"].append(frame)
    manifest["furnishings"].append({"frame": row["key"], **frame["furnishing"]})
    atlas["sources"].append({"key": source_key, "file": f"sheets/section-signs-small/{out_file}"})
    atlas["frames"][row["key"]] = {
        "filename": source_key, "frame": frame_rect, "rotated": False, "trimmed": False,
        "spriteSourceSize": frame_rect, "sourceSize": {"w": reduced.width, "h": reduced.height},
    }
    catalogue["pieces"].append({
        "id": frame["furnishing"]["id"], "footprint": [2, 1], "base": [0, 0, 2, 1], "size": "small", "mount": "wall",
        "facings": {"front": {"default": [row["key"]]}}, "states": {"default": {"frames": [row["key"]]}}, "tags": frame["furnishing"]["tags"],
    })

manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
atlas_path.write_text(json.dumps(atlas, indent=2) + "\n")
(ROOT / "furnishings.json").write_text(json.dumps(catalogue, indent=2) + "\n")
print(f"built {len(JOBS['frames'])} plaques at {JOBS['canvas'][0]}×{JOBS['canvas'][1]} pixels")
