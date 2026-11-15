import { findRegionEntity, regionPoint } from '../web/camp-region-entities.mjs';
import { ANIMAL_ITEMS, campPen, campSite, distanceTo, distanceToRect, pointIn, wildHabitats } from '../web/camp-interaction.mjs';
import { DAY_TICKS } from './clock.mjs';
import { WORLD_TW, WORLD_TH } from './geometry.mjs';
import { sourceView, takeProduce } from './source-produce.mjs';

export const animalAfraid=(w,id)=>(w.survival.frightenedAnimals?.[id]??0)>w.t;
const fail=code=>({ok:false,code});
export function animalAction(w,body) {
  const {kind,target,from,to,tool}=body, s=w.survival, bag=w.pinv.p1;
  if (!s.settlementLife || !s.farmLife || typeof target!=='string') return fail('NO_ANIMAL');
  if (w.campPlayerRoom || !regionPoint(from) || !regionPoint(to) ||
      distanceTo(from,to)>1.65) return fail('OUT_OF_REACH');
  if (kind==='animal_feed') {
    if (tool!=='basket') return fail('NEED_TOOL');
    const regional=findRegionEntity(w,target,'animals');
    const anchor=regional??wildHabitats(w.campLayout).find(a=>a.id===target);
    if (!anchor || anchor.kind==='bird' || distanceTo(to,[anchor.x,anchor.z])>12) return fail('NO_ANIMAL');
    if (!regional && (!pointIn(from,WORLD_TW,WORLD_TH) || !pointIn(to,WORLD_TW,WORLD_TH))) return fail('OUT_OF_REACH');
    const food=['berry','fruit','crop'].find(item=>bag[item]>=1);
    if (!food) return fail('ANIMAL_NEEDS_FOOD');
    const trust=s.wildTrust??={}, old=trust[target]??{trust:0,last:-Infinity};
    if (w.t-old.last<Math.ceil(DAY_TICKS/2)) return fail('ANIMAL_WAIT');
    if (old.trust>=4) return fail('ANIMAL_TRUSTED');
    bag[food]-=1;
    trust[target]={trust:old.trust+1,last:w.t};
    return {ok:true,code:'OK',trust:trust[target].trust};
  }
  if (tool!=='axe') return fail('NEED_TOOL');
  const pen=campPen(campSite('yard',w.campLayout));
  if (!pointIn(from,WORLD_TW,WORLD_TH) || !pointIn(to,WORLD_TW,WORLD_TH) || distanceToRect(to,pen)>0) return fail('OUT_OF_REACH');
  const group=target.split(':')[0], item=ANIMAL_ITEMS[group];
  if (!item) return fail('NO_ANIMAL');
  const animals=sourceView(w), victim=animals[item].find(row=>row.id===target);
  if (!victim) return fail('NO_ANIMAL');
  const wasAfraid=animalAfraid(w,target);
  const meat=Math.max(1,Math.floor((group==='cows'?6:group==='sheep'?4:2)*(wasAfraid?.5:1)));
  if (group==='chickens' && s.ecosystem) s.ecoPop.chickens=s.ecoPop.chickens.filter(c=>'chickens:'+c.id!==target);
  else (s.culledAnimals??={})[target]=true;
  s.livestock[group]-=1;
  if (victim.ready>0) takeProduce(s,item,victim.ready,target);
  const fright=s.frightenedAnimals??={};
  for (const animal of Object.values(ANIMAL_ITEMS).flatMap(k=>animals[k])) {
    if (animal.id!==target) fright[animal.id]=w.t+2*DAY_TICKS;
  }
  delete fright[target];
  bag.meat=(bag.meat??0)+meat;
  return {ok:true,code:'OK',meat};
}
