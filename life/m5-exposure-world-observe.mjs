// 只读包装既有 assess，观察默认世界逐事件暴露；不改变随机数、评价或动作。
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Organism} from './agent.mjs';
import {simulate} from './run.mjs';
import {eventExposure} from './m5-event-exposure.mjs';
const original=Organism.prototype.assess;let events=[];
function summarize(rows){
 const groups=new Map();
 for(const r of rows){const key=`${r.id}/${r.t}`;const x=groups.get(key)??{pos:false,neg:false};x.pos||=r.arousal>0;x.neg||=r.arousal<0;groups.set(key,x);}
 return {events:rows.length,positiveExposure:rows.filter(r=>r.exposure>0).length,
  positiveOrdinaryArousal:rows.filter(r=>r.valence>0&&!r.violates&&r.arousal>0).length,
  positiveNormExposure:rows.filter(r=>r.valence>0&&r.violates&&r.exposure>0).length,
  mixedArousalTicks:[...groups.values()].filter(x=>x.pos&&x.neg).length,
  kinds:Object.fromEntries([...new Set(rows.map(r=>r.kind))].sort().map(k=>[k,rows.filter(r=>r.kind===k).length]))};
}
function snapshot({world,agents}){
 const a=Object.fromEntries(Object.entries(agents).map(([id,x])=>[id,{actions:x.trace.filter(r=>r.action),counters:x.counters,viab:x.viab.dump()}]));
 const state={t:world.t,pantry:world.pantry,stash:world.stash,loc:world.loc,expect:world.expect,agents:a};
 return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}
const results=[];let seed7=null;
try{
 Organism.prototype.assess=function(evt,...args){
  const result=original.call(this,evt,...args);
  events.push({id:this.id,t:this.world?.t??0,kind:evt.kind,valence:evt.valence,violates:evt.violates??null,arousal:result.u.arousal,exposure:eventExposure(evt,result)});
  return result;
 };
 for(const seed of [7,11,13,23,42]){
  events=[];const result=await simulate({seed,ticks:600,condition:'C2'}),hash=snapshot(result);
  results.push({seed,ticks:600,sha256:hash,total:summarize(events),agents:Object.fromEntries(['a1','a2','a3'].map(id=>[id,summarize(events.filter(r=>r.id===id))]))});
  if(seed===7)seed7=hash;
 }
}finally{Organism.prototype.assess=original;}
const plain=snapshot(await simulate({seed:7,ticks:600,condition:'C2'}));
assert.equal(plain,seed7,'只读包装改变了世界轨迹');
console.log(JSON.stringify({protocol:'默认 C2 本地，5 seed × 600 tick；只读 assess，未连接 M5',plain7:plain,results},null,2));
