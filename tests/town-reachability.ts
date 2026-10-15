/** Reachability against served bytes, including prop collision, rather than
 * just the author's solid grid. Go's chunks test runs the same five floods.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeChunk } from '../src/lib/api/chunks.ts';
import { PLACES } from '../src/lib/places.ts';
import { fixedChunkKeys } from '../src/game/wilds/fixed.ts';
import vectors from '../content/vectors/location.json' with { type: 'json' };
import town from '../content/layouts/hearthwick.json' with { type: 'json' };
const key = (x:number,y:number) => `${x},${y}`;
export function townReachability(): void {
  const open = new Set<string>();
  for (const p of PLACES.fixed) for (const {cx,cy} of fixedChunkKeys(p)) {
    const c = decodeChunk(new Uint8Array(readFileSync(new URL(`./fixtures/${p.id}-${cx}-${cy}.bin`,import.meta.url))));
    for (let i=0;i<576;i++) if (!(c.solid[i>>3]! & (1<<(i%8)))) open.add(key(cx*24+i%24,cy*24+Math.floor(i/24)));
    for (const o of c.objects) if (['tree','bush','rock','prop','lamp'].includes(o.kind)) open.delete(key(cx*24+o.tx,cy*24+o.ty));
  }
  const positions = vectors.positions;
  // Placed paper data and room art are also matched to the vectors, so moving
  // either without updating the contract can't leave a stale passing check.
  const papers = readFileSync(new URL('../src/content/papers.ts',import.meta.url),'utf8');
  const paperTiles = [...papers.matchAll(/source: \{ kind: 'placed', area: 'hearthwick', tx: (-?\d+), ty: (-?\d+)/g)].map(m=>[Number(m[1]),Number(m[2])]);
  assert.deepEqual(positions.filter(v=>/^papers\.-?\d+,/.test(v.source)).map(v=>v.tile).sort(),paperTiles.sort());
  for (const o of town.objects) if (['npc-post','gather','exit'].includes(o.kind))
    assert.deepEqual(positions.find(v=>v.source===`layout.${o.id}`)?.tile,[o.tx-24,o.ty+24]);
  const starts = [[4,60],[2,24],[47,59],[9,95],[-72,69]] as const;
  for (const [x,y] of starts) {
    assert.ok(open.has(key(x,y)),`flood start ${x},${y} is blocked`);
    const seen = new Set([key(x,y)]), queue: [number,number][] = [[x,y]];
    for (let i=0;i<queue.length;i++) {
      const [x,y]=queue[i]!;
      for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
        const k=key(x+dx,y+dy);
        if (open.has(k) && !seen.has(k)) { seen.add(k);queue.push([x+dx,y+dy]); }
      }
    }
    for (const p of PLACES.fixed) for (const a of p.anchors) assert.ok(seen.has(key(a.tx+p.origin.tx,a.ty+p.origin.ty)),`${p.id}:${a.id} unreachable from ${x},${y}`);
    for (const v of positions) {
      const [tx,ty]=v.tile as [number,number];
      if(v.kind==='stand') assert.ok(seen.has(key(tx,ty)),`${v.source} ${tx},${ty} unreachable from ${x},${y}`);
      else assert.ok([[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>seen.has(key(tx+dx!,ty+dy!))),`${v.source} has no reachable approach from ${x},${y}`);
    }
    for(let g=0;g<8;g++) assert.ok(seen.has(key(-61+24*(g%2),32+24*Math.floor(g/2))),`lot:${g} doorstep unreachable`);
  }
}
