"""Regenerate the room contact sheets from the audited manifest and crops."""
from pathlib import Path
import json, math
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
OUT = REPO / '.agent' / 'screens'
OUT.mkdir(parents=True, exist_ok=True)
manifest = json.loads((ROOT / 'manifest.json').read_text())
sources = {s['key']: Image.open(ROOT / 'sheets' / s['file']).convert('RGBA') for s in manifest['sources']}
frames = {f['key']: f for f in manifest['frames']}
pieces = {p['frame']: p['id'] for p in manifest.get('furnishings', [])}
font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 13)
kit_ids = {
    'rug-woven','rug-braided','rug-patchwork','shelf-generic-front','shelf-generic-side',
    'wall-pegs-tools','crate','barrel','sack-large','basket','plant-leafy','plant-flowering',
    'lamp-oil','candle-holder','candle-stick','picture-frame','calendar','curtains',
    'side-table','chair-front','chair-side','stool','chest'
}
kit_keys = [f['key'] for f in manifest['frames'] if pieces.get(f['key']) in kit_ids]
room_keys = {
  'library-pass.png': [k for k in frames if k.startswith('library-')],
  'kitchen-pass.png': [k for k in frames if k.startswith('kitchen-')] + kit_keys,
  'mill-pass.png': [k for k in frames if k.startswith(('mill','loft-'))] + kit_keys,
  'loft-pass.png': [k for k in frames if k.startswith('loft-') or k.startswith('mill-sack-')] + kit_keys,
  'cottage-pass.png': kit_keys,
  'shared-interior-kit.png': kit_keys,
}

def cell_art(key):
    f = frames[key]
    r, d = f['sourceRect'], f['destinationRect']
    im = sources[f['source']].crop((r['x'], r['y'], r['x'] + r['w'], r['y'] + r['h']))
    if (im.width, im.height) != (d['w'], d['h']):
        im = im.resize((d['w'], d['h']), Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA', (f['canvasSize']['w'], f['canvasSize']['h']), (0,0,0,0))
    canvas.alpha_composite(im, (d['x'], d['y']))
    return canvas

for filename, keys in room_keys.items():
    keys = list(dict.fromkeys(keys))
    cols, cw, ch = 5, 230, 216
    rows = math.ceil(len(keys) / cols)
    sheet = Image.new('RGB', (cols*cw, rows*ch), (244, 232, 207))
    draw = ImageDraw.Draw(sheet)
    for i, key in enumerate(keys):
        x, y = (i % cols) * cw, (i // cols) * ch
        f = frames[key]
        art = cell_art(key)
        maxw, maxh = cw-18, ch-38
        scale = min(maxw/art.width, maxh/art.height)
        size = (max(1, round(art.width*scale)), max(1, round(art.height*scale)))
        art = art.resize(size, Image.Resampling.NEAREST)
        sheet.paste(art, (x+(cw-size[0])//2, y+4), art)
        label = key
        draw.text((x+5, y+ch-26), label, font=font, fill=(57, 43, 34))
        draw.rectangle((x, y, x+cw-1, y+ch-1), outline=(198, 176, 144), width=1)
    sheet.save(OUT / filename)
    print(f'{filename}: {len(keys)} frames')
