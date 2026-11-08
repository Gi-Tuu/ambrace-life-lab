// 快慢仓组合预登记开发集标定；新验证 seed 不在此文件。
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
const groups=[['development',[7,11,13,23,42]],['known-a',[5,17,29,37,53]],['known-b',[2,19,41,61,73]],['known-c',[3,31,43,59,79]],['known-d',[83,89,97,101,103]],['known-e',[107,109,113,127,131]],['known-f',[137,139,149,151,157]],['known-g',[163,167,173,179,181]],['known-h',[191,193,197,199,211]],['known-i',[223,227,229,233,239]],['known-j',[241,251,257,263,269]],['known-k',[271,277,281,283,293]],['known-l',[307,311,313,317,331]],['known-m',[337,347,349,353,359]],['known-n',[367,373,379,383,389]]];
class Bank{
 constructor(actor,params,options={}){
  this.actor=actor;this.t=actor.traits;this.p=params;this.o={enabled:true,brake:true,load:true,feedback:true,delay:8,read:true,slowInput:true,exposure:true,...options};
  this.fast={...this.t.baseline};this.slow=0;this.load=0;this.queue=[];this.exposure=new EventExposureLedger({enabled:this.o.enabled&&this.o.exposure});this.sync();
 }
 sync(){this.m={...this.fast};if(this.o.enabled&&this.o.read)this.m.arousal=Math.max(0,Math.min(1,this.fast.arousal+this.slow));}
 clone(){const b=new Bank(this.actor,this.p,this.o);b.fast={...this.fast};b.slow=this.slow;b.load=this.load;b.queue=[...this.queue];b.exposure.pending=this.exposure.pending;b.exposure.count=this.exposure.count;b.sync();return b;}
 observe(tick){const ctx={traits:this.t,drives:this.actor.drives,memory:this.actor.memory,relations:this.actor.relations,t:tick,m:this.m};this.exposure.observe(event,appraise(event,ctx));}
 tick(impulse,noise){
  const t=this.t,p=this.p,inj=Math.max(-t.U_max,Math.min(t.U_max,impulse));let brake=0;
  if(this.o.enabled&&this.o.brake){const excess=Math.max(0,Math.min(1,(this.fast.arousal-t.baseline.arousal)/(1-t.baseline.arousal)));brake=-t.U_max*excess;}
  for(let i=0;i<DIMS.length;i++){
   const d=DIMS[i];let cross=0;for(let j=0;j<DIMS.length;j++)cross+=(t.w[i]?.[j]??0)*hill(this.fast[DIMS[j]]-t.baseline[DIMS[j]]);
   const decay=-(this.fast[d]-t.baseline[d])/t.tau[d];
   const raw=this.fast[d]+(decay+cross+(d==='arousal'?inj:0)+(d==='arousal'?brake:0))+noise[i]*t.noise[d];
   if(!Number.isFinite(raw))throw new RangeError('非有限快状态');
   this.fast[d]=Math.max(0,Math.min(1,raw));
  }
  if(this.o.enabled){
   const u=this.exposure.consume(),previous=this.slow;
   this.load=this.o.load?Math.min(1,Math.max(0,this.load-this.load/160+u)):0;
   if(this.o.delay>0){this.queue.push(previous);if(this.queue.length>this.o.delay)this.queue.shift();}
   const delayed=this.o.delay===0?previous:(this.queue.length>=this.o.delay?this.queue[0]:0);
   this.slow=Math.max(0,previous-previous/(p.tauS*(1+p.gain*this.load))+(this.o.slowInput?u:0)-(this.o.feedback?p.feedback*delayed:0));
   if(!Number.isFinite(this.slow))throw new RangeError('非有限慢状态');
  }
  this.sync();
 }
}
function makeSample(sample,archetype,seed){
 const actor=new Organism({id:'a1',name:'岑',archetype,seed}),traits=actor.traits,n=makeRng(seed+10000),noise=[];
 const original=new ModulatorBank(traits,makeRng(seed+10000)),zero=new Bank(actor,{tauS:80,feedback:.02,gain:4},{enabled:false});
 const refs=[new Bank(actor,{tauS:80,feedback:.02,gain:4},{}),new Bank(actor,{tauS:80,feedback:.02,gain:4},{enabled:false})];
 const refRows=refs.map(()=>({fast79:null,arousal:[]}));
 for(let t=1;t<=600;t++){
  const z=DIMS.map(()=>gauss(n));noise.push(z);original.tick();zero.tick(0,z);
  assert.deepEqual(zero.m,original.m,`预生成噪声或关闭快路径不等 ${archetype}/${seed}/${t}`);
  for(let i=0;i<2;i++){refs[i].tick(0,z);if(t===79)refRows[i].fast79={...refs[i].fast};if(t>=80)refRows[i].arousal.push(refs[i].m.arousal);}
 }
 return {sample,archetype,seed,actor,noise,refRows};
}
function run(sample,params,options={}){
 const a=new Bank(sample.actor,params,options),b=new Bank(sample.actor,params,options),s=[],d=[];let marginal=null;
 const braked=a.o.enabled&&a.o.brake,ref=sample.refRows[braked?0:1];
 for(let t=1;t<=600;t++){
  const z=sample.noise[t-1],ca=t===80?a.clone():null,cb=t===80?b.clone():null;
  if(t===20)b.observe(t);if(t===80){a.observe(t);b.observe(t);}
  a.tick(t===80?.25:0,z);b.tick(t===20||t===80?.25:0,z);
  if(t===79){Object.assign(a.fast,ref.fast79);a.sync();Object.assign(b.fast,ref.fast79);b.sync();}
  if(t===80){ca.tick(0,z);cb.tick(0,z);marginal={single:Math.abs(a.m.arousal-ca.m.arousal),double:Math.abs(b.m.arousal-cb.m.arousal)};}
  if(t>=80){const v=ref.arousal[t-80];s.push(Math.abs(a.m.arousal-v));d.push(Math.abs(b.m.arousal-v));}
 }
 const single=measureRecovery(s),double=measureRecovery(d),verdict=compareRecovery(single,double);
 return {sample:sample.sample,archetype:sample.archetype,seed:sample.seed,single,double,marginal,verdict,pass:verdict==='pass'&&marginal.single>.02&&marginal.double>.02};
}
const samples=[];
for(const [sample,seeds] of groups)for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of seeds)samples.push(makeSample(sample,archetype,seed));
assert.equal(samples.length,225);
const baseline=JSON.parse(readFileSync('D:/Codex-Projects/output/ambrace-life-m5-braked-dual-eval.log','utf8').replace(/^\uFEFF/,''));
const prior=baseline.rows.filter(r=>r.align),map=new Map(prior.map(r=>[`${r.archetype}/${r.seed}/${r.arm}`,r]));let matched=0;
const arms=[['full',{}],['brake-off',{brake:false}],['read-off',{read:false}],['slow-input-off',{slowInput:false}],['load-zero',{load:false}],['feedback-off',{feedback:false}],['delay-zero',{delay:0}],['brake-read-off',{brake:false,read:false}],['all-off',{enabled:false}]];
for(const sample of samples)for(const [arm,options] of arms){
 const old=map.get(`${sample.archetype}/${sample.seed}/${arm}`);assert.ok(old,'旧样本缺失');
 const now=run(sample,{tauS:80,feedback:.02,gain:4},options);
 assert.deepEqual(now.single,old.single,`单击历史不同 ${sample.archetype}/${sample.seed}/${arm}`);
 assert.deepEqual(now.double,old.double,`双击历史不同 ${sample.archetype}/${sample.seed}/${arm}`);
 assert.deepEqual(now.marginal,{single:old.marginal.single,double:old.marginal.double},`边际历史不同 ${sample.archetype}/${sample.seed}/${arm}`);matched++;
}
assert.equal(matched,2025,'旧矩阵或控制样本不完整');
function isUnconfirmed(r){return !r.single.valid||!r.double.valid||r.single.first===null||r.double.first===null||r.single.stable===null||r.double.stable===null||!Number.isFinite(r.marginal.single)||!Number.isFinite(r.marginal.double)||r.marginal.single<=.02||r.marginal.double<=.02;}
const valid={valid:true,first:1,stable:1};assert.equal(isUnconfirmed({single:{...valid,stable:null},double:valid,marginal:{single:.1,double:.1},verdict:'fail-first'}),true);assert.equal(isUnconfirmed({single:valid,double:valid,marginal:{single:.02,double:.1}}),true);
const results=[];
for(const tauS of [80,160,40])for(const feedback of [.02,.01,.005,.0025])for(const gain of [4,2,8,1]){
 const params={tauS,feedback,gain},rows=samples.map(s=>run(s,params));
 results.push({params,passed:rows.filter(r=>r.pass).length,unconfirmed:rows.filter(isUnconfirmed).length,rows});
}
const rank=results.map((r,index)=>({index,passed:r.passed,unconfirmed:r.unconfirmed})).sort((a,b)=>b.passed-a.passed||a.unconfirmed-b.unconfirmed||a.index-b.index);
const winner=results[rank[0].index];
console.log(JSON.stringify({protocol:'15 批225组已揭盲开发集；真实事件评价、快慢仓；48组预登记参数',matched,rank,winner:{params:winner.params,passed:winner.passed,unconfirmed:winner.unconfirmed},results},null,2));
