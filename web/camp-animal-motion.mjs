import { beam, rotate, rotateXZ } from '../shared/camp-geometry.mjs';

export function animalMeals() {
  let key, snapshot, seen=new Map();
  const playing=new Map();
  return (identity,world,time)=>{
    if (identity!==key || world.t<(snapshot?.t??0)) {
      key=identity;
      snapshot=null;
      playing.clear();
      seen=new Map();
    }
    if (snapshot!==world) {
      const meals=new Map(Object.entries(world.wildTrust??{}).map(([id,bond])=>[id,bond.last]));
      for (const id of world.chickenMeal?.ids??[]) meals.set(id,world.chickenMeal.t);
      for (const [id,tick] of meals) {
        if (snapshot && Number.isFinite(tick) && tick<=world.t && world.t-tick<=2 && tick>=(snapshot.t??0) && tick!==seen.get(id))
          playing.set(id,time);
      }
      seen=meals;
      snapshot=world;
    }
    const active=new Map();
    for (const [id,start] of playing) {
      const phase=(time-start)/1.55;
      if (phase>=1 || phase<0) playing.delete(id);
      else active.set(id,phase);
    }
    return active;
  };
}

const heads={
  chickens:{pivot:[0,.245,.084],pitch:.95,sag:.06},
  cows:{pivot:[0,.61,.20],pitch:1.12,sag:.25},
  sheep:{pivot:[0,.51,.17],pitch:1.18,sag:.15},
  deer:{pivot:[0,.86,.19],pitch:1.73,sag:.32},
  rabbit:{pivot:[0,.27,.075],pitch:.74,sag:.055},
  fox:{pivot:[0,.405,.13],pitch:.92,sag:.10},
};

export function animalHead(a,time) {
  const shape=heads[a.kind];
  if (!shape || !(a.alert || a.afraid || Number.isFinite(a.meal) || a.graze)) return null;
  const yaw=(a.direction??0)*Math.PI/2;
  let tilt,drop,turn=0;
  const eating=Number.isFinite(a.meal) || a.graze;
  if (eating && !a.afraid) {
    const progress=Number.isFinite(a.meal)?a.meal:1;
    const envelope=Number.isFinite(a.meal)?Math.min(1,progress*6,(1-progress)*5):1;
    const chew=.5+.5*Math.sin(time*(a.kind==='chickens'?18:9)+(a.phase??0));
    const reach=envelope*(.78+.22*chew);
    tilt=shape.pitch*reach;
    drop=shape.sag*reach;
  } else {
    const facing=a.watch && Math.atan2(a.watch[0]-a.x,a.watch[1]-a.z);
    if (Number.isFinite(facing)) {
      const angle=Math.atan2(Math.sin(facing+yaw),Math.cos(facing+yaw));
      turn=Math.max(-.58,Math.min(.58,angle))*.85;
    }
    turn+=Math.sin(time*6+(a.phase??0))*.12;
    tilt=a.afraid?-.16:-.25;
    drop=a.afraid?.018:-.055;
  }
  const local=a.stage==='juvenile' && a.kind==='chickens'?[0,.186,.067]:shape.pivot;
  const [dx,,dz]=rotateXZ(local,yaw);
  const ground=a.groundY??0;
  return {local,base:[a.x+dx,ground+local[1],a.z+dz],pivot:[a.x+dx,ground+local[1]-drop,a.z+dz],rot:[tilt,-yaw+turn,0],eating:eating&&!a.afraid};
}

export function animalNeck(a,head) {
  if (!head?.eating || a.kind==='chickens') return null;
  const model=a.boxes.find(b=>b.fx==='head');
  if (!model) return null;
  const throat=[0,model.y+Math.min(.19,model.h/2)-head.local[1],model.z+model.d*.41-head.local[2]];
  const target=rotate(throat,head.rot).map((v,i)=>v+head.pivot[i]);
  return beam(head.base,target,Math.min(.12,model.w*.29),model.color);
}

export function posedAnimalHead(box,head) {
  const {local,pivot,rot}=head;
  return {...box,x:pivot[0]+box.x-local[0],y:pivot[1]+box.y-local[1],z:pivot[2]+box.z-local[2],rot,pivot};
}
