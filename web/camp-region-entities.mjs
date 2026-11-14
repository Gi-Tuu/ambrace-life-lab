import { districtPads } from './camp-districts.mjs';
import { hash2 } from './camp-terrain.mjs';
import { inCamp, wildLandscape, REGION_SIZE, WILDS } from './wild-landscape.mjs';

export function regionEntities(terrain,cx,cz) {
  const plants=[], animals=[], seed=terrain.seed;
  const ox=cx*REGION_SIZE, oz=cz*REGION_SIZE;
  for (let slot=0;slot<4;slot++) {
    const salt=seed+slot*13;
    const x=ox+3+hash2(cx,cz,salt+109)*18;
    const z=oz+3+hash2(cx,cz,salt+110)*18;
    if (inCamp(x,z) || !regionPoint([x,z]) || terrain.cleared(x,z) || !terrain.walkable(x,z) || terrain.bankGap(x,z)<1.25) continue;
    const id=`region:${cx}:${cz}:${slot}`;
    if (slot<3) plants.push({id,x,z,item:slot===0?'fruit':'berry',mature:true});
    else {
      const kinds=['rabbit','deer','fox','bird'];
      animals.push({id,x,z,kind:kinds[Math.floor(hash2(cx,cz,salt+111)*kinds.length)]});
    }
  }
  return {plants,animals};
}

export function regionPoint(point) {
  return Array.isArray(point) && point.length===2 && point.every(Number.isFinite) &&
    point[0]>=WILDS.west && point[0]<WILDS.east && point[1]>=WILDS.north && point[1]<WILDS.south;
}

export function findRegionEntity(world,id,group) {
  if (!world.survival?.settlementLife || typeof id!=='string') return null;
  const match=/^region:(-?\d{1,2}):(-?\d{1,2}):[0-3]$/.exec(id);
  if (!match) return null;
  const x=Number(match[1]), z=Number(match[2]);
  return regionEntities(wildLandscape(world.mapSeed,world.layoutVersion,{joined:true,clearing:districtPads(world.districts)}),x,z)[group].find(row=>row.id===id)??null;
}

// One ripe crop remains on the source until collected. Recovery follows the game clock.
export function regionReady(node,t,picked,dayTicks) {
  const wait=(node.item==='fruit'?3:2)*dayTicks;
  return picked==null || t-picked>=wait ? 1 : 0;
}
