#!/usr/bin/env python3
"""Crop the built-in image_gen production sheets into Hearthwick 2 frames."""
from __future__ import annotations

import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).parent
SHEETS = ROOT / "sheets"
FRAMES = ROOT / "frames"
FRAMES.mkdir(exist_ok=True)

# key, sheet key, filename, grid columns, grid rows, cell column, cell row,
# native output canvas (texture pixels), world footprint, role
JOBS = []
def job(key, sheet, filename, grid, cell, canvas, footprint, role="prop"):
    cols, rows = grid
    col, row = cell
    JOBS.append({"key":key,"source":sheet,"grid":{"cols":cols,"rows":rows},
                 "sheet_file":filename,"cell":{"col":col,"row":row},"canvas":canvas,
                 "footprint":footprint,"role":role})

# Four seasonal versions of the same Wilds-style square tree.
for key, cell in zip(("wick-tree-mudrise","wick-tree-carting","wick-tree-amberfall","wick-tree-quiet"),
                     ((0,0),(1,0),(0,1),(1,1))):
    job(key,"wick-trees-source","generated-wick-trees.png",(2,2),cell,(512,576),(2,1),"natural-tree")

# The 4x2 facade sheet: top row has three townhouses and cottage A; second row
# has cottage B/C, the inn and barn. All portraits face south, square to grid.
building1=[
 ("townhouse-a",(0,0),(256,384),(4,4)),("townhouse-b",(1,0),(256,384),(4,4)),
 ("townhouse-c",(2,0),(256,384),(4,4)),("cottage-a",(3,0),(320,384),(5,4)),
 ("cottage-b",(0,1),(320,384),(5,4)),("cottage-c",(1,1),(320,384),(5,4)),
 ("inn",(2,1),(512,448),(8,5)),("barn",(3,1),(512,448),(8,5))]
for key,cell,canvas,foot in building1:
    job(key,"houses-main-source","generated-houses-1.png",(4,2),cell,canvas,foot,"building")

building2=[("chandler",(0,0),(256,384),(4,4)),("land-office",(1,0),(320,384),(5,4)),
 ("smithy",(2,0),(384,384),(6,4)),("guildhouse",(0,1),(448,384),(7,4)),
 ("workshop-orrin",(1,1),(320,384),(5,4))]
for key,cell,canvas,foot in building2:
    job(key,"houses-trades-source","generated-houses-2.png",(3,2),cell,canvas,foot,"building")

# The generated building sheet lets several facades spill across its nominal
# cell dividers. Use the measured alpha bounds plus transparent padding for the
# affected source crops. The inn extends left across its cell divider; Orrin's
# workshop extends right into the empty cell. These rectangles isolate each
# facade and keep the complete inn/workshop silhouettes.
BUILDING_CROP_RECTS = {
 "cottage-a":(1088,132,1516,500),
 "cottage-b":(4,584,352,948),
 "cottage-c":(348,584,708,948),
 "inn":(684,532,1144,952),
 "chandler":(0,32,480,508),
 "land-office":(476,56,964,508),
 "smithy":(968,12,1536,516),
 "workshop-orrin":(648,512,1172,992),
 # The Wilds sheet's second row holds three 512-px cells, not four: on the
 # 4-column grid the bed and the two spring frames took slices of their
 # neighbours, and the row starts below the trees' grass (H5).
 "allotment-bed":(0,560,512,1024),
 "spring-stones-0":(512,560,1024,1024),
 "spring-stones-1":(1024,560,1536,1024),
}

# Hearth, forge glow, washing-line loop, stakes, gatepost and Wildgate arch.
lot_jobs=[
 ("hearth-stone-0",(0,0),(128,96),(2,1),"animated-prop"),
 ("hearth-stone-1",(1,0),(128,96),(2,1),"animated-prop"),
 ("hearth-stone-2",(2,0),(128,96),(2,1),"animated-prop"),
 ("forge-glow-0",(3,0),(128,96),(0,0),"animation-overlay"),
 ("forge-glow-1",(0,1),(128,96),(0,0),"animation-overlay"),
 ("forge-glow-2",(1,1),(128,96),(0,0),"animation-overlay"),
 ("washing-line-0",(2,1),(192,96),(3,1),"animated-prop"),
 ("washing-line-1",(3,1),(192,96),(3,1),"animated-prop"),
 ("lantern-stake-0",(0,2),(64,96),(1,1),"lot-prop"),
 ("lantern-stake-1",(1,2),(64,96),(1,1),"lot-prop"),
 ("lot-gatepost-side",(2,2),(56,176),(1,1),"lot-prop"),
 ("wildgate-arch",(3,2),(160,192),(2,1),"edge-prop")]
for key,cell,canvas,foot,role in lot_jobs:
    job(key,"lot-pieces-source","generated-lot-animated.png",(4,3),cell,canvas,foot,role)

# Shop signs, stacked goods, cart, trough, haystack, scarecrow.
town_jobs=[
 ("shop-sign-bread",(0,0),(48,48),(0,0),"sign"),
 ("shop-sign-mug",(1,0),(48,48),(0,0),"sign"),
 ("shop-sign-candle",(2,0),(48,48),(0,0),"sign"),
 ("shop-sign-scroll",(0,1),(48,48),(0,0),"sign"),
 ("shop-sign-wheel",(1,1),(48,48),(0,0),"sign"),
 ("barrel",(2,1),(64,80),(1,1),"prop"),
 ("crate-stack",(3,1),(64,80),(1,1),"prop"),
 ("sack-pile",(0,2),(64,80),(1,1),"prop"),
 ("handcart",(1,2),(128,96),(2,1),"prop"),
 ("water-trough",(2,2),(128,80),(2,1),"prop"),
 ("haystack",(0,3),(128,128),(2,2),"natural-farm-prop"),
 ("scarecrow",(1,3),(64,128),(1,1),"farm-prop")]
for key,cell,canvas,foot,role in town_jobs:
    job(key,"town-props-source","generated-town-props.png",(4,4),cell,canvas,foot,role)
job("shop-sign-anvil","anvil-sign-source","generated-anvil-sign.png",(1,1),(0,0),(48,48),(0,0),"sign")

# Small Wilds-style fruit trees, allotment and two spring ripple frames.
wild_jobs=[
 ("fruit-tree-mudrise",(0,0),(128,160),(1,1),"natural-tree"),
 ("fruit-tree-carting",(1,0),(128,160),(1,1),"natural-tree"),
 ("fruit-tree-amberfall",(2,0),(128,160),(1,1),"natural-tree"),
 ("fruit-tree-quiet",(3,0),(128,160),(1,1),"natural-tree"),
 ("allotment-bed",(0,1),(128,64),(2,1),"natural-farm-prop"),
 ("spring-stones-0",(1,1),(128,128),(2,2),"natural-water"),
 ("spring-stones-1",(2,1),(128,128),(2,2),"natural-water")]
for key,cell,canvas,foot,role in wild_jobs:
    job(key,"wilds-small-source","generated-wilds-small.png",(4,2),cell,canvas,foot,role)

SOURCES = [
 {"key":"wick-trees-source","file":"sheets/generated-wick-trees.png"},
 {"key":"houses-main-source","file":"sheets/generated-houses-1.png"},
 {"key":"houses-trades-source","file":"sheets/generated-houses-2.png"},
 {"key":"lot-pieces-source","file":"sheets/generated-lot-animated.png"},
 {"key":"town-props-source","file":"sheets/generated-town-props.png"},
 {"key":"anvil-sign-source","file":"sheets/generated-anvil-sign.png"},
 {"key":"wilds-small-source","file":"sheets/generated-wilds-small.png"},
]

def clean_alpha(im: Image.Image) -> Image.Image:
    """Remove antialias fringe and the isolated saturated red generation artifact."""
    im=im.convert("RGBA")
    pixels=im.load()
    for y in range(im.height):
        for x in range(im.width):
            r,g,b,a=pixels[x,y]
            if a<128 or (r>220 and g<38 and b<48):
                pixels[x,y]=(r,g,b,0)
            elif a:
                pixels[x,y]=(r,g,b,255)
    return im

def opaque_components(im: Image.Image):
    """Return 8-connected opaque pixel components with their bounds."""
    alpha=im.getchannel("A")
    w,h=im.size; count=w*h
    mask=bytearray(1 if value else 0 for value in alpha.tobytes())
    seen=bytearray(count); comps=[]
    for start,value in enumerate(mask):
        if not value or seen[start]:
            continue
        seen[start]=1; stack=[start]; pixels=[]
        minx=maxx=start%w; miny=maxy=start//w
        while stack:
            pos=stack.pop(); pixels.append(pos)
            x=pos%w; y=pos//w
            if x<minx:minx=x
            if x>maxx:maxx=x
            if y<miny:miny=y
            if y>maxy:maxy=y
            for yy in range(max(0,y-1),min(h,y+2)):
                row=yy*w
                for xx in range(max(0,x-1),min(w,x+2)):
                    n=row+xx
                    if mask[n] and not seen[n]:
                        seen[n]=1; stack.append(n)
        comps.append({"pixels":pixels,"bbox":(minx,miny,maxx+1,maxy+1)})
    return comps

def keep_main_and_nearby(im: Image.Image, radius: int=8) -> Image.Image:
    """Keep the dominant object and small nearby islands such as attached signs."""
    im=clean_alpha(im)
    components=opaque_components(im)
    if not components:
        raise ValueError("generated building crop is empty")
    main=max(components,key=lambda c:len(c["pixels"]))
    w,h=im.size
    main_data=bytearray(w*h)
    for pos in main["pixels"]: main_data[pos]=255
    near=Image.frombytes("L",(w,h),bytes(main_data)).filter(ImageFilter.MaxFilter(radius*2+1)).tobytes()
    # The main silhouette wins outright. Keep small, close details but reject
    # nearby chunks of another facade and any island still clipped by the crop.
    area_limit=max(500,int(len(main["pixels"])*0.15))
    keep=bytearray(w*h)
    for component in components:
        pixels=component["pixels"]
        if component is not main:
            x0,y0,x1,y1=component["bbox"]
            touches_crop_edge=(x0<=8 or x1>=w-8)
            is_near=any(near[pos] for pos in pixels)
            if len(pixels)>area_limit or not is_near or touches_crop_edge:
                continue
        for pos in pixels: keep[pos]=1
    px=im.load()
    for pos,value in enumerate(keep):
        if not value:
            x=pos%w; y=pos//w
            r,g,b,_=px[x,y]; px[x,y]=(r,g,b,0)
    return im

def crop_building(src: Image.Image, initial_rect: tuple[int,int,int,int]):
    """Expand horizontally until the main facade has transparent crop margins."""
    x0,y0,x1,y1=initial_rect
    for _ in range(12):
        cropped=clean_alpha(src.crop((x0,y0,x1,y1)))
        components=opaque_components(cropped)
        if not components:
            raise ValueError("generated building crop is empty")
        main=max(components,key=lambda c:len(c["pixels"]))
        bx0,_,bx1,_=main["bbox"]
        grow_left=bx0==0 and x0>0
        grow_right=bx1==cropped.width and x1<src.width
        if not grow_left and not grow_right:
            return keep_main_and_nearby(cropped),(x0,y0,x1,y1)
        if grow_left: x0=max(0,x0-64)
        if grow_right: x1=min(src.width,x1+64)
    raise ValueError("could not find transparent horizontal margins around building")

def quantized_nearest(panel: Image.Image, canvas: tuple[int,int]):
    """Trim, fit, quantize, and enlarge in nearest-neighbor blocks."""
    panel=clean_alpha(panel)
    bbox=panel.getchannel("A").getbbox()
    if not bbox:
        raise ValueError("generated source crop is empty")
    panel=panel.crop(bbox)
    cw,ch=canvas
    # Generated sheets are contact layouts; keep the silhouettes large while
    # leaving a few native texels of transparent breathing room.
    scale=min((cw-8)/panel.width,(ch-8)/panel.height)
    dw=max(1,round(panel.width*scale)); dh=max(1,round(panel.height*scale))
    dx=(cw-dw)//2; dy=ch-dh
    # Render at half resolution to enforce the requested chunky coarseness.
    sw=max(1,dw//2); sh=max(1,dh//2)
    small=panel.resize((sw,sh),Image.Resampling.BOX)
    alpha=small.getchannel("A").point(lambda a:255 if a>=128 else 0)
    rgb=Image.new("RGB",small.size,(0,0,0)); rgb.paste(small.convert("RGB"))
    rgb=rgb.quantize(colors=32,method=Image.Quantize.MEDIANCUT,dither=Image.Dither.NONE).convert("RGB")
    # Normalize the deepest line pixels to the house-style warm-brown ink.
    px=rgb.load()
    for y in range(rgb.height):
        for x in range(rgb.width):
            r,g,b=px[x,y]
            if r<62 and g<44 and b<39:
                px[x,y]=(58,42,40)
    small=rgb.convert("RGBA"); small.putalpha(alpha)
    scaled=small.resize((dw,dh),Image.Resampling.NEAREST)
    out=Image.new("RGBA",canvas,(0,0,0,0)); out.alpha_composite(scaled,(dx,dy))
    return out,{"x":dx,"y":dy,"w":dw,"h":dh}

def main():
    source_images={s["key"]:Image.open(ROOT/s["file"]).convert("RGBA") for s in SOURCES}
    frames=[]
    for spec in JOBS:
        src=source_images[spec["source"]]
        cols,rows=spec["grid"]["cols"],spec["grid"]["rows"]
        col,row=spec["cell"]["col"],spec["cell"]["row"]
        x0=round(col*src.width/cols); x1=round((col+1)*src.width/cols)
        y0=round(row*src.height/rows); y1=round((row+1)*src.height/rows)
        if spec["key"] in BUILDING_CROP_RECTS:
            x0,y0,x1,y1=BUILDING_CROP_RECTS[spec["key"]]
        if spec["role"]=="building":
            panel,(x0,y0,x1,y1)=crop_building(src,(x0,y0,x1,y1))
        else:
            panel=src.crop((x0,y0,x1,y1))
        source_rect={"x":x0,"y":y0,"w":x1-x0,"h":y1-y0}
        image,dest=quantized_nearest(panel,tuple(spec["canvas"]))
        alpha=image.getchannel("A")
        if any(alpha.getpixel((x,y)) for x in (0,image.width-1) for y in range(image.height)):
            raise ValueError(f"{spec['key']}: opaque pixels touch a horizontal frame edge")
        filename=f"{spec['key']}.png"; image.save(FRAMES/filename)
        cw,ch=spec["canvas"]
        frames.append({"key":spec["key"],"source":spec["source"],"sourceRect":source_rect,
          "canvasSize":{"w":cw,"h":ch},"destinationRect":dest,
          "footprint":spec["footprint"],"footPoint":{"x":cw//2,"y":ch},
          "origin":[0.5,1],"role":spec["role"],"file":f"frames/{filename}"})
    animations=[
      {"key":"hearth-stone-embers","frames":[f"hearth-stone-{i}" for i in range(3)],"frameRate":3,"repeat":-1},
      {"key":"forge-glow","frames":[f"forge-glow-{i}" for i in range(3)],"frameRate":6,"repeat":-1},
      {"key":"washing-line-sway","frames":["washing-line-0","washing-line-1"],"frameRate":1.5,"repeat":-1},
      {"key":"spring-ripple","frames":["spring-stones-0","spring-stones-1"],"frameRate":2,"repeat":-1},
    ]
    manifest={"id":"hearthwick2-pass","date":"2026-10-15","tool":"built-in image_gen + Pillow crop/quantize builder",
      "density":64,"sources":SOURCES,"frames":frames,"animations":animations,
      "notes":["Source sheets are preserved at full generated resolution.",
               "Frame crops are alpha-trimmed and reduced to 32 colors with nearest-neighbor 2x texel blocks.",
               "Every sprite foot point is at the bottom centre of its native transparent canvas."]}
    (ROOT/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")

    # Labeled checker contact sheet at a readable review size.
    cols=4; cardw=560; cardh=620; rows=(len(frames)+cols-1)//cols
    sheet=Image.new("RGB",(cols*cardw,rows*cardh),(47,43,40)); draw=ImageDraw.Draw(sheet); font=ImageFont.load_default()
    for i,f in enumerate(frames):
        x=(i%cols)*cardw; y=(i//cols)*cardh
        draw.text((x+8,y+6),f["key"],fill=(244,232,208),font=font)
        im=Image.open(ROOT/f["file"]).convert("RGBA")
        scale=min((cardw-24)/im.width,(cardh-34)/im.height,1)
        if scale<1: im=im.resize((max(1,round(im.width*scale)),max(1,round(im.height*scale))),Image.Resampling.NEAREST)
        ox=x+(cardw-im.width)//2; oy=y+24+(cardh-32-im.height)//2
        for yy in range(oy,oy+im.height,16):
            for xx in range(ox,ox+im.width,16):
                color=(81,75,69) if ((xx-ox)//16+(yy-oy)//16)%2 else (62,58,54)
                draw.rectangle((xx,yy,min(xx+15,ox+im.width-1),min(yy+15,oy+im.height-1)),fill=color)
        sheet.paste(im,(ox,oy),im)
    sheet.save(ROOT/"contact-sheet.png")
    print(f"built {len(frames)} generated frames from {len(SOURCES)} source sheets")

if __name__=="__main__": main()
