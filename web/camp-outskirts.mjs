import { pixelPath } from './asset-collision.mjs';
import { regionEntities, regionReady } from './camp-region-entities.mjs';
import { regionLife } from './camp-3d-scene.mjs';
import { inCamp, regionWindow, wildDetails, wildLandscape, wildRegion, worldOverview, WILDS } from './wild-landscape.mjs';

export function createCampOutskirts(seed,version,crossing,world) {
  const terrain=wildLandscape(seed,version,{joined:true,flats:world?.flatLand,hills:world?.hills,roadDistance:world?.roadDistance,
    plantClearance:world?.plantClearance,harvestNodes:world?.harvestNodes,clearing:world?.districtPads});
  const cache=new Map();
  let signature, visible=[], overview, lifeKey, living;
  const entitiesTerrain=wildLandscape(seed,version,{joined:true,clearing:world?.districtPads});
  return {
    terrain,
    overview:()=>overview??=[{mesh:worldOverview(terrain)}],
    height:(x,z)=>terrain.height(x,z),
    walkable:(x,z)=>terrain.walkable(x,z,crossing),
    life(x,z,snapshot) {
      const chunks=regionWindow(x,z).filter(b=>b.near);
      const plants=[],animals=[];
      for (const b of chunks) {
        const chunk=cache.get(b.key);
        if (!chunk) continue;
        chunk.entities??=regionEntities(entitiesTerrain,b.x,b.z);
        for (const node of chunk.entities.plants) {
          plants.push({...node,y:terrain.height(node.x,node.z),ready:regionReady(node,snapshot.t,
            snapshot.regionHarvest?.[node.id],snapshot.dayTicks??24)});
        }
        animals.push(...chunk.entities.animals);
      }
      const key=plants.map(p=>p.id+':'+p.ready).concat(animals.map(a=>a.id)).join(',');
      if (key!==lifeKey || !living) {
        lifeKey=key;
        living=regionLife(plants,animals);
      }
      return living;
    },
    regions(x,z) {
      const entries=regionWindow(x,z);
      const key=entries.map(b=>b.key+(b.near?'*':'')).join(',');
      if (key===signature) return visible;
      signature=key;
      visible=[];
      for (const entry of entries) {
        let chunk=cache.get(entry.key);
        if (!chunk) chunk={ground:{mesh:wildRegion(terrain,entry.x,entry.z)}};
        cache.delete(entry.key);
        cache.set(entry.key,chunk);
        visible.push(chunk.ground);
        if (entry.near) {
          chunk.details??=wildDetails(terrain,entry.x,entry.z,crossing);
          visible.push(chunk.details);
        }
      }
      while (cache.size>42) cache.delete(cache.keys().next().value);
      return visible;
    },
  };
}

export function moveJoinedWalker(x,z,dx,dz,inside,outside) {
  const steps=Math.max(1,Math.ceil(Math.hypot(dx,dz)*32));
  const clear=(nx,nz)=>inCamp(nx,nz) ? inside(nx,nz,x,z) : outside(nx,nz,x,z);
  for (let i=0;i<steps;i++) {
    const nx=x+dx/steps, nz=z+dz/steps;
    if (clear(nx,z)) x=nx;
    if (clear(x,nz)) z=nz;
  }
  return [x,z];
}

// Route in world coordinates. Check every edge so a clear endpoint cannot hide a bank or trunk.
export function joinedRoute(from,to,allows) {
  if (!allows(...to)) return null;
  const clear=(a,b)=>{
    const count=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])*7));
    for (let i=1;i<=count;i++) {
      if (!allows(a[0]+(b[0]-a[0])*i/count,a[1]+(b[1]-a[1])*i/count)) return false;
    }
    return true;
  };
  if (clear(from,to)) return [to];
  for (const margin of [14,60,135,320]) {
    const origin=[Math.max(WILDS.west,Math.floor(Math.min(from[0],to[0])-margin)),
      Math.max(WILDS.north,Math.floor(Math.min(from[1],to[1])-margin))];
    const tw=Math.ceil(Math.min(WILDS.east,Math.max(from[0],to[0])+margin)-origin[0]);
    const th=Math.ceil(Math.min(WILDS.south,Math.max(from[1],to[1])+margin)-origin[1]);
    const point=(x,z)=>[origin[0]+x,origin[1]+z];
    const status=new Uint8Array(tw*th);
    const pointAt=i=>point(i%tw,Math.floor(i/tw));
    const cellAllows=i=>{
      if (!status[i]) status[i]=allows(...pointAt(i))?1:2;
      return status[i]===1;
    };
    const nearest=p=>{
      const x=Math.round(p[0]-origin[0]),z=Math.round(p[1]-origin[1]);
      const candidates=[];
      for (let dz=-2;dz<=2;dz++) for (let dx=-2;dx<=2;dx++) {
        const i=x+dx,j=z+dz;
        if (i>=0 && j>=0 && i<tw && j<th && cellAllows(j*tw+i)) candidates.push([i,j]);
      }
      candidates.sort((a,b)=>Math.hypot(...point(...a).map((v,i)=>v-p[i]))-Math.hypot(...point(...b).map((v,i)=>v-p[i])));
      return candidates.find(q=>clear(p,point(...q)));
    };
    const start=nearest(from),end=nearest(to);
    if (!start || !end) continue;
    const route=pixelPath({tw,th,cellAllows,edgeAllows:(a,b)=>clear(pointAt(a),pointAt(b))},start,end);
    if (!route) continue;
    return [start,...route].map(p=>point(...p)).concat([to]);
  }
  return null;
}
