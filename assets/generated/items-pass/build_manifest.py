"""Measure item/world-art sprite sheets and add runtime slot metadata."""
import json
import re
from collections import defaultdict
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent


def cuts(alpha, count, axis):
    length = alpha.width if axis == 'x' else alpha.height
    if count == 1:
        return [0, length]
    projection = []
    for p in range(length):
        strip = alpha.crop((p, 0, p+1, alpha.height)) if axis == 'x' else alpha.crop((0, p, alpha.width, p+1))
        projection.append(sum(v > 96 for v in strip.getdata()))
    result = [0]
    for i in range(1, count):
        expected = round(length*i/count)
        radius = round(length/count*.34)
        lo, hi = max(result[-1]+1, expected-radius), min(length-1, expected+radius)
        floor = min(projection[lo:hi+1])
        candidates = [p for p in range(lo, hi+1) if projection[p] == floor]
        p = min(candidates, key=lambda x: abs(x-expected))
        result.append(p)
    result.append(length)
    return result


def slug(value):
    return re.sub(r'[^a-z0-9-]+', '-', value.lower()).strip('-')


def main():
    jobs = json.loads((ROOT/'jobs.json').read_text())
    frames, sources, inspect = [], [], []
    for job in jobs:
        image = Image.open(ROOT/job['file'])
        assert image.mode == 'RGBA' and image.getchannel('A').getextrema()[0] == 0, job['file']
        alpha = image.getchannel('A')
        ys = ([round(alpha.height*p) for p in job['rowDividers']] if job.get('rowDividers') else cuts(alpha, job['rows'], 'y'))
        source = 'items-'+job['id']
        sources.append(dict(key=source, file=job['file'], width=image.width, height=image.height))
        first = len(frames)
        # Most generated sheets use row-major source cells. Sparse sheets can
        # name explicit cell indices when a generator grouped item families by row.
        cell_indices = job.get('cellIndices', list(range(len(job['frames']))))
        frame_by_cell = {cell: frame_index for frame_index, cell in enumerate(cell_indices)}
        for row in range(job['rows']):
            cell_alpha = alpha.crop((0, ys[row], image.width, ys[row+1]))
            xs = cuts(cell_alpha, job['columns'], 'x')
            for col in range(job['columns']):
                ix = row*job['columns']+col
                if ix not in frame_by_cell:
                    continue
                frame_index = frame_by_cell[ix]
                frame = dict(job['frames'][frame_index])
                region = (xs[col], ys[row], xs[col+1], ys[row+1])
                local = alpha.crop(region)
                max_alpha = local.getextrema()[1]
                threshold = min(96, max(16, max_alpha//3))
                bbox = local.point(lambda v: 255 if v > threshold else 0).getbbox()
                assert bbox, (job['id'], frame['key'])
                l, t, r, b = bbox
                l, t, r, b = max(0,l-1),max(0,t-1),min(local.width,r+1),min(local.height,b+1)
                frame['source'], frame['sheet'] = source, job['id']
                frame['sourceRect'] = dict(x=region[0]+l,y=region[1]+t,w=r-l,h=b-t)
                note = job['frameNotes'][frame_index]
                for k in ['itemId','category','priority','name','state','look']:
                    frame[k] = note[k]
                frames.append(frame)
                inspect.append(dict(key=frame['key'], region=region, sourceRect=frame['sourceRect']))
        atlas = {}
        for f in frames[first:]:
            r=f['sourceRect']
            atlas[f['key']]={'frame':r,'rotated':False,'trimmed':False,'spriteSourceSize':dict(x=0,y=0,w=r['w'],h=r['h']),'sourceSize':dict(w=r['w'],h=r['h'])}
        (ROOT/(job['file'].replace('.png','.atlas.json'))).write_text(json.dumps({'frames':atlas,'meta':{'image':job['file'],'size':{'w':image.width,'h':image.height}}},indent=2)+'\n')

    # Keep scale consistent across states of the same prop or animation.
    groups=defaultdict(list)
    for f in frames:
        if f.get('scaleGroup'):groups[f['scaleGroup']].append(f)
        elif f.get('itemId') in ['hollow-tree','standing-iron-oak','iron-oak-windfall','tree-stump','herb-patch-comfrey','herb-patch-thyme','stump-turncaps','old-lamp-stone','lantern-post','gate-shelf','keepsake-cabinet','drying-rack','apothecary-shelf','raised-bed','pencil-map','pressed-flowers','window-lamp','closure-lamp','ledger-soup-pot']:
            groups[f['itemId']].append(f)
    scales={k:min(min((f['width']-1)/f['sourceRect']['w'],(f['height']-1)/f['sourceRect']['h']) for f in v) for k,v in groups.items()}
    for f in frames:
        r=f['sourceRect'];w,h=f['width'],f['height']
        if f.get('fit')=='cell':d=dict(x=0,y=0,w=w,h=h)
        else:
            factor=scales.get(f.get('scaleGroup') or f.get('itemId'),min(w/r['w'],h/r['h']))
            dw,dh=max(1,round(r['w']*factor)),max(1,round(r['h']*factor))
            d=dict(x=(w-dw)//2,y=h-dh if f['origin'][1]==1 else (h-dh)//2,w=dw,h=dh)
        f['destinationRect']=d

    keys={f['key'] for f in frames}
    aliases={}
    by_item=defaultdict(list)
    for f in frames:by_item[f['itemId']].append(f)
    for item,variants in by_item.items():
        aliases[item]=variants[0]['key']
    # Inventory icon id resolves to its first/default authored state.
    for f in frames:
        if f['category'] in ['Tools','Supplies','Keepsakes','Home goods','Papers']:
            aliases.setdefault(f['itemId'],f['key'])
    # Existing canonical art is referenced by its Commons texture key.
    aliases.update({'timber':'commons:icon-timber','woodpile':'commons:woodpile','candle-hulls':'commons:candle-hull-0','carting-bunting':'commons:bunting','whittled-fox':'commons:icon-whittled-fox','river-glass-bead':'commons:icon-river-glass-bead','tin-whistle':'commons:icon-tin-whistle','beeswax-candle':'commons:icon-beeswax-candle','spare-bootlace':'commons:icon-spare-bootlace'})
    animations=[]
    state_groups=[]
    for base,n,fps in [('mill-wheel',4,4),('mill-wheel-mended',4,4),('mill-froth',2,6)]:
        seq=[f'{base}-{i}' for i in range(n)]
        if all(k in keys for k in seq):animations.append(dict(key=base,frames=seq,frameRate=fps,repeat=-1))
    for base,variants in by_item.items():
        seq=[f['key'] for f in variants if f.get('state') is not None]
        if len(seq)>1 and not base.startswith('mill-wheel') and base!='mill-froth':
            state_groups.append(dict(key=base+'-states',frames=seq,selection='select by gameplay state; never auto-loop'))
    manifest=dict(version=1,baseUrl='/assets/fingersnap/items-pass/',sources=sources,frames=frames,animations=animations,stateGroups=state_groups,aliases=aliases,
                  notes=['All source rectangles are measured; no fixed source cell dimensions are assumed.','Use the manifest exact native canvas dimensions.','Inventory wear and world condition frames are discrete gameplay states, not looping animations.','Existing Commons frames are referenced with the commons: alias prefix.','Physics, interaction footprints, scene wiring, and world adjacency remain runtime decisions.'])
    (ROOT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    (ROOT/'frame-inspection.json').write_text(json.dumps(inspect,indent=2)+'\n')
    print(f"{len(sources)} source sheets / {len(frames)} frames / {len(animations)} animation or state groups")


if __name__=='__main__':main()
