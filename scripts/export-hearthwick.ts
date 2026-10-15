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
// road, paving, cobble, tilled fields, water; a placeholder building's footprint box is bare earth.
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
// Existing art; new shops/cottages use collision and small placeholder boxes in ground.
house('house-west','p1:house-west',3,50,6,6);
house('library','commons-art:hearthwick-library',-2,62,5,0);
house('house-ada','p1:house-ada',-18,44,6,-14,-15);
house('house-middle','p1:house-middle',-18,71,7,-15);
house('cottage-silas','cottage-silas',-16,100,6,-14);
house('mill','mill-house',20,100,4,21);
function box(id:string,x:number,y:number,w:number,h=4){rect(x,y,x+w-1,y+h-1,'t',true);object(id,'scenery',x,y+h-1,{variant:'tool-crate',tw:w,th:h,label:id,art:{ox:w*8,oy:16} as LayoutObject['art']});}
for(const [id,x,y,w,h] of [['inn',15,49,8,5],['chandler',1,55,4,4],['land-office',21,55,5,4],['smithy',21,62,6,4],['guildhouse',15,67,7,4],['workshop-orrin',23,67,5,4],['barn',-8,99,8,5]] as const)box(id,x,y,w,h);
let count=0;const row=(xs:number[],y:number,w=4)=>{for(const x of xs)box(`house:${++count}`,x-48,y+24,w);};
row([46,50,54],21);row([63,67,71],21);row([45],26,5);row([45],31);row([72],26);row([74],31,3);
row([45,49],43);row([46,50,54],48);row([63,67,71],48);row([44,48,52],13);row([63,67,71,75],13);
row([37],20,5);row([30,35],30,5);row([40],30,3);row([30,35],40,5);row([80,85],20,5);row([80,85],30,5);
row([33,38,43,48],57);row([64,68,72,76,80,85],57);
rect(-17,106,0,111,':');rect(-17,113,6,118,'f');rect(16,110,43,117,'f');rect(-18,88,7,93,'f');rect(31,67,41,74,'f');
piece('sawhorse','sawhorse',-16,107);prop('toolbox','tool-crate',-1,107);piece('firebox','firebox',-1,110);piece('timber-stack','timber-stack',-5,109);piece('skids','skids',-8,109);piece('woodpile','woodpile',-12,110);
// Centrepiece placeholder canopy and hearth: retain stable repair/rest IDs for H5.
rect(12,60,13,61,'.',true);object('wick-tree','tree',12,61,{variant:'oak-canopy',width:128});
prop('hearth','lantern-post',12,62,24,'village');
prop('patched-bench','patched-bench',9,64,18);prop('trail-sign','trail-sign',19,58,24);prop('bread-basket','bread-basket',4,54,12);
rect(7,64,8,64,'.',true);object('town-well','well',7,64,{variant:'commons-well',art:{ox:16,oy:16} as LayoutObject['art']});
rect(17,55,18,55,'.',true);object('town-board','board',17,55,{variant:'notice-board'});
object('gate-hame','scenery',-4,31,{variant:'gatepost-small'});
piece('camp-pack','commons-art:wilds-pack',7,26);piece('camp-fire','commons-art:wilds-fire-ring',7,28);
fence(-11,69,-5,69);fence(-11,70,-11,76);fence(-5,70,-5,76);fence(-10,76,-9,76);fence(-7,76,-6,76);
rect(25,99,33,104,'~',true);rect(24,101,24,103,'~',true);rect(34,97,35,98,'~',true);rect(33,98,33,98,'~',true);
rect(25,98,32,98,':');rect(34,99,34,104,':');rect(24,105,35,105,':');
object('mill-hopper','scenery',19,103,{variant:'mill-hopper'});rect(19,103,19,103,'.',true);
for(const [id,spot,x,y] of [['mara','',10,59],['orrin','',20,58],['pip','',-8,75],['hazel','square',9,63],['finn','door',21,105],['ada','window',-15,49],['elara','camp',6,27],['silas','yard',-16,108]] as const)object(`npc:${id}`,'npc-post',x,y,{npc:id,...(spot?{spot}:{})});
for(const [id,x,y] of [['well-rope',7,64],['village-lamp',12,62],['bench-slat',9,64],['fence-rail',-8,76],['library-roof',0,65],['gate-hame',-4,31]] as const)object(`repair:${id}`,'repair',x,y,{target:id});
for(const [target,festival,coords] of [
 ['bloom-patch','Bloom',[[19,33],[22,33],[25,33],[28,33],[31,33]]],
 ['freshet-shore','Mudrise',[[26,98],[29,98],[32,98]]],['pond-ice','Quiet',[[26,99],[29,99],[33,103]]],
] as const)for(const [i,[x,y]] of coords.entries())object(`gather:${target}:${i}`,'gather',x,y,{target,festival,label:target==='bloom-patch'?'Pick Bloom flowers':target==='pond-ice'?'Break the pond ice':'Sweep the freshet shore',variant:target==='pond-ice'?'pond-ice':target==='bloom-patch'?'wildflowers':'tangle-decor',...(target==='freshet-shore'?{frame:`pebbles-${i}`} : {}),art:{ox:8,oy:16,depthY:true,tile:true} as LayoutObject['art']});
object('exit:woodland','exit',38,62,{tw:3,th:1,label:'Brackenwood & Ashwatch',exit:{to:'woodland',entryTx:2,entryTy:15} as LayoutObject['exit']});
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
  for(let y=2;y<=20;y+=2)obs.push({id:`lot:${gate}:stake:${y}`,kind:'scenery',tx:back,ty:oy+y,variant:'gatepost-small',art:{ox:8,oy:16} as LayoutObject['art']});
 }
 for(const y of [47,48])for(let x=0;x<24;x++){sol[y]![x]='.';gnd[y]![x]='-';}
 const id=lotLayout(side);writeFileSync(`content/layouts/${id}.json`,JSON.stringify({id,revision:3,tx:0,ty:0,width:24,height:96,palette,ground:gnd.map(r=>r.join('')),solid:sol.map(r=>r.join('')),objects:obs},null,2)+'\n');
}
if(existsSync('content/layouts/homestead-lots.json'))unlinkSync('content/layouts/homestead-lots.json');
