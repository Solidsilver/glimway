/** Refresh H2 world-tile vectors from the authored content and layout. */
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {at,anchor,sourceOf,onGrid} from '../src/lib/location.ts';
import {validatePlaces} from '../src/lib/places.ts';
import raw from '../content/places.json' with {type:'json'};
const file='content/vectors/location.json';
const doc=JSON.parse(readFileSync(file,'utf8'));
doc.comment='Hearthwick 2 world-tile contract: 3x4 town with west/east lot columns. Regenerate with node scripts/hearthwick-location-vectors.ts.';
function refresh(d:any,places=validatePlaces(raw)){
 for(const v of d.at??[])v.place=at(v.space,v.x,v.y,places);
 for(const v of d.sourceOf??[])v.source=sourceOf(v.chunk[0],v.chunk[1],places);
 for(const v of d.onGrid??[])v.onGrid=onGrid(v.chunk[0],v.chunk[1],places);
 for(const v of d.anchors??[]){const a=anchor(v.id,places);v.ok=!!a;if(!a){v.space='';v.at=[0,0];}if(a){v.space=a.space;v.at=[a.x,a.y];}}
}
// Keep the seam probes and add the new entrances and service edges.
for(const [name,x,y] of [['southfields',12,110],['west lot',-37,32],['east lot',59,32],['west wildgate',-36,71],['east wildgate',60,72],['south gate',12,119],['west lane',-23,35],['east lane',46,35]] as const)if(!doc.at.some((v:any)=>v.name===name))doc.at.push({name,space:'outdoors',x:x*16+8,y:y*16+8});
for(const id of ['west-wildgate','east-wildgate','land-office-door'])if(!doc.anchors.some((v:any)=>v.id===`hearthwick:${id}`))doc.anchors.push({id:`hearthwick:${id}`});
refresh(doc);refresh(doc.bounds,validatePlaces({...raw,fixed:[...raw.fixed,...doc.bounds.fixed]}));refresh(doc.zones,validatePlaces({...raw,fixed:raw.fixed.map((p,i)=>i? p:{...p,zones:doc.zones.zones})}));
const old=new Map<string,any>(doc.positions.map((v:any)=>[v.source,v]));
const positions:any[]=[];
function add(source:string,v:any){positions.push({source,kind:source.endsWith('.outside')?'target':old.get(source)?.kind??'stand',area:'hearthwick',tile:[v.tx,v.ty]});}
const tile=(v:any)=>v&&!Array.isArray(v)&&typeof v.tx==='number'&&typeof v.ty==='number';
function walk(path:string,v:any,inherited=false){
 if(Array.isArray(v)){v.forEach((x,i)=>walk(`${path}.${x?.id??i}`,x,inherited));return;}
 if(!v||typeof v!=='object')return;
 const own='area'in v||'to'in v?v.area==='hearthwick'||v.to==='hearthwick':inherited;
 if(own&&tile(v))add(path,v);
 for(const k of Object.keys(v).sort())if(tile(v[k])&&(own||k==='hearthwick'))add(`${path}.${k}`,v[k]);else walk(`${path}.${k}`,v[k],own);
}
for(const f of readdirSync('content').filter(f=>f.endsWith('.json')&&f!=='places.json'))walk(f.slice(0,-5),JSON.parse(readFileSync(`content/${f}`,'utf8')));
const town=JSON.parse(readFileSync('content/layouts/hearthwick.json','utf8'));
for(const o of town.objects)if(['npc-post','gather','exit'].includes(o.kind)){add(`layout.${o.id}`,{tx:o.tx-24,ty:o.ty+24});positions.at(-1).kind=o.kind==='gather'?'target':'stand';}
for(const p of JSON.parse(readFileSync('content/papers.json','utf8')).papers)if(p.rule.kind==='placed'&&p.rule.area==='hearthwick')add(`papers.${p.rule.tx},${p.rule.ty}`,p.rule);

doc.positions=positions;
writeFileSync(file,JSON.stringify(doc,null,2)+'\n');
// Coordinate/frontier parity follows the manifest too (H4 owns the generator routes).
const c = await import('../src/lib/wilds/coords.ts');
const coordFile='content/vectors/wilds-coords.json';
const coords=JSON.parse(readFileSync(coordFile,'utf8'));
for(const v of coords.chunks){const [cx,cy]=v.chunk;const cell=c.cellOf(cx,cy);Object.assign(v,{footprint:c.footprintAt(cx,cy)?.id??'',tier:c.tier(cx,cy),epochKind:c.epochKindAt(cx,cy),inside:c.insideFrontier(cx,cy),ring:c.ring(cx,cy),cell:[cell.x,cell.y]});}
const r=c.frontierRect();let count=0,newCount=0;
for(let cy=r.minCy;cy<=r.maxCy;cy++)for(let cx=r.minCx;cx<=r.maxCx;cx++)if(c.insideFrontier(cx,cy)){count++;if(sourceOf(cx,cy).kind==='generated'&&!c.footprintAt(cx,cy))newCount++;}
coords.frontier={rect:[r.minCx,r.minCy,r.maxCx,r.maxCy],chunks:count,new:newCount};
coords.comment='Hearthwick 2 reach union; regenerate with node scripts/hearthwick-location-vectors.ts.';
writeFileSync(coordFile,JSON.stringify(coords,null,2)+'\n');
