"""Measure sprite bounds and write runtime metadata without changing PNGs."""
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent


def measure(file, regions):
    image = Image.open(ROOT / file)
    assert image.mode == 'RGBA'
    assert image.getchannel('A').getextrema()[0] == 0
    result = []
    for name, region in regions:
        x0, y0, x1, y1 = region
        bounds = image.getchannel('A').crop(region).point(lambda a: 255 if a > 64 else 0).getbbox()
        assert bounds, (file, name)
        left, top, right, bottom = bounds
        left, top = max(0, left-1), max(0, top-1)
        right, bottom = min(x1-x0, right+1), min(y1-y0, bottom+1)
        result.append((name, {'x': x0+left, 'y': y0+top, 'w': right-left, 'h': bottom-top}))
    return result


def main():
    frames, animations = [], []
    npc_regions = []
    for name, top, bottom in [('mara', 0, 580), ('pip', 580, 1020), ('orrin', 1020, 1535)]:
        for i in range(2):
            npc_regions.append((f'{name}-idle-{i}', (i*512, top, (i+1)*512, bottom)))
    npc_bounds = measure('fingersnap-npcs.png', npc_regions)
    # One scale for all residents preserves the child's shorter stature.
    npc_scale = min(14/max(r['w'] for _, r in npc_bounds), 15/max(r['h'] for _, r in npc_bounds))
    guardian_regions = [
        ('guardian-idle', (0, 0, 512, 512)), ('guardian-windup', (512, 0, 1000, 512)),
        ('guardian-lunge', (1000, 0, 1536, 512)), ('guardian-hurt', (0, 512, 480, 1024)),
        ('guardian-defeat', (480, 512, 1024, 1024)),
    ]
    guardian_bounds = measure('fingersnap-guardian.png', guardian_regions)
    guardian_scale = min(24/max(r['w'] for _, r in guardian_bounds), 23/max(r['h'] for _, r in guardian_bounds))
    for source, bounds, size, scale in [('fingersnap-npcs', npc_bounds, 16, npc_scale),
                                         ('fingersnap-guardian', guardian_bounds, 24, guardian_scale)]:
        for name, rect in bounds:
            w, h = max(1, round(rect['w']*scale)), max(1, round(rect['h']*scale))
            frames.append({'key': name, 'source': source, 'sourceRect': rect, 'width': size, 'height': size,
                           'destinationRect': {'x': (size-w)//2, 'y': size-h, 'w': w, 'h': h},
                           'origin': [0.5, 1], 'role': 'npc' if size == 16 else 'guardian'})
    effects = Image.open(ROOT / 'fingersnap-class-effects.png')
    for row, (name, size) in enumerate([('cleave', 18), ('magic-bolt', 8), ('dash-trail', 18), ('healing-pulse', 32)]):
        for col in range(4):
            x, right = round(col*effects.width/4), round((col+1)*effects.width/4)
            y, bottom = round(row*effects.height/4), round((row+1)*effects.height/4)
            frames.append({'key': f'{name}-{col}', 'source': 'fingersnap-class-effects',
                           'sourceRect': {'x': x, 'y': y, 'w': right-x, 'h': bottom-y},
                           'width': size, 'height': size, 'destinationRect': {'x': 0, 'y': 0, 'w': size, 'h': size},
                           'origin': [0.5, 0.5], 'role': 'effect'})
        animations.append({'key': f'effect-{name}', 'frames': [f'{name}-{i}' for i in range(4)],
                           'frameRate': 12, 'repeat': -1 if name == 'magic-bolt' else 0})
    for name in ['mara', 'pip', 'orrin']:
        animations.append({'key': f'{name}-breathing', 'frames': [f'{name}-idle-{i}' for i in range(2)],
                           'frameRate': 1.5, 'repeat': -1})
    sources = []
    for key in ['fingersnap-npcs', 'fingersnap-guardian', 'fingersnap-class-effects']:
        image = Image.open(ROOT / (key+'.png'))
        sources.append({'key': key, 'file': key+'.png', 'width': image.width, 'height': image.height})
    manifest = {'version': 1, 'baseUrl': '/assets/fingersnap/runtime-pass/',
                'specSource': 'docs/runtime-asset-spec.md',
                'sources': sources, 'frames': frames, 'animations': animations,
                'aliases': {'mara': 'mara-idle-0', 'pip': 'pip-idle-0', 'orrin': 'orrin-idle-0',
                            'guardian0': 'guardian-idle', 'guardian1': 'guardian-lunge',
                            'slash': 'cleave-2', 'bolt': 'magic-bolt-0'},
                'notes': ['High-resolution source sheets; integration.js creates exact native-size canvas textures.',
                          'NPCs/guardian use a common scale and bottom-center anchor. Effects rotate around their center.',
                          'Dash trail (18x18) and healing pulse (32x32) are proposed new slots; the spec does not assign their dimensions.',
                          'Guardian poses are discrete states, not one automatically looping attack animation.']}
    (ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    print(f'Wrote {len(frames)} frames, {len(animations)} animations, and seven compatibility aliases.')


if __name__ == '__main__':
    main()
