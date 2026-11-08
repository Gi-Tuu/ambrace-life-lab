// 逐事件暴露状态追踪的预登记开发标定；新验证 seed 不在本文件。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Organism} from './agent.mjs';
import {appraise} from './appraisal.mjs';
import {EventExposureLedger} from './m5-event-exposure.mjs';
import {ModulatorBank,hill} from './modulators.mjs';
import {measureRecovery,compareRecovery} from './m5-recovery-metrics.mjs';
import {DIMS} from './traits.mjs';
import {makeRng,gauss} from './rng.mjs';
const event={kind:'shortfall',valence:-.25,violates:null,selfCaused:false,about:null,serves:'energy'};
const groups=[['development',[7,11,13,23,42]],['known-a',[5,17,29,37,53]],['known-b',[2,19,41,61,73]],['known-c',[3,31,43,59,79]],['known-d',[83,89,97,101,103]],['known-e',[107,109,113,127,131]],['known-f',[137,139,149,151,157]],['known-g',[163,167,173,179,181]],['known-h',[191,193,197,199,211]],['known-i',[223,227,229,233,239]],['known-j',[241,251,257,263,269]],['known-k',[271,277,281,283,293]],['known-l',[307,311,313,317,331]]];
class Bank{
 constructor(actor,params,options={}){
  this.actor=actor;this.t=actor.traits;this.p=params;this.o={enabled:true,load:true,feedback:true,delay:8,exposure:true,...options};
  this.m={...this.t.baseline};this.slow=0;this.load=0;this.queue=[];this.exposure=new EventExposureLedger({enabled:this.o.enabled&&this.o.exposure});
 }
 clone(){const b=new Bank(this.actor,this.p,this.o);b.m={...this.m};b.slow=this.slow;b.load=this.load;b.queue=[...this.queue];b.exposure.pending=this.exposure.pending;b.exposure.count=this.exposure.count;return b;}
 observe(tick){const ctx={traits:this.t,drives:this.actor.drives,memory:this.actor.memory,relations:this.actor.relations,t:tick,m:this.m};this.exposure.observe(event,appraise(event,ctx));}
 tick(impulse,noise){
  const t=this.t,p=this.p;let fb=0;
  if(this.o.enabled){
   const u=this.exposure.consume();this.load=this.o.load?Math.min(1,Math.max(0,this.load-this.load/160+.08*u)):0;
   const previous=this.slow,x=this.m.arousal-t.baseline.arousal;
   if(this.o.delay>0){this.queue.push(previous);if(this.queue.length>this.o.delay)this.queue.shift();}
   const delayed=this.o.delay===0?previous:(this.queue.length>=this.o.delay?this.queue[0]:0);
   this.slow=previous+(x-previous)/(p.tauS*(1+p.gain*this.load));
   fb=this.o.feedback?-p.feedback*delayed:0;
  }
  const inj=Math.max(-t.U_max,Math.min(t.U_max,impulse));
  for(let i=0;i<DIMS.length;i++){
   const d=DIMS[i];let cross=0;for(let j=0;j<DIMS.length;j++)cross+=(t.w[i]?.[j]??0)*hill(this.m[DIMS[j]]-t.baseline[DIMS[j]]);
   const decay=-(this.m[d]-t.baseline[d])/t.tau[d];
   const raw=this.m[d]+(decay+cross+(d==='arousal'?inj:0)+(d==='arousal'?fb:0))+noise[i]*t.noise[d];
   if(!Number.isFinite(raw)||!Number.isFinite(this.slow))throw new RangeError('非有限状态');
   this.m[d]=Math.max(0,Math.min(1,raw));
  }
 }
}
function makeSample(sample,archetype,seed){
 const actor=new Organism({id:'a1',name:'岑',archetype,seed}),traits=actor.traits,ref=new ModulatorBank(traits,makeRng(seed+10000)),n=makeRng(seed+10000),noise=[];
 const check=new Bank(actor,{tauS:80,feedback:.02,gain:4},{feedback:false});
 for(let t=1;t<=600;t++){
  const z=DIMS.map(()=>gauss(n));noise.push(z);ref.tick();check.tick(0,z);
  assert.deepEqual(check.m,ref.m,`预生成噪声或反馈关闭路径不等 ${archetype}/${seed}/${t}`);
 }
 return {sample,archetype,seed,actor,noise};
}
function run(sample,params,options={}){
 const a=new Bank(sample.actor,params,options),b=new Bank(sample.actor,params,options),ref=new Bank(sample.actor,params,options),s=[],d=[];let marginal=null;
 for(let t=1;t<=600;t++){
  const z=sample.noise[t-1],ca=t===80?a.clone():null,cb=t===80?b.clone():null;
  if(t===20)b.observe(t);if(t===80){a.observe(t);b.observe(t);}
  a.tick(t===80?.25:0,z);b.tick(t===20||t===80?.25:0,z);ref.tick(0,z);
  if(t===79){Object.assign(a.m,ref.m);Object.assign(b.m,ref.m);}
  if(t===80){ca.tick(0,z);cb.tick(0,z);marginal={single:Math.abs(a.m.arousal-ca.m.arousal),double:Math.abs(b.m.arousal-cb.m.arousal)};}
  if(t>=80){s.push(Math.abs(a.m.arousal-ref.m.arousal));d.push(Math.abs(b.m.arousal-ref.m.arousal));}
 }
 const single=measureRecovery(s),double=measureRecovery(d),verdict=compareRecovery(single,double);
 return {sample:sample.sample,archetype:sample.archetype,seed:sample.seed,single,double,marginal,verdict,pass:verdict==='pass'&&marginal.single>.02&&marginal.double>.02};
}
const samples=[];
for(const [sample,seeds] of groups)for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of seeds)samples.push(makeSample(sample,archetype,seed));
assert.equal(samples.length,195);
const baseline=JSON.parse(readFileSync('D:/Codex-Projects/output/ambrace-life-m5-event-tracking-eval.log','utf8').replace(/^\uFEFF/,''));
const prior=baseline.rows.filter(r=>r.align),map=new Map(prior.map(r=>[`${r.archetype}/${r.seed}/${r.arm}`,r]));let matched=0;
const arms=[['full',{}],['load-zero',{load:false}],['exposure-off',{exposure:false}],['feedback-off',{feedback:false}],['delay-zero',{delay:0}],['all-off',{enabled:false}]];
for(const sample of samples)for(const [arm,options] of arms){
 const old=map.get(`${sample.archetype}/${sample.seed}/${arm}`);if(!old)continue;
 const now=run(sample,{tauS:80,feedback:.02,gain:4},options);
 assert.deepEqual(now.single,old.single,`单击历史不同 ${sample.archetype}/${sample.seed}/${arm}`);
 assert.deepEqual(now.double,old.double,`双击历史不同 ${sample.archetype}/${sample.seed}/${arm}`);
 assert.deepEqual(now.marginal,{single:old.marginal.single,double:old.marginal.double},`边际历史不同 ${sample.archetype}/${sample.seed}/${arm}`);matched++;
}
assert.equal(matched,990,'旧矩阵或控制样本不完整');
function isUnconfirmed(r){return !r.single.valid||!r.double.valid||r.single.first===null||r.double.first===null||r.single.stable===null||r.double.stable===null||!Number.isFinite(r.marginal.single)||!Number.isFinite(r.marginal.double)||r.marginal.single<=.02||r.marginal.double<=.02;}
const valid={valid:true,first:1,stable:1};
assert.equal(isUnconfirmed({single:{...valid,stable:null},double:valid,marginal:{single:.1,double:.1},verdict:'fail-first'}),true);
assert.equal(isUnconfirmed({single:valid,double:valid,marginal:{single:.02,double:.1}}),true);
assert.equal(isUnconfirmed({single:valid,double:valid,marginal:{single:.1,double:.1}}),false);
const results=[];
for(const tauS of [80,160,40])for(const feedback of [.02,.04,.08,.16])for(const gain of [4,2,8,1]){
 const params={tauS,feedback,gain},rows=samples.map(s=>run(s,params));
 results.push({params,passed:rows.filter(r=>r.pass).length,unconfirmed:rows.filter(isUnconfirmed).length,rows});
}
const rank=results.map((r,index)=>({index,passed:r.passed,unconfirmed:r.unconfirmed})).sort((a,b)=>b.passed-a.passed||a.unconfirmed-b.unconfirmed||a.index-b.index);
const winner=results[rank[0].index];
console.log(JSON.stringify({protocol:'13 批195组已揭盲开发集；事件暴露与动态参考；48组预登记工程参数',matched,rank,winner:{params:winner.params,passed:winner.passed,unconfirmed:winner.unconfirmed},results},null,2));
