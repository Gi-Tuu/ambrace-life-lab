import { regionEntities, regionReady } from './camp-region-entities.mjs';
import { regionLife } from './camp-3d-scene.mjs';
import { inCamp, regionWindow, wildDetails, wildLandscape, wildRegion, worldOverview } from './wild-landscape.mjs';

export function createCampOutskirts(seed,version,crossing,world) {
  const terrain=wildLandscape(seed,version,{joined:true,flats:world?.flatLand,hills:world?.hills,roadDistance:world?.roadDistance,
    plantClearance:world?.plantClearance,harvestNodes:world?.harvestNodes});
  const cache=new Map();
  let signature, visible=[], overview, lifeKey, living;
  const entitiesTerrain=wildLandscape(seed,version,{joined:true});
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
  const clear=(nx,nz)=>inCamp(nx,nz) ? inside(nx,nz,x,z) : outside(nx,nz);
  for (let i=0;i<steps;i++) {
    const nx=x+dx/steps, nz=z+dz/steps;
    if (clear(nx,z)) x=nx;
    if (clear(x,nz)) z=nz;
  }
  return [x,z];
}
