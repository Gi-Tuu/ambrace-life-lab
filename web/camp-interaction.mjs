import { campTerrain } from './camp-terrain.mjs';
import { residentialSite } from './camp-layout.mjs';

export const CAMP_SITES = Object.freeze({
  home:[22,24], hall:[29,24], store:[36,24], yard:[20,34],
  workshop:[61,29], garden:[31,39], watch:[67,13], well:[50,34],
});
export const campSite = (room, layout) => layout?.sites[room] ?? CAMP_SITES[room] ?? residentialSite(room);
export const ANIMAL_ITEMS = Object.freeze({ chickens:'egg', cows:'milk', sheep:'wool' });
export const ANIMAL_LIMITS = Object.freeze({ chickens:4, cows:3, sheep:3 });
export const CAMP_TOOLS = Object.freeze({ berry:'basket',fruit:'basket',crop:'basket',egg:'basket',wool:'shears',milk:'bucket',water:'bucket' });
export const REACH = Object.freeze({ resident:1.6, timber:1.55, plant:1.35, animal:1.6, plot:.55 });
export const pointIn = (p,w,d) => Array.isArray(p) && p.length===2 && p.every(Number.isFinite) &&
  p[0]>=0 && p[0]<w && p[1]>=0 && p[1]<d;
export const distanceToRect = ([x,z], b) => Math.hypot(Math.max(b.x-x,0,x-b.x-b.w),Math.max(b.z-z,0,z-b.z-b.d));
export const distanceTo = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]);

export function campEntrance(room, at) {
  if (!at) return null;
  const [sx,sz]=at, x=sx+.5,z=sz+.5;
  if (residentialSite(room)) return {x:sx-1.15,z:sz-2.55,w:2.3,d:1.6};
  if (room==='hall') return {x:x-1,z:z-1.35,w:2,d:2.25};
  if (room==='watch') return {x:x-.95,z:z-3.71,w:1.9,d:1.35};
  if (room==='well') return {x:x+.4,z:z-1.3,w:2.2,d:1.5};
  if (room==='yard'||room==='garden') return {x:x+.72,z:z-1.2,w:2.4,d:1.5};
  return {x:x-1.15,z:z-2.25,w:2.3,d:1.5};
}

export function campPen(at) {
  return at ? {x:at[0]-9,z:at[1]-4,w:7,d:6.4,gate:2.75,opening:1.5} : null;
}

export function campBeds(at, seed=0, version=0) {
  if (!at) return [];
  const [x,z]=at, {riverCenter,riverHalfWidth}=campTerrain(seed,false,version);
  const top=(z+1)*16;
  let safeBank=Infinity;
  for(let y=top;y<top+8*16;y++) safeBank=Math.min(safeBank,riverCenter(y)-riverHalfWidth(y)-17);
  const left=Math.min(x-8,Math.floor(safeBank/16)-19);
  return Array.from({length:12},(_,id)=>({id,x:left+id%4*5,z:z+1+Math.floor(id/4)*3,w:4,d:2}));
}

// Fixed harvest nodes share their positions and stock sources with the server.
export function campPlants(layout, orchards=3, seed=0, version=0) {
  const [gx,gz]=campSite('garden',layout), [yx,yz]=campSite('yard',layout);
  const beds=campBeds([gx,gz],seed,version);
  const first=beds[0];
  const fruit=Array.from({length:Math.min(12,orchards)},(_,i)=>({
    id:`fruit:${i}`,item:'fruit',site:'garden',x:first.x+1+i%6*2.95,z:first.z+9.5+Math.floor(i/6)*3,
  }));
  return fruit.concat([
    {id:'berry:garden:0',item:'berry',site:'garden',x:first.x+.5,z:first.z-1.4},
    {id:'berry:garden:1',item:'berry',site:'garden',x:first.x+5.5,z:first.z-1.4},
    {id:'berry:yard:0',item:'berry',site:'yard',x:yx+2.5,z:yz+2.2},
    {id:'berry:yard:1',item:'berry',site:'yard',x:yx+4.1,z:yz+1.6},
  ]);
}

export function segmentGap(p,a,b) {
  const x=b[0]-a[0],z=b[1]-a[1],len=x*x+z*z;
  const f=len?Math.max(0,Math.min(1,((p[0]-a[0])*x+(p[1]-a[1])*z)/len)):0;
  return distanceTo(p,[a[0]+x*f,a[1]+z*f]);
}

export const RESIDENT_REACH = REACH.resident;
export const HEAVY_CAMP_TOOLS = Object.freeze(['axe','pick','hoe','hammer']);

export function nearResident(from,to) {
  return Array.isArray(from) && from.length===2 && from.every(Number.isFinite) &&
    Array.isArray(to) && to.length===2 && to.every(Number.isFinite) &&
    Math.hypot(from[0]-to[0],from[1]-to[1])<=RESIDENT_REACH;
}
