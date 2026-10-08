"""Cut every source frame to its measured rect, remove tiny edge fragments,
and store it independently so neighbouring sheet art cannot leak into it.
Run after build_round2_frames.mjs and before npm run atlases.
"""
from collections import deque
from pathlib import Path
import json
from PIL import Image

ROOT = Path(__file__).resolve().parent
SHEETS = ROOT / 'sheets'
OUT = SHEETS / 'edge-clean'
OUT.mkdir(parents=True, exist_ok=True)
manifest_path = ROOT / 'manifest.json'
atlas_path = ROOT / 'atlas.json'
manifest = json.loads(manifest_path.read_text())
atlas = json.loads(atlas_path.read_text())
sources = {s['key']: Image.open(SHEETS / s['file']).convert('RGBA') for s in manifest['sources']}
removed = []

for frame in manifest['frames']:
    rect = frame['sourceRect']
    source = sources[frame['source']]
    image = source.crop((rect['x'], rect['y'], rect['x'] + rect['w'], rect['y'] + rect['h']))
    width, height = image.size
    alpha = image.getchannel('A').tobytes()
    seen = bytearray(width * height)
    erase = []
    total_opaque = sum(a >= 128 for a in alpha)
    max_fragment = min(500, max(40, int(total_opaque * .012)))

    # Flood only alpha-connected components that touch the crop edge. Large
    # edge-connected silhouettes are retained; tiny disconnected neighbors
    # are cleared. Eight-way connectivity preserves normal pixel outlines.
    for y in range(height):
        for x in range(width):
            i = y * width + x
            if seen[i] or alpha[i] < 128 or not (x < 3 or y < 3 or x >= width - 3 or y >= height - 3):
                continue
            queue = [i]
            seen[i] = 1
            component = []
            for index in queue:
                px, py = index % width, index // width
                component.append(index)
                for ny in range(max(0, py - 1), min(height, py + 2)):
                    row = ny * width
                    for nx in range(max(0, px - 1), min(width, px + 2)):
                        neighbor = row + nx
                        if not seen[neighbor] and alpha[neighbor] >= 128:
                            seen[neighbor] = 1
                            queue.append(neighbor)
            if len(component) <= max_fragment:
                erase.extend(component)

    if erase:
        pix = image.load()
        for index in erase:
            pix[index % width, index // width] = (0, 0, 0, 0)
        removed.append((frame['key'], len(erase)))
        image.save(OUT / f"{frame['key']}.png")
        source_key = f"edge-clean-{frame['key']}"
        frame['source'] = source_key
        frame['sourceRect'] = {'x': 0, 'y': 0, 'w': width, 'h': height}
        manifest['sources'].append({'key': source_key, 'file': f"edge-clean/{frame['key']}.png"})
        atlas['frames'][frame['key']]['filename'] = source_key
        atlas['frames'][frame['key']]['frame'] = frame['sourceRect']
        atlas['frames'][frame['key']]['spriteSourceSize'] = {'x': 0, 'y': 0, 'w': width, 'h': height}
        atlas['frames'][frame['key']]['sourceSize'] = {'w': width, 'h': height}

manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
atlas_path.write_text(json.dumps(atlas, indent=2) + '\n')
print(f"edge audit: {len(manifest['frames'])} frames checked; cleaned {len(removed)} small edge fragments")
for key, count in removed:
    print(f"  {key}: cleared {count} alpha pixels")
(ROOT / 'edge-audit.json').write_text(json.dumps({
    'framesChecked': len(manifest['frames']),
    'framesWithPriorEdgeCleanup': [f['key'] for f in manifest['frames'] if f['source'].startswith('edge-clean-')],
    'remainingSmallEdgeFragments': [key for key, _ in removed],
}, indent=2) + '\n')
