#!/usr/bin/env python3
"""Rebuild the open-map art frames, atlas and manifest from the retained source sheets."""
from __future__ import annotations

import hashlib, json, math, random
from pathlib import Path
from PIL import Image, ImageDraw, ImageChops

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'source'
OUT = ROOT / 'frames'
OUT.mkdir(parents=True, exist_ok=True)

PROPS = Image.open(SRC / 'meadow-props-source.png').convert('RGBA')
GROUND_SOURCE = Image.open(SRC / 'ground-tiles-generated.png').convert('RGBA')
FORD_SOURCE = Image.open(SRC / 'fords-generated.png').convert('RGB')
FORD_WATER_SOURCE = Image.open(SRC / 'ford-water-round3-generated.png').convert('RGB')
VEIL_SOURCE = Image.open(SRC / 'frontier-veil-generated.png').convert('RGBA')
LANDMARK_SOURCE = Image.open(SRC / 'landmarks-generated.png').convert('RGBA')
SPLIT_OAK_SOURCE = Image.open(SRC / 'landmark-split-oak-generated.png').convert('RGBA')
STANDING_STONE_SOURCE = Image.open(SRC / 'standing-stone-round3-generated.png').convert('RGBA')
WAY_SIGN_SOURCE = Image.open(SRC / 'way-sign-round3-generated.png').convert('RGBA')
WAY_LAMP_SOURCE = Image.open(SRC / 'way-lamp-generated.png').convert('RGBA')

# Source cuts in the generated 1402x1122 transparent prop sheet. Crops are kept
# here so every frame can be rebuilt without depending on the generation tool.
PROP_CUTS = {
 'meadow-grass-0': (12, 0, 283, 287), 'meadow-grass-1': (293, 0, 579, 287), 'meadow-grass-2': (580, 0, 874, 287),
 'meadow-flowers-0': (875, 0, 1137, 287), 'meadow-flowers-1': (1138, 0, 1402, 287),
 'meadow-flowers-2': (875, 0, 1137, 287),
 'meadow-outcrop-0': (10, 294, 292, 614), 'meadow-outcrop-1': (298, 294, 614, 614), 'meadow-oak': (615, 269, 888, 614),
 'meadow-stone-0': (889, 360, 1131, 614), 'meadow-stone-1': (1132, 360, 1402, 614),
 'bank-stones-0': (8, 625, 319, 867), 'bank-stones-1': (320, 625, 651, 867), 'bank-stones-2': (652, 625, 1007, 867),
}
CANVAS = {
 'meadow-grass': (64,64), 'meadow-flowers': (64,64), 'meadow-outcrop': (128,160), 'meadow-oak': (160,256),
 'meadow-stone': (64,64), 'bank-stones': (64,64), 'lamp-stone-dark': (64,128),
 'landmark-split-oak': (192,320), 'landmark-standing-stone': (64,224), 'rumour-find-closed': (64,64),
 'rumour-find-open': (64,64), 'way-sign': (64,128),
}
FOOTPRINT = {
 'meadow-grass': (1,1), 'meadow-flowers': (1,1), 'meadow-outcrop': (2,2), 'meadow-oak': (2,1),
 'meadow-stone': (1,1), 'bank-stones': (1,1), 'lamp-stone-dark': (1,1),
 'landmark-split-oak': (2,1), 'landmark-standing-stone': (1,1), 'rumour-find-closed': (1,1),
 'rumour-find-open': (1,1), 'way-sign': (1,1), 'frontier-veil': (3,1),
 'ford-h': (3,1), 'ford-v': (1,3), 'path-stone': (1,1), 'path-plank-h': (1,1), 'path-plank-v': (1,1),
 'road-paving': (1,1), 'road-verge': (1,1), 'icon-map-tab': (1,1),
}

def palette_limit(img: Image.Image, colors=32) -> Image.Image:
    alpha = img.getchannel('A').point(lambda a: 255 if a >= 128 else 0)
    rgb = img.convert('RGB').quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert('RGB')
    rgb.putalpha(alpha)
    return rgb

def crop_sprite(key, canvas):
    cut = PROP_CUTS[key]
    piece = PROPS.crop(cut)
    if key == 'meadow-flowers-2':
        piece = piece.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        p = piece.load()
        for yy in range(piece.height):
            for xx in range(piece.width):
                r,g,b,a=p[xx,yy]
                # turn this source variation into a muted cream-and-dusty-blue patch
                if a and b > r*1.2 and b > g*1.03: p[xx,yy]=(min(255,r+18),min(255,g+12),min(255,b-14),a)
    clean_edges = {
        'meadow-outcrop-1': {'R'}, 'meadow-stone-0': {'L'}, 'meadow-oak': {'T'},
        'bank-stones-1': {'L'}, 'bank-stones-2': {'L'},
    }.get(key, set())
    if clean_edges: piece=discard_components_touching(piece,clean_edges)
    # Remove fully empty margins, then nearest-neighbour fit to the listed canvas.
    alpha = piece.getchannel('A')
    bbox = alpha.getbbox()
    if bbox: piece = piece.crop(bbox)
    w,h = canvas
    maxw,maxh = w-6,h-6
    scale = min(maxw/piece.width, maxh/piece.height)
    size=(max(1,round(piece.width*scale)),max(1,round(piece.height*scale)))
    piece=piece.resize(size,Image.Resampling.NEAREST)
    # Remove a few generator speckle pixels by replacing isolated vivid red pixels
    # with the darkest adjacent non-red color. This keeps the transparent cutout clean.
    px=piece.load()
    for yy in range(1,piece.height-1):
        for xx in range(1,piece.width-1):
            r,g,b,a=px[xx,yy]
            if a and r>105 and r>g*1.28 and r>b*1.2:
                neighbors=[]
                for ny in range(yy-1,yy+2):
                    for nx in range(xx-1,xx+2):
                        nr,ng,nb,na=px[nx,ny]
                        if na and not (nr>105 and nr>ng*1.28 and nr>nb*1.2): neighbors.append((nr,ng,nb,na))
                if neighbors: px[xx,yy]=min(neighbors,key=lambda q: sum(q[:3]))
    piece=palette_limit(piece, 40)
    result=Image.new('RGBA',canvas,(0,0,0,0))
    x=(w-size[0])//2
    y=h-size[1] if key.startswith('frontier-veil') else h-size[1]
    result.alpha_composite(piece,(x,y))
    return result

def discard_components_touching(img, edges):
    """Remove disconnected pieces clipped from neighboring sprite cells."""
    img=img.copy().convert('RGBA')
    alpha=img.getchannel('A').point(lambda a:255 if a>=128 else 0)
    w,h=img.size; data=alpha.tobytes(); seen=bytearray(w*h); components=[]
    for start,value in enumerate(data):
        if not value or seen[start]: continue
        stack=[start]; seen[start]=1; pixels=[]; minx=w; miny=h; maxx=-1; maxy=-1
        while stack:
            pos=stack.pop(); x=pos%w; y=pos//w; pixels.append(pos)
            minx=min(minx,x); maxx=max(maxx,x); miny=min(miny,y); maxy=max(maxy,y)
            for ny in range(max(0,y-1),min(h,y+2)):
                for nx in range(max(0,x-1),min(w,x+2)):
                    nxt=ny*w+nx
                    if data[nxt] and not seen[nxt]: seen[nxt]=1; stack.append(nxt)
        touch={'L':minx==0,'R':maxx==w-1,'T':miny==0,'B':maxy==h-1}
        components.append((pixels,touch))
    out=Image.new('RGBA',img.size,(0,0,0,0)); src=img.load(); dst=out.load()
    for pixels,touch in components:
        if any(touch[e] for e in edges): continue
        for pos in pixels:
            x=pos%w; y=pos//w; r,g,b,a=src[x,y]; dst[x,y]=(r,g,b,255)
    return out

def source_cell(img, col, row, cols, rows, inset=4):
    cw=img.width/cols; ch=img.height/rows
    x0=round(col*cw)+inset; x1=round((col+1)*cw)-inset
    y0=round(row*ch)+inset; y1=round((row+1)*ch)-inset
    return img.crop((x0,y0,x1,y1)),(x0,y0,x1-x0,y1-y0)

def fit_pixel_art(img, canvas, colors=40):
    img=img.convert('RGBA')
    img.putalpha(img.getchannel('A').point(lambda a:255 if a>=128 else 0))
    box=img.getchannel('A').getbbox()
    if box: img=img.crop(box)
    w,h=canvas; scale=min((w-4)/img.width,(h-4)/img.height)
    size=(max(1,round(img.width*scale)),max(1,round(img.height*scale)))
    img=img.resize(size,Image.Resampling.NEAREST)
    rgb=img.convert('RGB').quantize(colors=colors,method=Image.Quantize.MEDIANCUT,dither=Image.Dither.NONE).convert('RGB')
    rgb.putalpha(img.getchannel('A'))
    result=Image.new('RGBA',canvas,(0,0,0,0)); result.alpha_composite(rgb,((w-size[0])//2,h-size[1]))
    return result

def seamless_family(images, horizontal=True, vertical=True):
    """Share edge profiles within a family so any variants join without seams."""
    ref=images[0].convert('RGBA'); w,h=ref.size; profile_x=[]; profile_y=[]
    for y in range(h):
        a=ref.getpixel((1,y)); b=ref.getpixel((w-2,y)); profile_x.append(tuple((a[i]+b[i])//2 for i in range(4)))
    for x in range(w):
        a=ref.getpixel((x,1)); b=ref.getpixel((x,h-2)); profile_y.append(tuple((a[i]+b[i])//2 for i in range(4)))
    out=[]
    for source in images:
        im=source.convert('RGBA'); px=im.load()
        if horizontal:
            for y in range(h): px[0,y]=profile_x[y]; px[w-1,y]=profile_x[y]
        if vertical:
            for x in range(w): px[x,0]=profile_y[x]; px[x,h-1]=profile_y[x]
        if horizontal and vertical:
            corner=tuple(sum([profile_x[y][i] for y in (0,h-1)]+[profile_y[x][i] for x in (0,w-1)])//4 for i in range(4))
            for x,y in ((0,0),(w-1,0),(0,h-1),(w-1,h-1)): px[x,y]=corner
        out.append(im)
    return out

def build_ground_frames():
    result={}
    groups=[('path-stone',4,0,0),('path-plank-h',2,0,1),('path-plank-v',2,2,1),('road-paving',4,0,2),('road-verge',2,0,3)]
    for stem,count,start_col,row in groups:
        raw=[]; rects=[]
        for i in range(count):
            cell,rect=source_cell(GROUND_SOURCE,start_col+i,row,4,4,6)
            raw.append(cell.resize((64,64),Image.Resampling.NEAREST).convert('RGBA')); rects.append(rect)
        sealed=seamless_family(raw)
        for i in range(count): result[f'{stem}-{i}']=(sealed[i],rects[i])
    return result

def build_ford_frames():
    base=FORD_WATER_SOURCE.resize((192,64),Image.Resampling.NEAREST).convert('RGB')
    stones=FORD_SOURCE.resize((192,64),Image.Resampling.NEAREST).convert('RGB')
    # Keep only the three broad stepping stones; the source has extra pebbles in the water.
    rocks=Image.new('L',(192,64),0); d=ImageDraw.Draw(rocks)
    shapes=[
        [(3,21),(7,16),(15,13),(24,13),(34,16),(43,19),(51,23),(55,29),(53,35),(48,40),(40,44),(29,46),(18,44),(9,41),(4,35)],
        [(64,27),(67,20),(73,16),(82,13),(94,13),(104,15),(112,19),(116,25),(115,32),(111,38),(104,42),(94,45),(83,45),(73,42),(67,37)],
        [(128,23),(132,18),(140,14),(151,13),(163,14),(174,16),(183,20),(188,25),(188,32),(183,38),(176,42),(166,45),(154,45),(143,43),(134,39),(129,33)],
    ]
    for points in shapes: d.polygon(points,fill=255)
    result=[]
    for shift in (0,1,2):
        moved=ImageChops.offset(base,shift,0)
        water=Image.composite(base,moved,Image.new('L',(192,64),255))
        result.append(Image.composite(stones,water,rocks).convert('RGBA'))
    return result

def round3_prop(source, key, size, source_key):
    """Use the dominant isolated generated silhouette and fill the requested portrait height."""
    im=source.convert('RGBA')
    box=im.getchannel('A').getbbox()
    if box: im=im.crop(box)
    canvas=CANVAS[key]
    target=(56,204) if key=='landmark-standing-stone' else (56,104)
    im=im.resize(target,Image.Resampling.NEAREST)
    im=palette_limit(im,40)
    out=Image.new('RGBA',canvas,(0,0,0,0)); out.alpha_composite(im,((canvas[0]-target[0])//2,canvas[1]-target[1]))
    out.save(OUT/f'{key}.png',optimize=True)
    frames[key]={'file':f'frames/{key}.png','source':source_key,'sourceRect':{'x':0,'y':0,'w':source.width,'h':source.height},
      'canvas':{'w':canvas[0],'h':canvas[1]},'footprint':{'w':1,'h':1},
      'footPoint':{'x':canvas[0]//2,'y':canvas[1]},'kind':'transparent-prop'}

def build_veil_frames():
    result=[]
    for row in range(4):
        y0=round(row*VEIL_SOURCE.height/4); y1=round((row+1)*VEIL_SOURCE.height/4)
        cell=VEIL_SOURCE.crop((0,y0,VEIL_SOURCE.width//2,y1))
        result.append(fit_pixel_art(cell,(192,64),28))
    # Only left/right seams matter: the strips repeat along the boundary.
    return seamless_family(result,vertical=False)

GROUND_FRAMES=build_ground_frames()
FORD_FRAMES=build_ford_frames()
VEIL_FRAMES=build_veil_frames()

frames={}; sources=[]
def add(key, source_key, sheet, rect, canvas, kind, footprint, foot=None):
    x,y,w,h=rect; crop=sheet.crop((x,y,x+w,y+h)).convert('RGBA')
    if crop.size != canvas: crop=crop.resize(canvas,Image.Resampling.NEAREST)
    crop.save(OUT/f'{key}.png',optimize=True)
    e={'file':f'frames/{key}.png','source':source_key,'sourceRect':{'x':x,'y':y,'w':w,'h':h},'canvas':{'w':canvas[0],'h':canvas[1]},'footprint':{'w':footprint[0],'h':footprint[1]},'kind':kind}
    if foot is None: foot=(canvas[0]//2,canvas[1])
    e['footPoint']={'x':foot[0],'y':foot[1]}
    frames[key]=e

def sprite(key, foot=None):
    group=next(k for k in CANVAS if key == k or key.startswith(k+'-'))
    can=CANVAS[group]
    im=crop_sprite(key,can); im.save(OUT/f'{key}.png',optimize=True)
    w,h=can
    e={'file':f'frames/{key}.png','source':'meadow-props','sourceRect':{'x':PROP_CUTS[key][0],'y':PROP_CUTS[key][1],'w':PROP_CUTS[key][2]-PROP_CUTS[key][0],'h':PROP_CUTS[key][3]-PROP_CUTS[key][1]},'canvas':{'w':w,'h':h},'footprint':{'w':FOOTPRINT[group][0],'h':FOOTPRINT[group][1]},'kind':'transparent-prop'}
    if foot is not None: e['footPoint']={'x':foot[0],'y':foot[1]}
    frames[key]=e

def generated_prop(key, sheet_key, sheet, col, row, cols, rows, footprint, inset=20):
    cell,rect=source_cell(sheet,col,row,cols,rows,inset)
    can=CANVAS[key]
    im=fit_pixel_art(cell,can,40)
    im.save(OUT/f'{key}.png',optimize=True)
    frames[key]={'file':f'frames/{key}.png','source':sheet_key,'sourceRect':{'x':rect[0],'y':rect[1],'w':rect[2],'h':rect[3]},
      'canvas':{'w':can[0],'h':can[1]},'footprint':{'w':footprint[0],'h':footprint[1]},
      'footPoint':{'x':can[0]//2,'y':can[1]},'kind':'transparent-prop'}

for key in PROP_CUTS:
    group=next(k for k in CANVAS if key == k or key.startswith(k+'-'))
    foot=(CANVAS[group][0]//2,CANVAS[group][1]) if not key.startswith('frontier') else (96,64)
    sprite(key,foot)

for key,(col,row,foot) in {
    'landmark-split-oak':(0,0,(2,1)), 'landmark-standing-stone':(1,0,(1,1)),
    'rumour-find-closed':(2,0,(1,1)), 'rumour-find-open':(0,1,(1,1)),
    'way-sign':(1,1,(1,1)), 'lamp-stone-dark':(2,1,(1,1)),
}.items():
    if key=='landmark-split-oak':
        can=CANVAS[key]; im=fit_pixel_art(SPLIT_OAK_SOURCE,can,40)
        im.save(OUT/f'{key}.png',optimize=True)
        frames[key]={'file':f'frames/{key}.png','source':'landmark-split-oak-generated',
          'sourceRect':{'x':0,'y':0,'w':SPLIT_OAK_SOURCE.width,'h':SPLIT_OAK_SOURCE.height},
          'canvas':{'w':can[0],'h':can[1]},'footprint':{'w':2,'h':1},
          'footPoint':{'x':can[0]//2,'y':can[1]},'kind':'transparent-prop'}
    else:
        generated_prop(key,'landmarks-generated',LANDMARK_SOURCE,col,row,3,2,foot,20)

# The generated three-state wayside lamp is kept on one fixed canvas. Its
# states share a union crop before fitting, then the builder reduces it to
# 2x2 texel clusters and the Wilds palette just like the other props.
lamp_cell_width = WAY_LAMP_SOURCE.width // 3
lamp_cells = [WAY_LAMP_SOURCE.crop((i*lamp_cell_width+6, 6, (i+1)*lamp_cell_width-6, WAY_LAMP_SOURCE.height-6)) for i in range(3)]
lamp_union = Image.new('L', lamp_cells[0].size, 0)
for cell in lamp_cells:
    lamp_union = ImageChops.lighter(lamp_union, cell.getchannel('A'))
lamp_bbox = lamp_union.getbbox()
for i,cell in enumerate(lamp_cells):
    cell = cell.crop(lamp_bbox)
    half = fit_pixel_art(cell, (32,48), 24)
    im = half.resize((64,96), Image.Resampling.NEAREST)
    # Keep the game's canonical outline color in the limited palette.
    px = im.load()
    for yy in range(im.height):
        for xx in range(im.width):
            r,g,b,a = px[xx,yy]
            if a and max(r,g,b) < 64: px[xx,yy] = (58,42,40,a)
    key = f'way-lamp-{i}'
    im.save(OUT/f'{key}.png', optimize=True)
    frames[key] = {'file':f'frames/{key}.png','source':'way-lamp-generated',
      'sourceRect':{'x':i*lamp_cell_width+6,'y':6,'w':lamp_cell_width-12,'h':WAY_LAMP_SOURCE.height-12},
      'canvas':{'w':64,'h':96},'footprint':{'w':1,'h':1},
      'footPoint':{'x':32,'y':96},'kind':'transparent-prop'}

# Round-3 portrait replacements remove the tiny source cuts and stray fragments.
round3_prop(STANDING_STONE_SOURCE,'landmark-standing-stone',(56,204),'standing-stone-round3-generated')
round3_prop(WAY_SIGN_SOURCE,'way-sign',(56,104),'way-sign-round3-generated')

# Generated seamless ground atlas: 4 stone path, 2 crosswise/2 lengthwise plank,
# 4 older road, and 2 verge variants. All are opaque 64x64 canvases.
for key,(im,rect) in GROUND_FRAMES.items():
    im.save(OUT/f'{key}.png',optimize=True)
    stem=key.rsplit('-',1)[0]
    frames[key]={'file':f'frames/{key}.png','source':'ground-tiles-generated',
      'sourceRect':{'x':rect[0],'y':rect[1],'w':rect[2],'h':rect[3]},'canvas':{'w':64,'h':64},
      'footprint':{'w':1,'h':1},'footPoint':{'x':32,'y':64},'kind':'opaque-ground-tile',
      'seamFamily':stem}

ford_base=build_ford_frames()
for orientation in ('h','v'):
    for i,base in enumerate(ford_base):
        im=base if orientation=='h' else base.transpose(Image.Transpose.ROTATE_90)
        key=f'ford-{orientation}-{i}'; can=im.size
        im.save(OUT/f'{key}.png',optimize=True)
        frames[key]={'file':f'frames/{key}.png','source':'fords-generated',
          'sourceRect':{'x':0,'y':0,'w':FORD_SOURCE.width,'h':FORD_SOURCE.height},
          'canvas':{'w':can[0],'h':can[1]},'footprint':{'w':3,'h':1} if orientation=='h' else {'w':1,'h':3},
          'footPoint':{'x':can[0]//2,'y':can[1]},'kind':'opaque-animated-ground','ripplePhase':i}

veil_frames=build_veil_frames()
veil_h=VEIL_SOURCE.height//4; veil_w=VEIL_SOURCE.width//2
for i,im in enumerate(veil_frames):
    key=f'frontier-veil-{i}'; im.save(OUT/f'{key}.png',optimize=True)
    frames[key]={'file':f'frames/{key}.png','source':'frontier-veil-generated',
      'sourceRect':{'x':0,'y':i*veil_h,'w':veil_w,'h':veil_h},'canvas':{'w':192,'h':64},
      'footprint':{'w':3,'h':1},'footPoint':{'x':96,'y':64},'kind':'transparent-boundary-overlay'}

# Map icon, drawn as a compact single-cell map with road and landmarks.
icon=Image.new('RGBA',(32,32),(0,0,0,0)); d=ImageDraw.Draw(icon)
d.polygon([(5,7),(13,4),(21,7),(27,4),(27,24),(20,27),(12,24),(5,27)],fill=(213,195,151,255),outline=(61,47,36,255))
d.line((13,5,13,24),fill=(91,67,48,255),width=1); d.line((20,7,20,26),fill=(91,67,48,255),width=1)
d.line([(8,20),(11,17),(16,18),(18,13),(23,11)],fill=(73,103,55,255),width=2)
d.ellipse((21,9,24,12),fill=(147,114,68,255),outline=(61,47,36,255))
icon.save(OUT/'icon-map-tab.png',optimize=True)
frames['icon-map-tab']={'file':'frames/icon-map-tab.png','source':'icon-map-tab','sourceRect':{'x':0,'y':0,'w':32,'h':32},'canvas':{'w':32,'h':32},'footprint':{'w':1,'h':1},'footPoint':{'x':16,'y':32},'kind':'ui-icon'}
icon.save(SRC/'map-icon-source.png',optimize=True)

# Source catalog with hashes, dimensions, modes.
source_files={
 'meadow-props':'meadow-props-source.png','ground-tiles-generated':'ground-tiles-generated.png',
 'fords-generated':'fords-generated.png','frontier-veil-generated':'frontier-veil-generated.png',
 'landmarks-generated':'landmarks-generated.png','icon-map-tab':'map-icon-source.png',
 'landmark-split-oak-generated':'landmark-split-oak-generated.png',
 'ford-water-round3-generated':'ford-water-round3-generated.png',
 'standing-stone-round3-generated':'standing-stone-round3-generated.png',
 'way-sign-round3-generated':'way-sign-round3-generated.png',
 'way-lamp-generated':'way-lamp-generated.png',
}
for k,file in source_files.items():
    im=Image.open(SRC/file)
    raw=(SRC/file).read_bytes()
    sources.append({'key':k,'file':f'source/{file}','width':im.width,'height':im.height,'mode':im.mode,'sha256':hashlib.sha256(raw).hexdigest()})

animations=[{'key':'ford-h-ripple','frames':[f'ford-h-{i}' for i in range(3)],'frameRate':1.5,'repeat':-1},
            {'key':'ford-v-ripple','frames':[f'ford-v-{i}' for i in range(3)],'frameRate':1.5,'repeat':-1},
            {'key':'frontier-veil','frames':[f'frontier-veil-{i}' for i in range(4)],'frameRate':2,'repeat':-1}]
manifest={'version':1,'density':4,'worldTileSize':16,'frameCount':len(frames),'sources':sources,'frames':frames,'animations':animations}
atlas={'frames':{k:{'source':v['source'],'x':v['sourceRect']['x'],'y':v['sourceRect']['y'],'w':v['sourceRect']['w'],'h':v['sourceRect']['h'],'canvas':v['canvas'],'footprint':v['footprint'],**({'footPoint':v['footPoint']} if 'footPoint' in v else {})} for k,v in frames.items()},'animations':animations}
(ROOT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(ROOT/'atlas.json').write_text(json.dumps(atlas,indent=2)+'\n')
(ROOT/'animations.json').write_text(json.dumps(animations,indent=2)+'\n')

# Contact sheet of all real-size canvases, nearest-neighbour enlarged 2x, with labels.
items=list(frames)
cols=5; cellw=220; cellh=210
sheet=Image.new('RGB',(cols*cellw,math.ceil(len(items)/cols)*cellh),(39,42,36)); d=ImageDraw.Draw(sheet)
for i,key in enumerate(items):
    x=(i%cols)*cellw; y=(i//cols)*cellh
    im=Image.open(OUT/f'{key}.png').convert('RGBA')
    im.thumbnail((192,170),Image.Resampling.NEAREST)
    bg=Image.new('RGBA',im.size,(105,122,75,255)); bg.alpha_composite(im)
    sheet.paste(bg.convert('RGB'),(x+(cellw-im.width)//2,y+4))
    d.text((x+5,y+178),key,fill=(240,231,207))
sheet.save(ROOT/'contact-sheet.png')
print(f'Built {len(frames)} frames from {len(sources)} source sheets.')
