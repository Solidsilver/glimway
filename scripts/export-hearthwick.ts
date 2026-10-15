/** Reproducible H1 blockout: docs/design/hearthwick-2.md and hearthwick-2-sketch.py. */
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import type { LayoutObject } from '../src/lib/gen/glimway/content/v1/layout_pb.ts';
import { homeEntrance, lotLayout, lotService } from '../src/lib/lots.ts';
type ObjectData = Omit<Partial<LayoutObject>, '$typeName'>;
const rules = (rest: string, ride = true) => ({ safe: true, ride, sync: true, rest });
const tile = (tx: number, ty: number) => ({ tx, ty });
const origin = tile(-24, 24);
const anchors: { id: string; tx: number; ty: number }[] = [];
for (const [id,x,y] of [
 ['spawn',5,60],['well',9,65],['arch',2,26],['east-road',39,60],
 ['south-gate',12,116],['west-wildgate',-23,71],['east-wildgate',46,71],
 ['bakery-door',6,54],['library-door',0,66],['yard-door',-14,104],['mill-door',21,104],['land-office-door',23,59],
] as const) anchors.push({ id, tx:x-origin.tx, ty:y-origin.ty });
for(let g=0;g<8;g++){const a=homeEntrance(g);anchors.push({id:`lot:${g}`,tx:a.tx-origin.tx,ty:a.ty-origin.ty});}
const places = {
 fixed: [
 {id:'hearthwick',name:'Hearthwick',kind:'layout',layout:'hearthwick',revision:2,origin,cx:-1,cy:1,width:3,height:4,rules:rules('village'),zones:[{id:'town-walk',place:'hearthwick',tx:18,ty:18,w:38,h:38,rules:rules('village',false)}],anchors},
 ...(['west','east'] as const).map((side,i)=>({id:`lots-${side}`,name:`${side==='west'?'West':'East'} Row`,kind:'plots',layout:`lots-${side}`,revision:3,origin:tile(i?48:-48,24),cx:i?2:-2,cy:1,width:1,height:4,rules:rules('home'),zones:Array.from({length:4},(_,row)=>({id:`lot-${row*2+i}`,place:`lot:${row*2+i}`,tx:0,ty:row*24,w:24,h:24,rules:rules('home')})),anchors:[]})),
 ],generated:{safe:false,ride:true,sync:false,rest:'none'},spaces:{woodland:{safe:false,ride:true,sync:false,rest:'none'},ruin:{safe:false,ride:true,sync:false,rest:'none'}},
};
// Curated wire IDs map to painter categories in H3 (src/game/wilds/fixed-ground.ts): meadow, woods, trodden,
// road, paving, cobble, tilled fields, water.
const palette = {'.':'grass_a', ',':'grass_b', ':':'path_a', '-':'path_b', '=':'cobble', '+':'stone_a', 't':'dirt', 'f':'tilled', '~':'water_b'};
const ground=Array.from({length:96},()=>Array<string>(72).fill('.'));
const solid=Array.from({length:96},()=>Array<string>(72).fill('.'));
const objects:ObjectData[]=[];
function rect(x0: number, y0: number, x1: number, y1: number, char: string, blocks = false): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    ground[y - 24]![x + 24] = char; solid[y - 24]![x + 24] = blocks ? '#' : '.';
  }
}
function object(id: string, kind: string, x: number, y: number, extra: ObjectData = {}): void {
  objects.push({ id, kind, tx: x + 24, ty: y - 24, ...(['scenery', 'well', 'board'].includes(kind) ? { art: { ox: 8, oy: 16 } as LayoutObject['art'] } : {}), ...extra });
}
function prop(id: string, variant: string, x: number, y: number, h = 24, light = ''): void {
  object(id, light ? 'lamp' : 'prop', x, y, { variant, prop: { h, bodyW: 10, bodyH: 6, light } as LayoutObject['prop'] });
  solid[y - 24]![x + 24] = '#';
}
function piece(id: string, variant: string, x: number, y: number): void {
  object(id, 'scenery', x, y, { variant });
  solid[y - 24]![x + 24] = '#';
}
function fence(x0: number, y0: number, x1: number, y1: number): void {
  rect(x0, y0, x1, y1, '.', true);
  object(`fence:${x0},${y0}`, 'scenery', x0, y1, { variant: x0 === x1 ? `fence-v-${y1 - y0 + 1}` : `fence-h-${x1 - x0 + 1}`, art: { ox: 0, oy: 16, originLeft: true } as LayoutObject['art'] });
}
function hedge(x0: number, y0: number, x1: number, y1: number): void {
  rect(x0, y0, x1, y1, '.', true);
  object(`hedge:${x0},${y0}`, 'scenery', x0, y1, { variant: x0 === x1 ? `hedge-v-${y1 - y0 + 1}` : `hedge-h-${x1 - x0 + 1}`, art: { ox: 0, oy: 16, originLeft: true } as LayoutObject['art'] });
}
function house(id: string, variant: string, x: number, y: number, w: number, doorX: number, windowX?: number): void {
  rect(x, y, x + w - 1, y + 1, '.', true);
  rect(x, y + 2, x + w - 1, y + 3, '.', true);
  rect(doorX, y + 3, doorX, y + 3, '.', true);
  if (windowX !== undefined) rect(windowX, y + 2, windowX, y + 2, '.', true);
  object(id, 'scenery', x, y + 3, { variant, tw: w, th: 4, art: { ox: w * 8, oy: 16 } as LayoutObject['art'] });
}
// Ring, square, spokes and lanes, world tiles. The sketch's block-local frame is (+48,-24).
rect(-24,24,47,24,',',true);rect(-24,119,47,119,',',true);
for(let y=24;y<120;y++)for(let x=-21;x<=44;x++){
 const dx=x-12,dy=y-60,n=(dx**4+dy**4)**.25;
 if(n>=16.5&&n<18.5)rect(x,y,x,y,'-');
 if(Math.hypot(x-12.5,y-60.5)<=8)rect(x,y,x,y,'+');
}
rect(-24,25,-22,119,'-');rect(45,25,47,119,'-');
rect(11,34,13,53,'=');for(let i=0;i<9;i++)rect(10-i,33-i,12-i,34-i,i>4?':':i>1?'-':'=');rect(1,24,3,25,':');
rect(-21,59,5,61,'=');rect(19,59,44,61,'=');rect(11,67,13,119,'=');
rect(-21,49,-6,50,'-');rect(29,49,44,50,'-');rect(-21,85,44,86,'-');
for(const [ax,ay,bx,by] of [[5,54,-1,48],[20,54,26,48],[5,67,-1,73],[20,67,26,73]])for(let i=0;i<=6;i++)rect(ax!+Math.sign(bx!-ax!)*i,ay!+Math.sign(by!-ay!)*i,ax!+Math.sign(bx!-ax!)*i,ay!+Math.sign(by!-ay!)*i,':');
// The buildings with existing art.
house('house-west','p1:house-west',3,50,6,6);
house('library','commons-art:hearthwick-library',-2,62,5,0);
house('house-ada','p1:house-ada',-18,44,6,-14,-15);
house('house-middle','p1:house-middle',-18,71,7,-15);
house('mill','mill-house',20,100,4,21);
// The Hearthwick 2 pass (assets/generated/hearthwick2-pass, src/game/hearthwick2-art.ts): a building's solid
// footprint stands on grass with its facade on the foot row and the roof two tiles above, as house() does.
function building(id: string, art: string, x: number, y: number, w: number, h = 4): void {
  rect(x, y, x + w - 1, y + h - 1, '.', true);
  object(id, 'scenery', x, y + h - 1, { variant: `hw2:${art}`, tw: w, th: h, art: { ox: w * 8, oy: 16 } as LayoutObject['art'] });
}
/** A piece hung on or laid over a facade (a shop sign, the forge's glow): px from its foot-row tile, just in front of it. */
function overlay(id: string, art: string, x: number, footY: number, ox: number, oy: number): void {
  object(id, 'scenery', x, footY, { variant: `hw2:${art}`, art: { ox, oy, depth: (footY + 1) * 16 + 1 } as LayoutObject['art'] });
}
/** A dressing piece on its foot row, `w` tiles wide and `d` deep, solid unless walked through. */
function deco(id: string, art: string, x: number, y: number, w = 1, d = 1, blocks = true, extra: ObjectData = {}): void {
  object(id, 'scenery', x, y, { variant: art.includes(':') ? art : `hw2:${art}`, art: { ox: w * 8, oy: 16 } as LayoutObject['art'], ...extra });
  if (blocks) for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) solid[y - j - 24]![x + i + 24] = '#';
}
/** A natural piece that follows the year: one picture a Mark, out while the calendar is in it. */
function seasonal(id: string, art: string, x: number, y: number, w = 1): void {
  for (const mark of ['Mudrise', 'Carting', 'Amberfall', 'Quiet']) object(`${id}:${mark.toLowerCase()}`, 'scenery', x, y, { variant: `hw2:${art}-${mark.toLowerCase()}`, festival: mark, art: { ox: w * 8, oy: 16 } as LayoutObject['art'] });
}
// Silas's farmhouse (round 3): 5 wide, its door on its middle tile, the farmhouse room's front door (-14,103).
building('cottage-silas','farmhouse-silas',-16,100,5);
for(const [id,x,y,w,h] of [['inn',15,49,8,5],['chandler',1,55,4,4],['land-office',21,55,5,4],['smithy',21,62,6,4],['guildhouse',15,67,7,4],['workshop-orrin',23,67,5,4],['barn',-8,99,8,5]] as const)building(id,id,x,y,w,h);
// Townhouses (4 wide) and cottages (5 wide), their roofs (russet, slate, straw / moss, russet, slate) turning along each row and from row to row.
let count=0,rows=0;const row=(xs:number[],y:number,w=4)=>{rows++;xs.forEach((x,i)=>building(`house:${++count}`,`${w===5?'cottage':'townhouse'}-${'abc'[(i+rows)%3]}`,x-48,y+24,w));};
row([46,50,54],21);row([63,67,71],21);row([45],26,5);row([45],31);row([72],26);
row([45,49],43);row([46,50,54],48);row([63,67,71],48);row([44,48,52],13);row([63,67,71,75],13);
row([37],20,5);row([30],30,5);row([35,39],30);row([30,35],40,5);row([80,85],20,5);row([80],30,5);
row([33,38,43,48],57);row([64,68,72,76,80,85],57);
// Shop signs by the doors (the inn's mug and the guildhouse's wheel are in their facades).
overlay('sign:bakery','shop-sign-bread',3,53,70,-2);overlay('sign:chandler','shop-sign-candle',1,58,46,-2);
overlay('sign:land-office','shop-sign-scroll',21,58,26,-2);overlay('sign:smithy','shop-sign-anvil',21,65,22,-2);
// The forge's fire, in the smithy's forge mouth (drawn at half size: src/game/hearthwick2-art.ts).
overlay('forge-glow','forge-glow-0',21,65,69,0);
// Pell's yard beside the land office; goods by the inn, the smithy, the mill and the barn.
rect(26,55,28,58,':');deco('yard:handcart','handcart',26,56,2);deco('yard:barrel','barrel',28,55);deco('yard:crates','crate-stack',28,56);
deco('inn:barrel','barrel',14,52);deco('inn:crates','crate-stack',14,51);
deco('smithy:trough','water-trough',27,64,2);deco('smithy:barrel','barrel',27,62);
deco('mill:sacks','sack-pile',18,103);deco('mill:barrel','barrel',17,103);
deco('barn:sacks','sack-pile',0,103);deco('barn:barrel','barrel',0,102);deco('barn:hay','haystack',2,102,2,2);deco('barn:handcart','handcart',2,104,2);deco('barn:trough','water-trough',-10,103,2);
deco('farm:washing','washing-line-0',-20,102,3);deco('garden:washing-west','washing-line-0',-14,80,3);deco('garden:washing-east','washing-line-0',27,80,3);
// Southfields: scarecrows over the fields, a rick by the west field; beds in the allotments.
deco('field:scarecrow-west','scarecrow',-6,115);deco('field:scarecrow-east','scarecrow',30,113);deco('field:hay','haystack',7,117,2,2);
for(const y of [89,92])for(const x of [-17,-13,-9,-5,-1,3])deco(`allotment:${x},${y}`,'allotment-bed',x,y,2);
// The Bloom orchard (its flowers grow under the front row) and the pear walk, following the year.
for(const [x,y] of [[19,32],[22,32],[25,32],[28,32],[31,32],[21,29],[27,29],[17,91],[21,91],[25,91],[29,91],[33,91],[37,91],[41,91]] as const){seasonal(`fruit-tree:${x},${y}`,'fruit-tree',x,y);solid[y-24]![x+24]='#';}
// Way signs at the road mouths. The Brackenwood Arch stands in a glade off the north side of Lantern Road, two
// tiles in, so walking the road never takes you through it: you turn in and walk up to it from the south.
rect(37,54,41,55,',',true);rect(37,56,37,57,',',true);rect(41,56,41,57,',',true);rect(38,56,40,58,':');
for(const [x,y,v] of [[37,57,'a'],[41,57,'b'],[37,55,'b'],[41,55,'a']] as const)deco(`brackenwood:shrub:${x},${y}`,`garden-shrub-${v}`,x,y);
for(const [id,x,y] of [['west-road',-21,58],['lantern-road',44,58],['south-gate',10,115]] as const)deco(`way-sign:${id}`,'om-art:way-sign',x,y);
// The living portal (round 3): two old trees grown into a ring of light over the way out, 3 wide, glowing in a loop.
deco('brackenwood-arch','living-portal-0',39,56,1,1,false);
rect(-17,106,0,111,':');rect(-17,113,6,118,'f');rect(16,110,43,117,'f');rect(-18,88,7,93,'f');rect(31,67,41,74,'f');
piece('sawhorse','sawhorse',-16,107);prop('toolbox','tool-crate',-1,107);piece('firebox','firebox',-1,110);piece('timber-stack','timber-stack',-5,109);piece('skids','skids',-8,109);piece('woodpile','woodpile',-12,110);
// The Wick Tree, one crown a Mark, its trunk solid; the hearth keeps its rest/light ID.
rect(12,60,13,61,'.',true);seasonal('wick-tree','wick-tree',12,61,2);
// The hearth-stone at its foot: the rest spot and the square's light (a lamp drawn as scenery, standing on its tiles).
rect(12,62,13,62,'.',true);object('hearth','lamp',12,62,{variant:'hw2:hearth-stone-0',art:{ox:16,oy:16} as LayoutObject['art'],prop:{h:12,bodyW:0,bodyH:0,light:'village'} as LayoutObject['prop']});
prop('patched-bench','patched-bench',9,64,18);prop('trail-sign','trail-sign',19,58,24);prop('bread-basket','bread-basket',4,54,12);
rect(7,64,8,64,'.',true);object('town-well','well',7,64,{variant:'commons-well',art:{ox:16,oy:16} as LayoutObject['art']});
rect(17,55,18,55,'.',true);object('town-board','board',17,55,{variant:'notice-board'});
object('gate-hame','scenery',-4,31,{variant:'gatepost-small'});
piece('camp-pack','commons-art:wilds-pack',7,26);piece('camp-fire','commons-art:wilds-fire-ring',7,28);
// Pip's garden, as the old village garden was: hedged on three sides, a post-and-rail fence along the front with
// the fallen rail's gap (the fence-rail repair) as its way in, shrubs and flower beds inside, planters at the gap.
// Pip walks the middle path, his post clear of the gap (a resident's post is solid: src/game/entities/npcs.ts).
hedge(-11,69,-5,69);hedge(-11,70,-11,75);hedge(-5,70,-5,75);fence(-11,76,-9,76);fence(-7,76,-5,76);
deco('garden:shrub-west','garden-shrub-a',-10,70);deco('garden:shrub-east','garden-shrub-b',-6,70);
for(const [x,y,c] of [[-10,73,'white'],[-7,73,'pink'],[-10,75,'gold'],[-7,75,'white']] as const)deco(`garden:flowers:${x},${y}`,`garden-flowers-${c}`,x,y,2);
// Hedge posts at the gap, where the rails end (the fence's tiles are already solid).
for(const x of [-9,-7])deco(`garden:post:${x}`,'garden-hedge-post',x,76,1,1,false);
prop('garden:planter-west','flower-planter',-10,77,16);prop('garden:planter-east','flower-planter',-6,77,16);
rect(25,99,33,104,'~',true);rect(24,101,24,103,'~',true);rect(34,97,35,98,'~',true);rect(33,98,33,98,'~',true);
rect(25,98,32,98,':');
// The spring that feeds the pond, welling up in its ring of stones (its water tiles are already solid).
deco('spring','spring-stones-0',34,98,2,2,false);rect(34,99,34,104,':');rect(24,105,35,105,':');
object('mill-hopper','scenery',19,103,{variant:'mill-hopper'});rect(19,103,19,103,'.',true);
for(const [id,spot,x,y] of [['mara','',17,61],['orrin','',20,58],['pip','',-8,71],['hazel','square',9,63],['finn','door',21,105],['ada','window',-15,49],['elara','camp',6,27],['silas','yard',-16,108]] as const)object(`npc:${id}`,'npc-post',x,y,{npc:id,...(spot?{spot}:{})});
for(const [id,x,y] of [['well-rope',7,64],['village-lamp',12,62],['bench-slat',9,64],['fence-rail',-8,76],['library-roof',0,65],['gate-hame',-4,31]] as const)object(`repair:${id}`,'repair',x,y,{target:id});
for(const [target,festival,coords] of [
 ['bloom-patch','Bloom',[[19,33],[22,33],[25,33],[28,33],[31,33]]],
 ['freshet-shore','Mudrise',[[26,98],[29,98],[32,98]]],['pond-ice','Quiet',[[26,99],[29,99],[33,103]]],
] as const)for(const [i,[x,y]] of coords.entries())object(`gather:${target}:${i}`,'gather',x,y,{target,festival,label:target==='bloom-patch'?'Pick Bloom flowers':target==='pond-ice'?'Break the pond ice':'Sweep the freshet shore',variant:target==='pond-ice'?'pond-ice':target==='bloom-patch'?'wildflowers':'tangle-decor',...(target==='freshet-shore'?{frame:`pebbles-${i}`} : {}),art:{ox:8,oy:16,depthY:true,tile:true} as LayoutObject['art']});
object('exit:woodland','exit',38,56,{tw:3,th:1,label:'Brackenwood & Ashwatch',exit:{to:'woodland',entryTx:2,entryTy:15} as LayoutObject['exit']});
for (const [id,x,y,label] of [['north',1,25,'Beyond the arch: the Tangle.'],['south',10,116,'South Gate: the Wilds.'],['west-wildgate',-21,70,'West Row and the Western Drift.'],['east-wildgate',44,70,'East Row and the Eastern Reaches.']] as const)object(`boundary:${id}`,'scenery',x,y,{variant:'gatepost-small',label});
prop('lamp:north','lantern-post',4,26,32,'village');prop('lamp:south','lantern-post',14,116,32,'village');
for(let y=28;y<116;y+=12)for(const x of [-21,44])prop(`lamp:row:${x},${y}`,'lantern-post',x,y,32,'village');
for(const x of [-21,44])prop(`lamp:wildgate:${x}`,'lantern-post',x,71,32,'village');
for(const [id,variant,x,y] of [['madder-stall','stall-a',14,66],['stall-b','stall-b',17,64],['stall-c','stall-c',8,56],['bunting','bunting-96',12,53],['bunting-south','bunting-96',12,68]] as const)object(id,'scenery',x,y,{variant,festival:'Carting Day',art:{ox:8,oy:16,depth:5000} as LayoutObject['art']});
const town={id:'hearthwick',revision:2,tx:0,ty:0,width:72,height:96,palette,ground:ground.map(r=>r.join('')),solid:solid.map(r=>r.join('')),objects};
writeFileSync('content/places.json',JSON.stringify(places,null,2)+'\n');writeFileSync('content/layouts/hearthwick.json',JSON.stringify(town,null,2)+'\n');
for(let side=0;side<2;side++){
 const gnd=Array.from({length:96},()=>Array<string>(24).fill(side?'.':','));
 const sol=Array.from({length:96},()=>Array<string>(24).fill('#'));
 const obs:ObjectData[]=[];
 for(let row=0;row<4;row++){
  const gate=row*2+side,oy=row*24,front=side?0:23,back=side?23:0;
  for(let y=2;y<=21;y++)for(let x=0;x<24;x++)if(x!==front)sol[oy+y]![x]='.';
  for(let y=11;y<=12;y++)for(let x=side?0:11;x<=(side?12:23);x++){gnd[oy+y]![x]=':';sol[oy+y]![x]='.';}
  for(let y=8;y<=10;y++)for(const x of [11,12])gnd[oy+y]![x]=':';
  for(let y=3;y<=8;y++)for(let x=8;x<=15;x++)gnd[oy+y]![x]=':';
  obs.push({id:`lot:${gate}:gate`,kind:'gate',tx:front,ty:oy+11,tw:1,th:2,gate,side:side?'east':'west',target:'lot-entry'});
  for(const kind of ['sign','shelf'] as const){const at=lotService(gate,kind);obs.push({id:`lot:${gate}:${kind}`,kind,tx:at.x,ty:oy+at.y,gate});}
  for(const y of [1,22])obs.push({id:`lot:${gate}:fence:${y}`,kind:'scenery',tx:0,ty:oy+y,variant:'fence-h-24',art:{ox:0,oy:16,originLeft:true} as LayoutObject['art']});
  for(const [y,h] of [[2,9],[13,9]])obs.push({id:`lot:${gate}:front:${y}`,kind:'scenery',tx:front,ty:oy+y!+h!-1,variant:`fence-v-${h}`,art:{ox:0,oy:16,originLeft:true} as LayoutObject['art']});
  for(let y=2;y<=20;y+=2)obs.push({id:`lot:${gate}:stake:${y}`,kind:'scenery',tx:back,ty:oy+y,variant:'hw2:lantern-stake-0',art:{ox:8,oy:16} as LayoutObject['art']});
 }
 for(const y of [47,48])for(let x=0;x<24;x++){sol[y]![x]='.';gnd[y]![x]='-';}
 // The other verges between neighbouring lots are trodden footpaths, open from the Lot Row lane to the Wilds at the
 // backs (the generator keeps their back ends open: server/internal/wilds/seams.go).
 for(const y of [23,24,71,72])for(let x=0;x<24;x++){sol[y]![x]='.';gnd[y]![x]=':';}
 // The wildgate's arch where it opens onto the Wilds (walked under: it fades).
 obs.push({id:'wildgate:arch',kind:'scenery',tx:side?22:0,ty:48,variant:'hw2:wildgate-arch-side',art:{ox:16,oy:16,...(side?{flip:true}:{})} as LayoutObject['art']});
 const id=lotLayout(side);writeFileSync(`content/layouts/${id}.json`,JSON.stringify({id,revision:3,tx:0,ty:0,width:24,height:96,palette,ground:gnd.map(r=>r.join('')),solid:sol.map(r=>r.join('')),objects:obs},null,2)+'\n');
}
if(existsSync('content/layouts/homestead-lots.json'))unlinkSync('content/layouts/homestead-lots.json');
