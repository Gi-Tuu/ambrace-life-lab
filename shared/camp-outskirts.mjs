import { regionEntities, regionReady } from './camp-region-entities.mjs';
import { orchardWeather } from './camp-orchard-look.mjs';
import { regionLife } from './camp-scene.mjs';
import { inCamp, regionWindow, wildDetails, wildLandscape, wildRegion, worldOverview, REGION_SIZE } from './wild-landscape.mjs';

// P2c：世界坐标寻路的实现已收进 shared/asset-collision.mjs（核心仍是 pixelPath）。
// 这里保留同名导出只是兼容旧调用点，不再包含任何寻路逻辑。
export { worldRoute as joinedRoute } from './asset-collision.mjs';

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
      const weather=orchardWeather(snapshot);
      const key=JSON.stringify([plants.map(p=>[p.id,p.ready]),animals.map(a=>a.id),weather]);
      if (key!==lifeKey || !living) {
        lifeKey=key;
        living=regionLife(plants,animals,weather);
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
        if (!chunk) {
          const mesh=wildRegion(terrain,entry.x,entry.z);
          let low=Infinity,high=-Infinity;
          for (let i=1;i<mesh.length;i+=11) { low=Math.min(low,mesh[i]); high=Math.max(high,mesh[i]); }
          const size=REGION_SIZE;
          chunk={ground:{mesh,viewBounds:[entry.x*size,low,entry.z*size,(entry.x+1)*size,high,(entry.z+1)*size]}};
        }
        cache.delete(entry.key);
        cache.set(entry.key,chunk);
        visible.push(chunk.ground);
        if (entry.near) {
          if (!chunk.details) {
            chunk.details=wildDetails(terrain,entry.x,entry.z,crossing);
            const [x,y,z,X,Y,Z]=chunk.ground.viewBounds;
            chunk.details.viewBounds=[x-3,y-1,z-3,X+3,Y+8,Z+3];
          }
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
