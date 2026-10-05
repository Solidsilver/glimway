"""Measure source sheets and author metadata. Never alters source artwork."""
import json
from collections import defaultdict
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent


def dividers(alpha, count, axis):
    length = alpha.width if axis == 'x' else alpha.height
    if count == 1:
        return [0, length]
    # Find real transparent gutters around nominal cell boundaries. Generated
    # rows/columns are rarely exact, so these are measured, not grid frames.
    projection = []
    for position in range(length):
        strip = alpha.crop((position, 0, position+1, alpha.height)) if axis == 'x' else alpha.crop((0, position, alpha.width, position+1))
        projection.append(sum(v > 64 for v in strip.getdata()))
    cuts = [0]
    for index in range(1, count):
        expected = length*index/count
        radius = length/count*0.34
        lo = max(cuts[-1]+1, round(expected-radius))
        hi = min(length-1, round(expected+radius))
        values = projection[lo:hi+1]
        low = min(values)
        runs = []
        start = None
        for p in range(lo, hi+2):
            minimal = p <= hi and projection[p] == low
            if minimal and start is None:
                start = p
            if not minimal and start is not None:
                runs.append((start, p-1))
                start = None
        # Prefer a substantive gutter close to the expected divider.
        run = min(runs, key=lambda r: abs((r[0]+r[1])/2-expected)-min(24, r[1]-r[0])/2)
        cuts.append(round((run[0]+run[1])/2))
    cuts.append(length)
    return cuts


def transition_destination(key):
    shape = key.split('-', 2)[2]
    rectangles = {
        'edge-n': (0, 0, 16, 8), 'edge-e': (8, 0, 8, 16),
        'edge-s': (0, 8, 16, 8), 'edge-w': (0, 0, 8, 16),
        'corner-ne': (8, 0, 8, 8), 'corner-nw': (0, 0, 8, 8),
        'corner-se': (8, 8, 8, 8), 'corner-sw': (0, 8, 8, 8),
        'end-n': (4, 0, 8, 12), 'end-e': (4, 4, 12, 8),
        'end-s': (4, 4, 8, 12), 'end-w': (0, 4, 12, 8),
    }
    x, y, w, h = rectangles[shape]
    return dict(x=x, y=y, w=w, h=h)


def main():
    jobs = json.loads((ROOT/'jobs.json').read_text())
    if (ROOT/'portrait-job.json').exists():
        jobs.append(json.loads((ROOT/'portrait-job.json').read_text()))
    frames, sources, inspections = [], [], []
    pending = []
    for job in jobs:
        path = ROOT/job['file']
        if not path.exists():
            pending.append(job['id'])
            continue
        image = Image.open(path)
        assert image.mode == 'RGBA', (path, 'Requires RGBA')
        alpha = image.getchannel('A')
        assert alpha.getextrema()[0] == 0, (path, 'No transparent space')
        rows = dividers(alpha, job['rows'], 'y')
        sources.append({'key': 'commons-'+job['id'], 'file': job['file'], 'width': image.width, 'height': image.height})
        sheet_frames = []
        for row in range(job['rows']):
            row_alpha = alpha.crop((0, rows[row], image.width, rows[row+1]))
            columns = dividers(row_alpha, job['columns'], 'x')
            for col in range(job['columns']):
                index = row*job['columns']+col
                if index >= len(job['frames']):
                    break
                definition = job['frames'][index]
                region = (columns[col], rows[row], columns[col+1], rows[row+1])
                local = alpha.crop(region)
                max_alpha = local.getextrema()[1]
                threshold = min(64, max(8, max_alpha//3))
                bbox = local.point(lambda value: 255 if value > threshold else 0).getbbox()
                assert bbox, (job['id'], definition['key'], 'Empty occupied cell')
                left, top, right, bottom = bbox
                left, top = max(0, left-1), max(0, top-1)
                right, bottom = min(local.width, right+1), min(local.height, bottom+1)
                rect = dict(x=region[0]+left, y=region[1]+top, w=right-left, h=bottom-top)
                frame = {**definition, 'source': 'commons-'+job['id'], 'sourceRect': rect, 'sheet': job['id']}
                frames.append(frame)
                sheet_frames.append(frame['key'])
                inspections.append({'key': frame['key'], 'region': region, 'sourceRect': rect})
        # Also emit standard source-resolution Phaser atlas metadata.
        atlas_frames = {}
        for item in frames:
            if item['sheet'] != job['id']:
                continue
            r = item['sourceRect']
            atlas_frames[item['key']] = {'frame': r, 'rotated': False, 'trimmed': False,
                'spriteSourceSize': dict(x=0, y=0, w=r['w'], h=r['h']), 'sourceSize': dict(w=r['w'], h=r['h'])}
        (ROOT/(job['file'].replace('.png', '.atlas.json'))).write_text(json.dumps({'frames': atlas_frames,
            'meta': {'image': job['file'], 'size': dict(w=image.width, h=image.height)}}, indent=2)+'\n')
    groups = defaultdict(list)
    for item in frames:
        if item.get('scaleGroup'):
            groups[item['scaleGroup']].append(item)
    scales = {name: min(min((f['width']-1)/f['sourceRect']['w'], (f['height']-1)/f['sourceRect']['h']) for f in items)
              for name, items in groups.items()}
    for item in frames:
        r = item['sourceRect']
        width, height = item['width'], item['height']
        if item.get('role') == 'transition':
            destination = transition_destination(item['key'])
        elif item.get('fit') == 'cell':
            destination = dict(x=0, y=0, w=width, h=height)
        else:
            scale = scales.get(item.get('scaleGroup'), min(width/r['w'], height/r['h']))
            w, h = max(1, round(r['w']*scale)), max(1, round(r['h']*scale))
            destination = dict(x=(width-w)//2, y=height-h if item['origin'][1] == 1 else (height-h)//2, w=w, h=h)
        item['destinationRect'] = destination
    keys = {f['key'] for f in frames}
    animations = []
    for name in ['silas', 'elara', 'finn', 'hazel', 'ada']:
        if f'{name}-idle-0' in keys:
            animations.append(dict(key=f'{name}-breathing', frames=[f'{name}-idle-0', f'{name}-idle-1'], frameRate=1.5, repeat=-1))
    for prefix, count, fps in [('hearth-fire', 4, 6), ('camp-flame', 3, 6), ('campsite', 3, 5),
                                ('paper-folded', 3, 2), ('paper-scroll', 3, 2), ('paper-slate', 3, 2)]:
        if f'{prefix}-0' in keys:
            animations.append(dict(key=f'{prefix}-animation', frames=[f'{prefix}-{i}' for i in range(count)], frameRate=fps, repeat=-1))
    aliases = {name: f'{name}-idle-0' for name in ['silas', 'elara', 'finn', 'hazel', 'ada'] if f'{name}-idle-0' in keys}
    for alias, key in [('paper-folded', 'paper-folded-0'), ('paper-scroll', 'paper-scroll-0'), ('paper-slate', 'paper-slate-0'),
                       ('candle-hull', 'candle-hull-0'), ('room-fire-0', 'hearth-fire-0'), ('room-fire-1', 'hearth-fire-1')]:
        if key in keys:
            aliases[alias] = key
    manifest = {'version': 1, 'date': '2026-10-05', 'baseUrl': '/assets/fingersnap/commons-pass/',
                'sources': sources, 'frames': frames, 'animations': animations, 'aliases': aliases,
                'pendingSheets': pending, 'specSource': 'docs/art-requests.md',
                'notes': ['Source rectangles are measured, never fixed-grid.', 'Native texture rectangles preserve standing bases.',
                          'Path overlay orientation denotes the material-filled side or connecting direction, not the outward normal.',
                          'Source artwork, collisions, and game-state wiring are separate.']}
    (ROOT/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    (ROOT/'frame-inspection.json').write_text(json.dumps(inspections, indent=2)+'\n')
    print(f'{len(sources)} sheets / {len(frames)} frames / {len(animations)} animations; pending: {pending}')


if __name__ == '__main__':
    main()
