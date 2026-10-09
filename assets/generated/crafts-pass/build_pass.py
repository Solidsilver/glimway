#!/usr/bin/env python3
"""Build exact-size, transparent frames and atlas metadata from the generated source sheets."""
from __future__ import annotations

import json
from collections import deque
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageOps

ROOT = Path(__file__).parent
SHEETS = ROOT / "sheets"
OUT = ROOT / "frames"
OUT.mkdir(exist_ok=True)

def transparent_sheet(name: str) -> Image.Image:
    im = Image.open(SHEETS / name).convert("RGBA")
    px = im.load()
    # The generator rendered a slightly noisy neutral checker pattern. Flood
    # only neutral pixels connected to the image edge, preserving enclosed
    # silver/cream details inside the sprites.
    w,h = im.size
    seen = bytearray(w*h)
    stack = []
    def neutral(i: int) -> bool:
        x=i%w; y=i//w
        r,g,b,a=px[x,y]
        return min(r,g,b)>70 and max(r,g,b)-min(r,g,b)<10
    for x in range(w):
        for y in (0,h-1):
            i=y*w+x
            if neutral(i) and not seen[i]: seen[i]=1; stack.append(i)
    for y in range(h):
        for x in (0,w-1):
            i=y*w+x
            if neutral(i) and not seen[i]: seen[i]=1; stack.append(i)
    while stack:
        i=stack.pop(); x=i%w; y=i//w
        px[x,y]=(0,0,0,0)
        for j in (i-1 if x else -1, i+1 if x+1<w else -1, i-w if y else -1, i+w if y+1<h else -1):
            if j>=0 and not seen[j] and neutral(j): seen[j]=1; stack.append(j)
    if name == "ability-effects-redraw.png":
        # The strip has a checker trapped inside its closed Ward-light rim.
        # Its background checks are neutral grey; the pale gold Kindle light
        # is warm-tinted and stays intact.
        for y in range(h):
            for x in range(w):
                r,g,b,a=px[x,y]
                if 80<min(r,g,b)<235 and max(r,g,b)-min(r,g,b)<8:
                    px[x,y]=(0,0,0,0)
    return im

def save_frame(key: str, source: str, roi: tuple[int,int,int,int], canvas: tuple[int,int],
               footprint: tuple[int,int] | None, foot: tuple[int,int] | None,
               source_images: dict[str,Image.Image], frames: dict, sources: dict, anchor_mode: str = "bottom"):
    im = source_images[source].crop(roi)
    # Trim transparent edges, then aspect-contain at native density with a
    # 4-texel gutter. Never stretch a source crop.
    alpha = im.getchannel("A")
    box = alpha.getbbox()
    if box:
        im = im.crop(box)
    w,h = canvas
    target = (max(1,w-8), max(1,h-8))
    im = ImageOps.contain(im, target, method=Image.Resampling.NEAREST)
    out = Image.new("RGBA", canvas, (0,0,0,0))
    if anchor_mode == "center":
        out.alpha_composite(im, ((w-im.width)//2, (h-im.height)//2))
        footpoint={"x":w//2,"y":h//2}
    else:
        out.alpha_composite(im, ((w-im.width)//2, h-im.height-4))
        footpoint={"x":foot[0],"y":foot[1]} if foot else None
    path = f"frames/{key}.png"
    out.save(ROOT / path)
    raw = Image.open(SHEETS / source).size
    sources[source] = {"file": f"sheets/{source}", "width": raw[0], "height": raw[1]}
    frames[key] = {
        "source": source, "sourceRect": {"x":roi[0],"y":roi[1],"w":roi[2]-roi[0],"h":roi[3]-roi[1]},
        "file": path, "canvasSize": {"w":w,"h":h},
        "footprint": list(footprint) if footprint else ([w/64,h/64] if key != "stable-east-gable" else None),
        "footPoint": None if key.startswith("rod-held") else footpoint,
        "handPoint": {"x":8,"y":h-4} if key.startswith("rod-held") else None,
        "alpha": True, "gutter": 4,
    }

def component_boxes(im: Image.Image, region: tuple[int,int,int,int], min_area: int = 30) -> list[tuple[int,int,int,int,int]]:
    """Connected alpha components on a 2px occupancy grid, returned by area."""
    x0,y0,x1,y1=region; step=2
    rw=x1-x0; rh=y1-y0; gw=(rw+step-1)//step; gh=(rh+step-1)//step
    alpha=im.getchannel("A"); ap=alpha.load(); mask=bytearray(gw*gh)
    for gy in range(gh):
        sy=y0+gy*step
        for gx in range(gw):
            sx=x0+gx*step
            if any(ap[x,y] for y in range(sy,min(y1,sy+step)) for x in range(sx,min(x1,sx+step))):
                mask[gy*gw+gx]=1
    seen=bytearray(len(mask)); found=[]
    for i,v in enumerate(mask):
        if not v or seen[i]: continue
        seen[i]=1; q=[i]; bx0=bx1=i%gw; by0=by1=i//gw; area=0
        while q:
            j=q.pop(); gx=j%gw; gy=j//gw; area+=1
            bx0=min(bx0,gx);bx1=max(bx1,gx);by0=min(by0,gy);by1=max(by1,gy)
            for dy in (-1,0,1):
                for dx in (-1,0,1):
                    nx=gx+dx;ny=gy+dy
                    if 0<=nx<gw and 0<=ny<gh:
                        ni=ny*gw+nx
                        if mask[ni] and not seen[ni]: seen[ni]=1;q.append(ni)
        if area>=min_area:
            found.append((area,(x0+bx0*step,y0+by0*step,min(x1,x0+(bx1+1)*step),min(y1,y0+(by1+1)*step))))
    return sorted(found,reverse=True)

def save_prepared(key: str, source: str, roi: tuple[int,int,int,int], image: Image.Image,
                  footprint, foot, frames: dict, sources: dict):
    image.save(ROOT/f"frames/{key}.png")
    raw=Image.open(SHEETS/source).size
    sources[source]={"file":f"sheets/{source}","width":raw[0],"height":raw[1]}
    w,h=image.size
    frames[key]={"source":source,"sourceRect":{"x":roi[0],"y":roi[1],"w":roi[2]-roi[0],"h":roi[3]-roi[1]},
      "file":f"frames/{key}.png","canvasSize":{"w":w,"h":h},"footprint":list(footprint) if footprint else None,
      "footPoint":{"x":foot[0],"y":foot[1]} if foot else None,"handPoint":None,"alpha":True,"gutter":0}

src = {
  "ability-icons.png": transparent_sheet("ability-icons.png"),
  "ability-effects.png": transparent_sheet("ability-effects.png"),
  "ability-effects-redraw.png": transparent_sheet("ability-effects-redraw.png"),
  "stable-atlas.png": transparent_sheet("stable-atlas.png"),
  "stable-continuous.png": transparent_sheet("stable-continuous.png"),
  "fishing-atlas.png": transparent_sheet("fishing-atlas.png"),
  "hud-icons.png": transparent_sheet("hud-icons.png"),
}
frames: dict = {}
sources: dict = {}
groups: dict = {}

abilities = [
 "warrior-cleave","warrior-heave","warrior-pin","warrior-stand","warrior-brace",
 "mage-fingersnap","mage-name-a-lamp","mage-read-route-stone","mage-kindle","mage-old-ways",
 "healer-mend","healer-mend-working","healer-settle","healer-ward-light","healer-mended-glade",
 "rogue-shadowstep","rogue-read-the-drift","rogue-walk-a-blind-route","rogue-echo","rogue-sense-the-turning",
]
aw,ah = src["ability-icons.png"].size
for i,key in enumerate(abilities):
    col,row=i%5,i//5
    x0=round(col*aw/5); x1=round((col+1)*aw/5)
    y0=round(row*ah/4); y1=round((row+1)*ah/4)
    save_frame(f"ability-{key}","ability-icons.png",(x0,y0,x1,y1),(64,64),None,(32,64),src,frames,sources)
groups["ability-icons"]={"frames":[f"ability-{k}" for k in abilities],"frameSize":[64,64],"columns":5,"rows":4}
groups["ability-palettes"]={"warrior":[f"ability-{k}" for k in abilities[:5]],"mage":[f"ability-{k}" for k in abilities[5:10]],"healer":[f"ability-{k}" for k in abilities[10:15]],"rogue":[f"ability-{k}" for k in abilities[15:20]]}

# Extract effect frame bounds from connected alpha components rather than
# pre-sized grid cells. Paired details that touch are grouped by their visual
# x-cluster; every frame is then centered on its fixed canvas.
effect_sources=[
 ("stand-ground-ring","ground-ring","ability-effects.png",(0,250,700,520),(128,64)),
 ("kindle-hollow-light","kindle","ability-effects-redraw.png",(0,200,1774,420),(192,128)),
 ("ward-light-circle","ward-light","ability-effects-redraw.png",(0,580,1774,810),(160,96)),
]
for prefix,group,source,region,size in effect_sources:
    comps=component_boxes(src[source],region,min_area=35)
    # Each strip has four dominant, disconnected effect silhouettes. Detached
    # sparkles are intentionally excluded from the frame bounding boxes.
    comps=sorted(comps[:4],key=lambda item:item[1][0])
    if len(comps)!=4: raise RuntimeError(f"{group}: expected four connected frame silhouettes, found {len(comps)}")
    keys=[]
    for i,(_,bbox) in enumerate(comps):
        pad=4; roi=(max(region[0],bbox[0]-pad),max(region[1],bbox[1]-pad),min(region[2],bbox[2]+pad),min(region[3],bbox[3]+pad))
        key=f"{prefix}-{i}"
        save_frame(key,source,roi,size,None,(size[0]//2,size[1]//2),src,frames,sources,anchor_mode="center")
        keys.append(key)
    groups[group]={"frames":keys,"frameSize":list(size),"fps":2,"footPoint":{"x":size[0]//2,"y":size[1]//2},"extraction":"largest connected alpha components, sorted left-to-right"}

# Stable art is one continuous source. Scale the whole sheet once, uniformly,
# to the requested 320-texel height; its width rounds to 671px, leaving the
# final east-cap texel transparent rather than stretching the art. Module cuts
# fall on shared post centerlines (4, 6, 8, and 10 tiles).
stable_source=src["stable-continuous.png"]
sw0,sh0=stable_source.size
scaled_w=round(sw0*320/sh0)
stable_scaled=stable_source.resize((scaled_w,320),Image.Resampling.NEAREST)
stable_line=Image.new("RGBA",(672,320),(0,0,0,0))
stable_line.alpha_composite(stable_scaled,(0,0))

def stable_source_rect(x0,x1):
    return (round(x0*sw0/scaled_w),0,round(x1*sw0/scaled_w),sh0)

def stable_save(key, roi, im, footprint):
    save_prepared(key,"stable-continuous.png",stable_source_rect(roi[0],roi[2]),im,footprint,(im.width//2,319),frames,sources)
    frames[key]["uniformScale"]={"numerator":320,"denominator":sh0}
    frames[key]["cutLineTexels"]=[roi[0],roi[2]]

for key,roi,fp in [
    ("stable-west-back",(0,0,256,320),[4,3]),
    ("stable-bay-back",(256,0,384,320),[2,3]),
    ("stable-east-gable",(640,0,672,320),None),
]:
    stable_save(key,roi,stable_line.crop(roi),fp)

def fill_stall_interior(back, base, door_cut_boxes, seed):
    """Replace source door slabs with a tiled back wall and straw floor."""
    import random
    rng=random.Random(seed)
    for x0,y0,x1,y1 in door_cut_boxes:
        ImageDraw.Draw(back).rectangle((x0,y0,x1-1,y1-1),fill=(0,0,0,0))
        # Reuse the same stall's exposed plank wall at native pixel scale.
        # Tile it vertically; no source pixels are stretched or resampled.
        wall=base.crop((x0,184,x1,216))
        for top in range(y0,min(y1,276),wall.height):
            part=wall.crop((0,0,wall.width,min(wall.height,min(y1,276)-top)))
            back.alpha_composite(part,(x0,top))
        # The lower opening is a dark timber floor with scattered straw. The
        # palette is sampled from the adjacent stable planks and thatch.
        floor_top=min(276,y1)
        floor_bottom=min(300,y1)
        if floor_bottom>floor_top:
            floor=Image.new("RGBA",(x1-x0,floor_bottom-floor_top),(76,49,27,255))
            fd=ImageDraw.Draw(floor)
            for yy in range(0,floor.height,5):
                col=(87,57,31,255) if yy%2 else (66,42,24,255)
                fd.line((0,yy,floor.width-1,yy),fill=col,width=1)
            straw=[(160,126,57,255),(187,150,72,255),(129,101,48,255),(203,168,83,255)]
            for _ in range(max(18,floor.width//2)):
                x=rng.randrange(floor.width); y=rng.randrange(floor.height)
                length=rng.choice((1,2,3))
                fd.line((x,y,min(floor.width-1,x+length),y),fill=rng.choice(straw),width=1)
            back.alpha_composite(floor,(x0,floor_top))
        # Assert the inpaint fully covers the original building silhouette.
        before=base.getchannel("A").load(); after=back.getchannel("A").load()
        for y in range(y0,y1):
            for x in range(x0,x1):
                if before[x,y] and not after[x,y]:
                    raise RuntimeError(f"stable interior alpha hole at {x},{y}")

def make_stable_layers(key, roi, door_boxes, door_cut_boxes, post_boxes, foot_boxes, footprint, post_slices=None, foot_slices=None):
    base=stable_line.crop(roi)
    back=base.copy()
    fill_stall_interior(back,base,door_cut_boxes,seed=roi[0]+17)
    # Posts and foot stones remain in the complete back layer. The front may
    # draw them again to keep the front plane crisp over a mount.
    front_shut=Image.new("RGBA",base.size,(0,0,0,0))
    front_open=Image.new("RGBA",base.size,(0,0,0,0))
    for box in (post_slices if post_slices is not None else [(box,(box[0],box[1])) for box in post_boxes])+ (foot_slices if foot_slices is not None else [(box,(box[0],box[1])) for box in foot_boxes]):
        crop_box,dest=box
        part=base.crop(crop_box)
        front_shut.alpha_composite(part,dest)
        front_open.alpha_composite(part,dest)
    for box in door_boxes:
        part=base.crop(box)
        front_shut.alpha_composite(part,(box[0],box[1]))
    # Every original opaque pixel in the module outline must remain opaque.
    before=base.getchannel("A").load(); after=back.getchannel("A").load()
    for y in range(base.height):
        for x in range(base.width):
            if before[x,y] and not after[x,y]:
                raise RuntimeError(f"{key}: back-layer alpha hole at {x},{y}")
    for suffix,im in (("back",back),("front-shut",front_shut),("front-open",front_open)):
        stable_save(f"{key}-{suffix}",roi,im,footprint)

# Half doors are chest-height (44 texels). Posts and stone feet straddle
# module cuts as half-posts, so adjoining pieces form one post, not two.
make_stable_layers("stable-west",(0,0,256,320),[(136,256,239,299)],[(136,218,239,300)],
 [(0,138,14,302),(119,138,137,302),(239,138,256,302)],[(0,302,14,320),(119,302,137,320),(239,302,256,320)],[4,3])
make_stable_layers("stable-bay",(256,0,384,320),[(17,256,111,299)],[(17,218,111,300)],
 [(0,138,14,302),(111,138,128,302)],[(0,302,14,320),(111,302,128,320)],[2,3],
 post_slices=[((4,138,10,302),(0,138)),((115,138,121,302),(122,138))],
 foot_slices=[((4,302,10,320),(0,302)),((115,302,121,320),(122,302))])
stable_names=["stable-west-back","stable-west-front-shut","stable-west-front-open","stable-bay-back","stable-bay-front-shut","stable-bay-front-open","stable-east-gable"]
groups["stable-layers"]={"frames":stable_names,"frameSize":"per-frame canvas in manifest","frontDoorStates":["stable-bay-front-shut","stable-bay-front-open"],"repeatsEast":True,"moduleWidthsTexels":[256,128,32],"cutLines":"shared post centerlines at 0, 256, 384, 512, 640, 672","sourceScale":"uniform to 320 texel height","previews":["stable-preview-1-bay.png","stable-preview-5-bays.png"],"backLayerAlpha":"opaque wherever the continuous source silhouette is opaque","interiorFill":"native-scale plank texture with straw-detailed timber floor","previewBackground":"#707070"}

# Fishing atlas regions, then equal subdivisions for strip families.
fishing_rois={
 "rod-icon":(15,30,350,330), "rod-held-raised":(350,0,670,335), "rod-held-out":(670,60,1090,330),
 "mill-roach":(1570,300,1980,530), "millers-fry":(600,520,1020,790), "recipe-card-millers-fry":(1035,520,1430,790),
}
for key,roi in fishing_rois.items():
    canvas=(128,128) if key.startswith("rod-held") else (64,64)
    save_frame(key,"fishing-atlas.png",roi,canvas,None,(canvas[0]//2,canvas[1]-4),src,frames,sources)

strip_specs=[
 ("float",(32,32),[(1100,100,1225,285),(1225,100,1350,285),(1350,100,1475,285),(1475,100,1600,285),(1600,100,1725,285),(1725,100,1850,285)]),
 ("water-rings",(64,32),[(0,335,230,515),(230,335,460,515),(460,335,700,515)]),
 ("landing-splash",(64,64),[(700,335,880,515),(880,335,1060,515),(1060,335,1240,515),(1240,335,1430,515)]),
]
for group,size,rois in strip_specs:
    keys=[]
    for i,roi in enumerate(rois):
        key=f"{group}-{i}"
        save_frame(key,"fishing-atlas.png",roi,size,None,(size[0]//2,size[1]-4),src,frames,sources)
        keys.append(key)
    groups[group]={"frames":keys,"frameSize":list(size),"fps":2,"anchor":"center-bottom"}
groups["rod-held"]={"frames":["rod-held-raised","rod-held-out"],"frameSize":[128,128],"anchor":"hand"}
groups["fishing-icons"]={"frames":["rod-icon","mill-roach","millers-fry","recipe-card-millers-fry"]}

# HUD source is a four-column/two-row composition; use the three paw/saddle/home
# symbols from the top and three hearts from the remaining cells.
hw,hh=src["hud-icons.png"].size
hud_rois={"companions-tab":(0,0,hw//4,hh//2),"saddle":(hw//4,0,hw//2,hh//2),"go-home":(hw//2,0,3*hw//4,hh//2),
          "pet-heart-0":(3*hw//4,0,hw,hh//2),"pet-heart-1":(60,hh//2,420,hh),"pet-heart-2":(460,hh//2,860,hh)}
for key,roi in hud_rois.items():
    size=(32,32) if key.startswith("pet-heart") else (64,64)
    save_frame(key,"hud-icons.png",roi,size,None,(size[0]//2,size[1]-4),src,frames,sources)
groups["pet-heart"]={"frames":["pet-heart-0","pet-heart-1","pet-heart-2"],"frameSize":[32,32],"fps":3,"direction":"rising"}
groups["hud-icons"]={"frames":["companions-tab","saddle","go-home"]}

manifest={"id":"glimway-crafts-pass","date":"2026-10-09","density":64,"tool":"built-in image_gen","frames":frames,"groups":groups,
          "codeDrawn":["echo","lead-rope","yard-pet-nap-z","placement-ghost"],
          "shipsIn05":["ability-warrior-cleave","ability-warrior-stand","ability-mage-fingersnap","ability-mage-kindle","ability-healer-mend","ability-healer-ward-light","ability-rogue-shadowstep","ability-rogue-echo"]}
(ROOT/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
atlas={"date":"2026-10-09","sources":[{"key":k,**v} for k,v in sources.items()],"frames":{k:{"file":v["file"],"source":v["source"],"sourceRect":v["sourceRect"],"canvasSize":v["canvasSize"],"footprint":v["footprint"],"footPoint":v["footPoint"],"handPoint":v["handPoint"],**({"uniformScale":v["uniformScale"],"cutLineTexels":v["cutLineTexels"]} if "uniformScale" in v else {})} for k,v in frames.items()}}
(ROOT/"atlas.json").write_text(json.dumps(atlas,indent=2)+"\n")

# Two stable review composites: a single bay and five repeated bays. Both
def frame(name): return Image.open(ROOT/frames[name]["file"]).convert("RGBA")

# show one open bay with a mount-sized placeholder; all art is placed at native
# texel scale, with no resampling.
def make_placeholder():
    placeholder=Image.new("RGBA",(97,82),(0,0,0,0)); ph=ImageDraw.Draw(placeholder)
    ph.ellipse((7,31,74,69),fill=(104,145,151,220),outline=(42,56,60,255),width=2)
    ph.ellipse((60,14,86,42),fill=(121,163,166,220),outline=(42,56,60,255),width=2)
    ph.polygon([(76,18),(92,25),(80,31)],fill=(121,163,166,220),outline=(42,56,60,255))
    ph.line((22,59,18,80,27,80),fill=(42,56,60,255),width=4)
    ph.line((59,59,61,80,70,80),fill=(42,56,60,255),width=4)
    return placeholder
placeholder=make_placeholder()
def stable_preview(bays, open_index, filename):
    width=256+bays*128+32
    canvas=Image.new("RGBA",(width,320),(112,112,112,255))
    canvas.alpha_composite(frame("stable-west-back"),(0,0))
    for i in range(bays):
        x=256+i*128
        canvas.alpha_composite(frame("stable-bay-back"),(x,0))
    canvas.alpha_composite(frame("stable-east-gable"),(width-32,0))
    if 0 <= open_index < bays:
        x=256+open_index*128
        canvas.alpha_composite(placeholder,(x+15,320-84))
    canvas.alpha_composite(frame("stable-west-front-shut"),(0,0))
    for i in range(bays):
        x=256+i*128
        front="stable-bay-front-open" if i==open_index else "stable-bay-front-shut"
        canvas.alpha_composite(frame(front),(x,0))
    canvas.save(ROOT/filename)
    return canvas

preview_one=stable_preview(1,0,"stable-preview-1-bay.png")
preview_five=stable_preview(5,2,"stable-preview-5-bays.png")
preview_five.save(ROOT/"stable-composite-preview.png")

# Contact sheet for all normalized frames, followed by both stable composites.
keys=list(frames); cell=132; cols=8; rows=(len(keys)+cols-1)//cols
sheet=Image.new("RGB",(1116,rows*cell+1020),(71,66,57)); sd=ImageDraw.Draw(sheet)
for i,key in enumerate(keys):
    x=(i%cols)*cell; y=(i//cols)*cell
    im=frame(key); im.thumbnail((96,96),Image.Resampling.NEAREST)
    sheet.paste(im,(x+(cell-im.width)//2,y+4),im)
    sd.text((x+3,y+104),key[:22],fill=(255,242,211))
base_y=rows*cell+8
sd.text((12,base_y),"Stable preview — west + 1 bay + east cap; open bay with mount placeholder",fill=(255,242,211))
small=preview_one.resize((624,480),Image.Resampling.NEAREST)
sheet.paste(small,(12,base_y+20),small)
sd.text((12,base_y+520),"Stable preview — west + 5 bays + east cap; one open bay with mount placeholder",fill=(255,242,211))
large=preview_five.resize((1116,480),Image.Resampling.NEAREST)
sheet.paste(large,(12,base_y+540),large)
sheet.save(ROOT/"contact-sheet.png")
