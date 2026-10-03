"""Inspect the generated PNGs and write Phaser metadata; never modify artwork."""
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent


def write_json(name, data):
    (ROOT / name).write_text(json.dumps(data, indent=2) + "\n")


def atlas(filename, columns, rows, names, align=False, regions=None):
    image = Image.open(ROOT / filename)
    assert image.mode == "RGBA", (filename, "Expected real alpha transparency")
    assert image.getchannel("A").getextrema() == (0, 255)
    width, height = image.size
    frames = {}
    bounds = []
    for index, name in enumerate(names):
        row, col = divmod(index, columns)
        x0, x1 = round(col * width / columns), round((col + 1) * width / columns)
        y0, y1 = round(row * height / rows), round((row + 1) * height / rows)
        if regions:
            x0, y0, x1, y1 = regions[index]
        # Ignore low-opacity fringes when measuring the primary silhouette.
        alpha = image.getchannel("A").crop((x0, y0, x1, y1))
        bbox = alpha.point(lambda value: 255 if value > 64 else 0).getbbox()
        assert bbox, (filename, name, "Empty frame")
        left, top, right, bottom = bbox
        left, top = max(0, left - 1), max(0, top - 1)
        right, bottom = min(x1 - x0, right + 1), min(y1 - y0, bottom + 1)
        bounds.append((name, x0 + left, y0 + top, right - left, bottom - top))
    source_width = max(b[3] for b in bounds) + 4
    source_height = max(b[4] for b in bounds) + 4
    for name, x, y, w, h in bounds:
        frames[name] = {
            "frame": {"x": x, "y": y, "w": w, "h": h},
            "rotated": False,
            "trimmed": align,
            "spriteSourceSize": {
                "x": (source_width - w) // 2 if align else 0,
                "y": source_height - h - 2 if align else 0,
                "w": w,
                "h": h,
            },
            "sourceSize": {"w": source_width if align else w, "h": source_height if align else h},
            "pivot": {"x": 0.5, "y": 1},
        }
    data = {"frames": frames, "meta": {"app": "Fingersnap", "version": "1", "image": filename,
            "format": "RGBA8888", "size": {"w": width, "h": height}, "scale": "1"}}
    write_json(filename.replace(".png", ".atlas.json"), data)
    return data


def main():
    foreground_names = ["oak-canopy", "pine-canopy", "leafy-arch", "cottage-roof", "stone-arch", "fern-cluster"]
    hero_names = [f"walk-{direction}-{frame}" for direction in ("down", "left", "right", "up") for frame in range(4)]
    enemy_names = [f"{species}-{pose}" for species in ("slime", "mushroom", "beetle")
                   for pose in ("idle", "squash", "windup", "hurt")]
    # Generation placed the six silhouettes unevenly; reviewed gutters replace
    # a nominal grid so no canopy/roof is clipped by a column boundary.
    foreground_regions = [(0, 0, 454, 640), (454, 0, 821, 640), (821, 0, 1254, 640),
                          (0, 640, 437, 1254), (437, 640, 833, 1254), (833, 640, 1254, 1254)]
    atlas("fingersnap-foreground.png", 3, 2, foreground_names, regions=foreground_regions)
    atlas("fingersnap-demo-walk.png", 4, 4, hero_names, align=True)
    atlas("fingersnap-enemies.png", 4, 3, enemy_names, align=True)
    terrain = Image.open(ROOT / "fingersnap-terrain.png")
    terrain_names = ["grass", "flower-grass", "forest-moss", "packed-dirt", "cobblestone", "mossy-cobblestone",
                     "shrine-stone", "cave-gravel", "pond-water", "shallow-water", "wood-planks", "dark-wood-planks",
                     "path-vertical", "path-horizontal", "path-crossroads", "path-t-junction"]
    terrain_frames = {}
    for index, name in enumerate(terrain_names):
        row, col = divmod(index, 4)
        x, right = round(col * terrain.width / 4), round((col + 1) * terrain.width / 4)
        y, bottom = round(row * terrain.height / 4), round((row + 1) * terrain.height / 4)
        w, h = right - x, bottom - y
        terrain_frames[name] = {"frame": {"x": x, "y": y, "w": w, "h": h}, "rotated": False,
                               "trimmed": False, "spriteSourceSize": {"x": 0, "y": 0, "w": w, "h": h},
                               "sourceSize": {"w": w, "h": h}}
    write_json("fingersnap-terrain.atlas.json", {"frames": terrain_frames, "meta": {
        "app": "Fingersnap", "image": "fingersnap-terrain.png", "size": {"w": terrain.width, "h": terrain.height}}})
    tile_width = tile_height = 32
    animations = []
    for direction in ("down", "left", "right", "up"):
        animations.append({"key": f"demo-walk-{direction}", "texture": "fingersnap-demo-walk",
                           "frames": [f"walk-{direction}-{i}" for i in range(4)], "frameRate": 6, "repeat": -1})
    for species in ("slime", "mushroom", "beetle"):
        animations.append({"key": f"{species}-idle", "texture": "fingersnap-enemies",
                           "frames": [f"{species}-idle", f"{species}-squash", f"{species}-idle"], "frameRate": 4, "repeat": -1})
    write_json("animations.json", animations)
    manifest = {"version": 1, "baseUrl": "/assets/fingersnap/expansion/", "terrain": {
        "texture": "fingersnap-terrain", "image": "fingersnap-terrain.png", "data": "fingersnap-terrain.atlas.json",
        "runtimeTexture": "fingersnap-terrain-runtime", "note": "Use integration.js to normalize unequal source cells into a uniform runtime tileset.",
        "tileWidth": tile_width, "tileHeight": tile_height, "tiles": dict(enumerate(terrain_names))},
        "atlases": [{"key": key, "texture": key + ".png", "data": key + ".atlas.json"} for key in
                    ("fingersnap-foreground", "fingersnap-demo-walk", "fingersnap-enemies")],
        "animations": "animations.json", "suggestedWorldTileSize": 32, "suggestedCharacterHeight": 40,
        "foregroundFrames": foreground_names, "characterFrames": hero_names, "enemyFrames": enemy_names}
    write_json("manifest.json", manifest)
    print(f"Created 3 atlases: {len(foreground_names)} foreground, {len(hero_names)} character, {len(enemy_names)} enemy frames; 16 terrain definitions.")


if __name__ == "__main__":
    main()
