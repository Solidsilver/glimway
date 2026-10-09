#!/usr/bin/env python3
"""Compile the three 0.4 art-gap jobs into the indoors manifest and atlas."""
import json
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).parent
SHEETS = ROOT / "sheets"
JOBS = json.loads((ROOT / "gaps-jobs.json").read_text())
manifest_path = ROOT / "manifest.json"
atlas_path = ROOT / "atlas.json"
manifest = json.loads(manifest_path.read_text())
atlas = json.loads(atlas_path.read_text())

# Rebuild these jobs from their source panels every time. Retire the earlier
# one-frame seated composite so the desk catalogue has one active resident state.
replacement_keys = {job["key"] for job in JOBS["jobs"]}
retired_key = "library-elara-desk-front-seated"
manifest["frames"] = [f for f in manifest["frames"] if f["key"] not in replacement_keys | {retired_key}]
manifest["furnishings"] = [f for f in manifest.get("furnishings", []) if f["frame"] not in replacement_keys | {retired_key}]
manifest["animations"] = [a for a in manifest.get("animations", []) if a["key"] not in {"loft-hoist-working", "library-elara-writing"}]
atlas["frames"].pop(retired_key, None)
manifest["sources"] = [s for s in manifest["sources"] if s["key"] not in {f"gaps-{key}" for key in replacement_keys}]
atlas["sources"] = [s for s in atlas["sources"] if not s["key"].startswith("gaps-")]

for job in JOBS["jobs"]:
    source_path = SHEETS / JOBS["sources"][job["source"]]
    source = Image.open(source_path).convert("RGBA")
    x, y, w, h = job["crop"]
    panel = source.crop((x, y, x + w, y + h))
    if job.get("alphaThreshold") is not None:
        threshold = job["alphaThreshold"]
        panel.putalpha(panel.getchannel("A").point(lambda value: 255 if value >= threshold else 0))
    if "blendBase" in job:
        base = Image.open(SHEETS / job["blendBase"]).convert("RGBA")
        panel = panel.resize(base.size, Image.Resampling.BOX)
        mask = Image.new("L", base.size, 0)
        ImageDraw.Draw(mask).polygon([tuple(point) for point in job["blendMask"]], fill=255)
        composited = base.copy()
        composited.paste(panel, (0, 0), mask)
        panel = composited
    alpha = panel.getchannel("A")
    bounds = alpha.getbbox()
    if not bounds:
        raise ValueError(f"{job['key']}: generated panel has no alpha")
    if not job.get("preservePanel"):
        panel = panel.crop(bounds)
    if "panelSize" in job:
        padded_panel = Image.new("RGBA", tuple(job["panelSize"]), (0, 0, 0, 0))
        padded_panel.alpha_composite(panel, (0, 0))
        panel = padded_panel
    if job.get("noBorder"):
        cropped = panel
    else:
        cropped = Image.new("RGBA", (panel.width + 8, panel.height + 8), (0, 0, 0, 0))
        cropped.alpha_composite(panel, (4, 4))
    filename = f"{job['key']}.png"
    crop_path = SHEETS / "gaps-crops" / filename
    crop_path.parent.mkdir(parents=True, exist_ok=True)
    cropped.save(crop_path)

    cw, ch = job["canvas"]
    dx, dy, box_w, box_h = job["destination"]
    scale = min(box_w / cropped.width, box_h / cropped.height)
    dw, dh = max(1, round(cropped.width * scale)), max(1, round(cropped.height * scale))
    dest = {"x": dx + (box_w - dw) // 2, "y": dy + box_h - dh, "w": dw, "h": dh}
    source_key = f"gaps-{job['key']}"
    frame = {
        "key": job["key"],
        "source": source_key,
        "sourceRect": {"x": 0, "y": 0, "w": cropped.width, "h": cropped.height},
        "canvasSize": {"w": cw, "h": ch},
        "destinationRect": dest,
        "footprint": job["footprint"],
        "footPoint": {"x": cw // 2, "y": ch},
        "origin": [0.5, 1],
        "role": "prop",
        "furnishing": {
            "id": job["id"], "facing": job["facing"], "state": job["state"],
            "footprint": job["footprint"], "base": job["base"], "size": job["size"],
            "mount": job["mount"],
            **({"offers": job["offers"]} if "offers" in job else {}),
            "tags": job["tags"],
            **({"loop": job["loop"]} if "loop" in job else {}),
        },
    }
    manifest["sources"].append({"key": source_key, "file": f"gaps-crops/{filename}"})
    manifest["frames"].append(frame)
    atlas["sources"].append({"key": source_key, "file": f"sheets/gaps-crops/{filename}"})
    atlas["frames"][job["key"]] = {
        "filename": source_key,
        "frame": frame["sourceRect"],
        "rotated": False,
        "trimmed": True,
        "spriteSourceSize": {"x": 0, "y": 0, "w": cropped.width, "h": cropped.height},
        "sourceSize": {"w": cropped.width, "h": cropped.height},
    }
    manifest["furnishings"].append({
        "frame": job["key"], "id": job["id"], "facing": job["facing"], "state": job["state"],
        "footprint": job["footprint"], "base": job["base"], "size": job["size"], "mount": job["mount"],
        **({"offers": job["offers"]} if "offers" in job else {}),
        "tags": job["tags"],
        **({"loop": job["loop"]} if "loop" in job else {}),
    })

for animation in [
    {"key": "loft-hoist-working", "frames": [f"loft-hoist-front-working-{i}" for i in range(4)], "frameRate": 2, "loop": True},
    {"key": "library-elara-writing", "frames": [f"library-elara-desk-front-writing-{i}" for i in range(2)], "frameRate": 1.5, "loop": True},
]:
    manifest["animations"].append(animation)

# Refresh the furnishing catalogue from its frame rows, preserving the original id and density.
pieces = {}
for item in manifest["furnishings"]:
    piece = pieces.setdefault(item["id"], {
        "id": item["id"], "footprint": item["footprint"], "base": item["base"], "size": item["size"],
        "mount": item["mount"], "facings": {}, "states": {}, "tags": [],
    })
    if "offers" in item:
        piece["offers"] = item["offers"]
    facing = piece["facings"].setdefault(item["facing"], {})
    facing.setdefault(item["state"], []).append(item["frame"])
    state = piece["states"].setdefault(item["state"], {"frames": []})
    state["frames"].append(item["frame"])
    if "loop" in item:
        state["loop"] = item["loop"]
    for tag in item.get("tags", []):
        if tag not in piece["tags"]:
            piece["tags"].append(tag)
catalogue = json.loads((ROOT / "furnishings.json").read_text())
catalogue["pieces"] = list(pieces.values())
(ROOT / "furnishings.json").write_text(json.dumps(catalogue, indent=2) + "\n")
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
atlas_path.write_text(json.dumps(atlas, indent=2) + "\n")
print(f"built {len(JOBS['jobs'])} frames; {len(manifest['frames'])} total frames")
