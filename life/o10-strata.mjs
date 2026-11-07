import { simulate } from './run.mjs';
import { driverDist } from './metrics.mjs';
const seeds=[7,11,13,23,42],out=[];
for(const weight of [0,0.06]) for(const seed of seeds){
 const supply=[];for(const [name,pantry,stash] of [['饥馑',0,0],['宽裕',8,5]]){const {agents}=await simulate({seed,ticks:1200,condition:'C2',scheduleWeight:weight,pantry,stash});const people=Object.values(agents).map(a=>({id:a.id,stage:a.viab.stage,v:a.viab.v,reserve:a.viab.reserve}));supply.push({name,people,stages:people.reduce((s,x)=>s+x.stage,0)});}
 const d=await simulate({seed,ticks:400,condition:'C2',scheduleWeight:weight});const drivers=driverDist(Object.values(d.agents).flatMap(a=>a.trace));const drivers300=driverDist(Object.values(d.agents).flatMap(a=>a.trace.filter(r=>r.t<=300)));
 const orders=[];for(const order of [.05,.95]){const traitsOverride={a2:{goals:{order,safety:.7,novelty:.6,social:.4}}};const {agents}=await simulate({seed,ticks:600,condition:'C2',scheduleWeight:weight,traitsOverride});orders.push({order,violations:agents.a2.counters.normbreak});}
 out.push({weight,seed,supply,drivers,drivers300,need300:(drivers300.energy??0)+(drivers300.social??0)+(drivers300.stimulation??0),need:(drivers.energy??0)+(drivers.social??0)+(drivers.stimulation??0),orders});
}
console.log(JSON.stringify({protocol:'PLAN O10 分层复核预登记；400/600/1200 ticks，5 seeds，动作分叉后随机流可不同，不替换原闸门',rows:out},null,2));
