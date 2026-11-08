// 隔离候选：自身高警觉连续自抑制，逐事件负荷与慢状态跟踪独立；不接生产角色。
import assert from 'node:assert/strict';
import {Organism} from './agent.mjs';
import {appraise} from './appraisal.mjs';
import {EventExposureLedger} from './m5-event-exposure.mjs';
import {ProbeBank} from './m5-bank-probe.mjs';
import {hill} from './modulators.mjs';
import {M5_DEFAULTS as P} from './m5-slow.mjs';
import {measureRecovery,compareRecovery} from './m5-recovery-metrics.mjs';
import {DIMS} from './traits.mjs';
import {makeRng,gauss} from './rng.mjs';
const stressEvent={kind:'shortfall',valence:-.25,violates:null,selfCaused:false,about:null,serves:'energy'};
const normalEvent={kind:'contact',valence:.25,violates:null,selfCaused:false,about:null,serves:'social'};
const violationEvent={kind:'normbreak',valence:.45,violates:'order',selfCaused:true,about:null,serves:'energy'};
function context(archetype,seed){return new Organism({id:'a1',name:'岑',archetype,seed});}
class HomeostaticBank extends ProbeBank{
 constructor(actor,rng,{enabled=true,load=true,feedback=true,delay=8,exposure=true,ignoreLoad=false,brake=true,ignoreBrake=false}={}){
  super(actor.traits,rng,{enabled,load:false,feedback,delay});
  this.actor=actor;this.loadOn=load;this.load=0;this.ignoreLoad=ignoreLoad;this.brake=brake;this.ignoreBrake=ignoreBrake;
  this.exposure=new EventExposureLedger({enabled:enabled&&exposure});
 }
 event(evt,tick){
  const ctx={traits:this.traits,drives:this.actor.drives,memory:this.actor.memory,relations:this.actor.relations,t:tick,m:this.m};
  return this.exposure.observe(evt,appraise(evt,ctx));
 }
 tick(dt=1){
  if(dt!==1)throw new RangeError('仅支持逐次更新');
  const t=this.traits;let fb=0,brake=0;
  if(this.slow.enabled){
   const excess=Math.max(0,Math.min(1,(this.m.arousal-t.baseline.arousal)/(1-t.baseline.arousal)));
   if(this.brake&&!this.ignoreBrake)brake=-t.U_max*excess;
   const u=this.exposure.consume();
   this.load=this.loadOn?Math.min(1,Math.max(0,this.load-this.load/P.loadTau+P.injection*u)):0;
   const previous=this.slow.slow,x=this.m.arousal-t.baseline.arousal;
   if(this.slow.delay>0){this.slow.queue.push(previous);if(this.slow.queue.length>this.slow.delay)this.slow.queue.shift();}
   const delayed=this.slow.delay===0?previous:(this.slow.queue.length>=this.slow.delay?this.slow.queue[0]:0);
   this.slow.slow=previous+(x-previous)/(P.slowTau*(1+P.loadGain*(this.ignoreLoad?0:this.load)));
   fb=this.slow.feedbackEnabled?-P.feedback*delayed:0;
  }
  for(const d of DIMS){
   let cross=0;for(let j=0;j<DIMS.length;j++)cross+=(t.w[DIMS.indexOf(d)]?.[j]??0)*hill(this.x(DIMS[j]));
   const decay=-this.x(d)/t.tau[d],inj=Math.max(-t.U_max,Math.min(t.U_max,this.pending[d]));
   const raw=this.m[d]+dt*(decay+cross+inj+(d==='arousal'?fb+brake:0))+gauss(this.rng)*t.noise[d]*dt;
   if(!Number.isFinite(raw)||!Number.isFinite(this.slow.slow))throw new RangeError('非有限状态');
   this.m[d]=Math.max(0,Math.min(1,raw));this.pending[d]=0;
  }
 }
}
function controls(){
 const actor=context('谨慎',7),t=actor.traits;for(const d of DIMS)t.noise[d]=0;t.w=t.w.map(row=>row.map(()=>0));
 const mk=o=>new HomeostaticBank(actor,makeRng(123),o);
 const e=mk({});assert.equal(e.event(normalEvent,1),0);assert.ok(e.event(stressEvent,1)>0);
 const mixed=e.exposure.consume();assert.equal(mixed,.25);assert.ok(e.event(violationEvent,2)>0);
 for(const sign of [1,-1]){const b=mk({});b.m.arousal=t.baseline.arousal+sign*.1;b.tick();assert.ok(sign*b.slow.slow>0,'无事件 S 未追踪真实状态符号');}
 const checkLoad=(a,b)=>{a.m.arousal=b.m.arousal=t.baseline.arousal+.1;a.load=.5;b.load=0;a.tick();b.tick();assert.ok(Math.abs(a.slow.slow)<Math.abs(b.slow.slow),'实际 tick 未消费负荷');};
 checkLoad(mk({}),mk({}));assert.throws(()=>checkLoad(mk({ignoreLoad:true}),mk({})),/实际 tick 未消费负荷/);
 const checkBrake=(on,off)=>{on.m.arousal=off.m.arousal=.9;on.tick();off.tick();assert.ok(on.m.arousal<off.m.arousal,'高警觉真实 tick 未消费自抑');};
 checkBrake(mk({load:false,feedback:false}),mk({load:false,feedback:false,brake:false}));
 assert.throws(()=>checkBrake(mk({load:false,feedback:false,ignoreBrake:true}),mk({load:false,feedback:false,brake:false})),/高警觉真实 tick 未消费自抑/);
 for(const delta of [0,-.1]){const on=mk({load:false,feedback:false}),off=mk({load:false,feedback:false,brake:false});on.m.arousal=off.m.arousal=t.baseline.arousal+delta;on.tick();off.tick();assert.deepEqual(on.m,off.m,'基线及以下自抑不应出现');}
 const a=[mk({load:false}),mk({load:false,feedback:false}),mk({load:false,delay:0})],history=a.map(()=>[]);
 for(let tick=1;tick<=30;tick++){if(tick===1)for(const b of a)b.inject({arousal:.12});for(let i=0;i<a.length;i++){a[i].tick();history[i].push(a[i].m.arousal);}}
 const checkFeedback=(normal,off,immediate)=>{assert.ok(normal.some((v,i)=>Math.abs(v-off[i])>1e-12),'反馈未切断');assert.ok(normal.some((v,i)=>Math.abs(v-immediate[i])>1e-12),'delay0 未生效');};
 checkFeedback(...history);assert.throws(()=>checkFeedback(history[0],history[0],history[2]),/反馈未切断/);assert.throws(()=>checkFeedback(history[0],history[1],history[0]),/delay0 未生效/);
 return {realAppraiseEvents:true,positiveNegativeNoCancellation:true,normConflict:true,realTickLoad:true,removedConsumerRed:true,realTickBrake:true,brakeMutantRed:true,feedback:true,delay:true,feedbackMutantRed:true,delayMutantRed:true};
}
function run({archetype,seed,align,config}){
 const actor=context(archetype,seed),traits=actor.traits,make=o=>new HomeostaticBank(actor,makeRng(seed+10000),o);
 const a=Array.from({length:6},()=>make(config));
 const shadow=(config.enabled===false||(config.feedback===false&&config.brake===false))?Array.from({length:6},()=>new ProbeBank(traits,makeRng(seed+10000),{enabled:false})):[];
 const counterpart=config.load===false?Array.from({length:6},()=>make({...config,load:true,exposure:false})):config.exposure===false?Array.from({length:6},()=>make({...config,load:false,exposure:true})):[];
 const single=[],double=[];let identical=true,marginal=null;
 for(let tick=1;tick<=600;tick++){
  for(const group of [a,counterpart]){
   if(!group.length)continue;
   if(tick===20)for(const i of [1,4,5]){group[i].inject({arousal:.25});group[i].event(stressEvent,tick);}
   if(tick===80)for(const i of [0,1]){group[i].inject({arousal:.25});group[i].event(stressEvent,tick);}
   for(const b of group)b.tick();
   if(tick===79&&align)for(const i of [0,1,3,4,5])Object.assign(group[i].m,group[2].m);
  }
  if(shadow.length){if(tick===20)for(const i of [1,4,5])shadow[i].inject({arousal:.25});if(tick===80)for(const i of [0,1])shadow[i].inject({arousal:.25});for(const b of shadow)b.tick();if(tick===79&&align)for(const i of [0,1,3,4,5])Object.assign(shadow[i].m,shadow[2].m);}
  if(tick===79)for(const [i,j] of [[0,3],[1,4],[4,5]]){assert.deepEqual(a[i].m,a[j].m,'末击前快状态不同');assert.deepEqual(a[i].slow.dump(),a[j].slow.dump(),'末击前慢状态不同');assert.equal(a[i].load,a[j].load,'末击前负荷不同');assert.deepEqual(a[i].exposure.dump(),a[j].exposure.dump(),'末击前暴露账不同');}
  for(let i=0;i<shadow.length;i++)assert.deepEqual(a[i].m,shadow[i].m,'反馈关或全关旧路径不同');
  for(let i=0;i<counterpart.length;i++){assert.deepEqual(a[i].m,counterpart[i].m,'L 锁零与事件切断快状态不同');assert.deepEqual(a[i].slow.dump(),counterpart[i].slow.dump(),'L 锁零与事件切断慢状态不同');assert.equal(a[i].load,counterpart[i].load);}
  if(tick===80){assert.deepEqual(a[4].m,a[5].m,'漏击副本不同');assert.deepEqual(a[4].slow.dump(),a[5].slow.dump(),'漏击慢状态不同');marginal={single:Math.abs(a[0].m.arousal-a[3].m.arousal),double:Math.abs(a[1].m.arousal-a[4].m.arousal),omitted:Math.abs(a[4].m.arousal-a[5].m.arousal)};}
  if(tick>=80){single.push(Math.abs(a[0].m.arousal-a[2].m.arousal));double.push(Math.abs(a[1].m.arousal-a[2].m.arousal));identical&&=DIMS.every(d=>Object.is(a[0].m[d],a[1].m[d]));}
 }
 if(config.enabled===false&&align)assert.equal(identical,true,'全关同流对齐负控失败');
 const s=measureRecovery(single),d=measureRecovery(double);
 return {archetype,seed,align,config,single:s,double:d,verdict:compareRecovery(s,d),identical,marginal,finalLoad:a.slice(0,3).map(b=>b.load)};
}
const pulseControls=controls(),rows=[];
const samples=[['development',[7,11,13,23,42]],['known-a',[5,17,29,37,53]],['known-b',[2,19,41,61,73]],['known-c',[3,31,43,59,79]],['known-d',[83,89,97,101,103]],['known-e',[107,109,113,127,131]],['known-f',[137,139,149,151,157]],['known-g',[163,167,173,179,181]],['known-h',[191,193,197,199,211]],['known-i',[223,227,229,233,239]],['known-j',[241,251,257,263,269]],['known-k',[271,277,281,283,293]],['known-l',[307,311,313,317,331]],['new-seeds',[337,347,349,353,359]]];
for(const [sample,seeds] of samples)for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of seeds)for(const align of [true,false])
 for(const [arm,config] of [['full',{}],['brake-off',{brake:false}],['brake-feedback-off',{brake:false,feedback:false}],['load-zero',{load:false}],['exposure-off',{exposure:false}],['feedback-off',{feedback:false}],['delay-zero',{delay:0}],['all-off',{enabled:false}]])
  rows.push({sample,arm,...run({archetype,seed,align,config})});
console.log(JSON.stringify({protocol:'600 更新；自身高警觉连续自抑制；所有十四批正式样本均需通过',pulseControls,rows},null,2));
if(process.argv.includes('--gate')){
 const selected=rows.filter(r=>r.arm==='full'&&r.align),ids=selected.map(r=>`${r.sample}/${r.archetype}/${r.seed}`);
 const expected=samples.flatMap(([sample,seeds])=>['谨慎','冲动','孤僻'].flatMap(archetype=>seeds.map(seed=>`${sample}/${archetype}/${seed}`))).sort();
 const verify=actual=>assert.deepEqual([...actual].sort(),expected,'正式样本身份缺失、重复或替换');
 verify(ids);assert.equal(selected.length,210);assert.throws(()=>verify(ids.slice(1)));assert.throws(()=>verify([...ids.slice(0,-1),ids[0]]));
 const bad=selected.filter(r=>r.verdict!=='pass'||r.marginal.single<=.02||r.marginal.double<=.02||r.marginal.omitted!==0);
 assert.equal(bad.length,0,`完整门未通过：${bad.length}/${selected.length} 组不满足条件`);
}
