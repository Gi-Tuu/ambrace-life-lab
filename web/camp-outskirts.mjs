import { inCamp, regionWindow, REGION_SIZE, wildDetails, wildLandscape, wildRegion } from './wild-landscape.mjs';
import { TOWN_SIZE } from './camp-layout.mjs';

export function createCampOutskirts(seed,version,crossing) {
  const terrain=wildLandscape(seed,version,{joined:true});
  const cache=new Map();
  let signature, visible=[];
  return {
    terrain,
    height:(x,z)=>terrain.height(x,z),
    walkable:(x,z)=>terrain.walkable(x,z,crossing),
    regions(x,z) {
      const entries=regionWindow(x,z).filter(b=>b.x<0 || b.z<0 ||
        (b.x+1)*REGION_SIZE>TOWN_SIZE.width || (b.z+1)*REGION_SIZE>TOWN_SIZE.depth);
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
