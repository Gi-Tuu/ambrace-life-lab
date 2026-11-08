// 隔离候选：快仓自抑制 + 负荷敏化逐事件慢输入；快仓 W 仍只消费快状态。
import assert from 'node:assert/strict';
import {Organism} from './agent.mjs';
import {appraise} from './appraisal.mjs';
import {EventExposureLedger} from './m5-event-exposure.mjs';
import {ModulatorBank,hill} from './modulators.mjs';
import {M5_DEFAULTS as P} from './m5-slow.mjs';
import {measureRecovery,compareRecovery} from './m5-recovery-metrics.mjs';
import {DIMS} from './traits.mjs';
import {makeRng,gauss} from './rng.mjs';
const stressEvent={kind:'shortfall',valence:-.25,violates:null,selfCaused:false,about:null,serves:'energy'};
const normalEvent={kind:'contact',valence:.25,violates:null,selfCaused:false,about:null,serves:'social'};
const violationEvent={kind:'normbreak',valence:.45,violates:'order',selfCaused:true,about:null,serves:'energy'};
function context(archetype,seed){return new Organism({id:'a1',name:'岑',archetype,seed});}
class FastBank extends ModulatorBank{
 constructor(traits,rng,{brake=true}={}){super(traits,rng);this.brake=brake;}
 tick(dt=1){
  const t=this.traits;let brake=0;
  if(this.brake){const excess=Math.max(0,Math.min(1,(this.m.arousal-t.baseline.arousal)/(1-t.baseline.arousal)));brake=-t.U_max*excess;}
  for(const d of DIMS){
   let cross=0;for(let j=0;j<DIMS.length;j++)cross+=(t.w[DIMS.indexOf(d)]?.[j]??0)*hill(this.x(DIMS[j]));
   const decay=-this.x(d)/t.tau[d],inj=Math.max(-t.U_max,Math.min(t.U_max,this.pending[d]));
   const raw=this.m[d]+dt*(decay+cross+inj+(d==='arousal'?brake:0))+gauss(this.rng)*t.noise[d]*dt;
   if(!Number.isFinite(raw))throw new RangeError('非有限快状态');
   this.m[d]=Math.max(0,Math.min(1,raw));this.pending[d]=0;
  }
 }
}
class BrakedDualBank{
 constructor(actor,rng,{enabled=true,brake=true,load=true,feedback=true,delay=8,read=true,slowInput=true,exposure=true,ignoreBrake=false,ignoreRead=false,ignoreInput=false,ignoreLoad=false}={}){
  this.actor=actor;this.traits=actor.traits;this.enabled=enabled;this.fast=new FastBank(this.traits,rng,{brake:enabled&&brake&&!ignoreBrake});
  this.loadOn=load;this.feedback=feedback;this.delay=delay;this.read=read;this.slowInput=slowInput;
  this.ignoreRead=ignoreRead;this.ignoreInput=ignoreInput;this.ignoreLoad=ignoreLoad;
  this.slow=0;this.load=0;this.queue=[];this.exposure=new EventExposureLedger({enabled:enabled&&exposure});this.sync();
 }
 sync(){this.m={...this.fast.m};if(this.enabled&&this.read&&!this.ignoreRead)this.m.arousal=Math.max(0,Math.min(1,this.fast.m.arousal+this.slow));}
 inject(spec){this.fast.inject(spec);}
 event(evt,tick){return this.exposure.observe(evt,appraise(evt,{traits:this.traits,drives:this.actor.drives,memory:this.actor.memory,relations:this.actor.relations,t:tick,m:this.m}));}
 tick(){
  this.fast.tick(1);
  if(this.enabled){
   const u=this.exposure.consume(),previous=this.slow,previousLoad=this.load;
   if(this.delay>0){this.queue.push(previous);if(this.queue.length>this.delay)this.queue.shift();}
   const delayed=this.delay===0?previous:(this.queue.length>=this.delay?this.queue[0]:0);
   const load=this.ignoreLoad?0:previousLoad,input=this.slowInput&&!this.ignoreInput?u*(1+load):0;
   this.slow=Math.min(1,Math.max(0,previous-previous/P.slowTau+input-(this.feedback?P.feedback*delayed:0)));
   this.load=this.loadOn?Math.min(1,Math.max(0,previousLoad-previousLoad/P.loadTau+u)):0;
   if(!Number.isFinite(this.slow))throw new RangeError('非有限慢状态');
  }
  this.sync();
 }
 dump(){return {slow:this.slow,load:this.load,queue:[...this.queue],exposure:this.exposure.dump()};}
}
function controls(){
 const actor=context('谨慎',7),t=actor.traits;for(const d of DIMS)t.noise[d]=0;t.w=t.w.map(row=>row.map(()=>0));
 const mk=o=>new BrakedDualBank(actor,makeRng(123),o);
 const events=mk({});assert.equal(events.event(normalEvent,1),0);assert.equal(events.event(stressEvent,1),.25);assert.equal(events.exposure.consume(),.25);assert.ok(events.event(violationEvent,2)>0);
 const checkBrake=(a,b)=>{a.fast.m.arousal=b.fast.m.arousal=.9;a.sync();b.sync();a.tick();b.tick();assert.ok(a.m.arousal<b.m.arousal,'真实快 tick 自抑未生效');};
 checkBrake(mk({feedback:false,read:false}),mk({feedback:false,read:false,brake:false}));
 assert.throws(()=>checkBrake(mk({feedback:false,read:false,ignoreBrake:true}),mk({feedback:false,read:false,brake:false})),/真实快 tick 自抑未生效/);
 for(const delta of [0,-.1]){const a=mk({read:false}),b=mk({read:false,brake:false});a.fast.m.arousal=b.fast.m.arousal=t.baseline.arousal+delta;a.sync();b.sync();a.tick();b.tick();assert.deepEqual(a.m,b.m,'基线及以下不能自抑');}
 const checkRead=(a,b)=>{for(const x of [a,b]){x.event(stressEvent,1);x.tick();}assert.ok(a.m.arousal>b.m.arousal,'慢输出未进入统一警觉');};
 checkRead(mk({}),mk({read:false}));assert.throws(()=>checkRead(mk({ignoreRead:true}),mk({read:false})),/慢输出未进入统一警觉/);
 const checkInput=(a,b)=>{for(const x of [a,b]){x.event(stressEvent,1);x.tick();}assert.ok(a.slow>b.slow,'真实 tick 未消费慢输入');assert.equal(a.load,b.load,'慢输入切断不应连带切负荷');};
 checkInput(mk({}),mk({slowInput:false}));assert.throws(()=>checkInput(mk({ignoreInput:true}),mk({slowInput:false})),/真实 tick 未消费慢输入/);
 const checkLoad=(a,b)=>{a.slow=b.slow=.1;a.load=.5;b.load=0;for(const x of [a,b])x.event(stressEvent,1);a.tick();b.tick();assert.ok(a.slow>b.slow,'真实 tick 未消费负荷');};
 checkLoad(mk({}),mk({}));assert.throws(()=>checkLoad(mk({ignoreLoad:true}),mk({})),/真实 tick 未消费负荷/);
 const a=[mk({load:false}),mk({load:false,feedback:false}),mk({load:false,delay:0})],history=a.map(()=>[]);
 for(let tick=1;tick<=30;tick++){
  if(tick===1)for(const b of a)b.event(stressEvent,tick);
  for(let i=0;i<a.length;i++){a[i].tick();history[i].push({s:a[i].slow,m:a[i].m.arousal});}
 }
 const checkFeedback=(normal,off,immediate)=>{assert.ok(normal.some((v,i)=>Math.abs(v.s-off[i].s)>1e-12&&Math.abs(v.m-off[i].m)>1e-12),'反馈未切断');assert.ok(normal.some((v,i)=>Math.abs(v.s-immediate[i].s)>1e-12&&Math.abs(v.m-immediate[i].m)>1e-12),'delay0 未生效');};
 checkFeedback(...history);assert.throws(()=>checkFeedback(history[0],history[0],history[2]),/反馈未切断/);assert.throws(()=>checkFeedback(history[0],history[1],history[0]),/delay0 未生效/);
 return {events:true,brake:true,brakeMutantRed:true,slowRead:true,readMutantRed:true,slowInput:true,inputMutantRed:true,load:true,loadMutantRed:true,feedback:true,feedbackMutantRed:true,delay:true,delayMutantRed:true};
}
function run({archetype,seed,align,config}){
 const actor=context(archetype,seed),traits=actor.traits,make=o=>new BrakedDualBank(actor,makeRng(seed+10000),o);
 const a=Array.from({length:6},()=>make(config));
 const shadow=(config.enabled===false||(config.brake===false&&config.read===false))?Array.from({length:6},()=>new ModulatorBank(traits,makeRng(seed+10000))):[];
 const single=[],double=[];let identical=true,marginal=null;
 for(let tick=1;tick<=600;tick++){
  if(tick===20)for(const i of [1,4,5]){a[i].inject({arousal:.25});a[i].event(stressEvent,tick);}
  if(tick===80)for(const i of [0,1]){a[i].inject({arousal:.25});a[i].event(stressEvent,tick);}
  for(const b of a)b.tick();
  if(shadow.length){if(tick===20)for(const i of [1,4,5])shadow[i].inject({arousal:.25});if(tick===80)for(const i of [0,1])shadow[i].inject({arousal:.25});for(const b of shadow)b.tick();}
  if(tick===79&&align){for(const i of [0,1,3,4,5]){Object.assign(a[i].fast.m,a[2].fast.m);a[i].sync();if(shadow.length)Object.assign(shadow[i].m,shadow[2].m);}}
  if(tick===79)for(const [i,j] of [[0,3],[1,4],[4,5]]){assert.deepEqual(a[i].fast.m,a[j].fast.m,'末击前快状态不同');assert.deepEqual(a[i].dump(),a[j].dump(),'末击前慢状态不同');assert.deepEqual(a[i].fast.pending,a[j].fast.pending,'末击前注入不同');}
  for(let i=0;i<shadow.length;i++)assert.deepEqual(a[i].m,shadow[i].m,'关层或双切旧路径不同');
  if(tick===80){assert.deepEqual(a[4].m,a[5].m,'漏击副本不同');assert.deepEqual(a[4].dump(),a[5].dump(),'漏击慢状态不同');marginal={single:Math.abs(a[0].m.arousal-a[3].m.arousal),double:Math.abs(a[1].m.arousal-a[4].m.arousal),omitted:Math.abs(a[4].m.arousal-a[5].m.arousal)};}
  if(tick>=80){single.push(Math.abs(a[0].m.arousal-a[2].m.arousal));double.push(Math.abs(a[1].m.arousal-a[2].m.arousal));identical&&=DIMS.every(d=>Object.is(a[0].m[d],a[1].m[d]));}
 }
 if(config.enabled===false&&align)assert.equal(identical,true,'全关同流对齐负控失败');
 const s=measureRecovery(single),d=measureRecovery(double);
 return {archetype,seed,align,config,single:s,double:d,verdict:compareRecovery(s,d),identical,marginal,finalSlow:a.slice(0,3).map(b=>b.slow),finalLoad:a.slice(0,3).map(b=>b.load)};
}
const pulseControls=controls(),rows=[];
const samples=[['development',[7,11,13,23,42]],['known-a',[5,17,29,37,53]],['known-b',[2,19,41,61,73]],['known-c',[3,31,43,59,79]],['known-d',[83,89,97,101,103]],['known-e',[107,109,113,127,131]],['known-f',[137,139,149,151,157]],['known-g',[163,167,173,179,181]],['known-h',[191,193,197,199,211]],['known-i',[223,227,229,233,239]],['known-j',[241,251,257,263,269]],['known-k',[271,277,281,283,293]],['known-l',[307,311,313,317,331]],['known-m',[337,347,349,353,359]],['known-n',[367,373,379,383,389]],['new-seeds',[397,401,409,419,421]]];
for(const [sample,seeds] of samples)for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of seeds)for(const align of [true,false])
 for(const [arm,config] of [['full',{}],['brake-off',{brake:false}],['read-off',{read:false}],['slow-input-off',{slowInput:false}],['load-zero',{load:false}],['feedback-off',{feedback:false}],['delay-zero',{delay:0}],['brake-read-off',{brake:false,read:false}],['all-off',{enabled:false}]])
  rows.push({sample,arm,...run({archetype,seed,align,config})});
console.log(JSON.stringify({protocol:'600 更新；快仓自抑制与负荷敏化逐事件慢输入；十六批预登记样本均需通过',pulseControls,rows},null,2));
if(process.argv.includes('--gate')){
 const selected=rows.filter(r=>r.arm==='full'&&r.align),ids=selected.map(r=>`${r.sample}/${r.archetype}/${r.seed}`);
 const expected=samples.flatMap(([sample,seeds])=>['谨慎','冲动','孤僻'].flatMap(archetype=>seeds.map(seed=>`${sample}/${archetype}/${seed}`))).sort();
 const verify=actual=>assert.deepEqual([...actual].sort(),expected,'正式样本身份缺失、重复或替换');
 verify(ids);assert.equal(selected.length,240);assert.throws(()=>verify(ids.slice(1)));assert.throws(()=>verify([...ids.slice(0,-1),ids[0]]));
 const bad=selected.filter(r=>r.verdict!=='pass'||r.marginal.single<=.02||r.marginal.double<=.02||r.marginal.omitted!==0);
 assert.equal(bad.length,0,`完整门未通过：${bad.length}/${selected.length} 组不满足条件`);
}
