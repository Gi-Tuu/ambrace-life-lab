// 隔离候选：慢状态追踪警觉相对个体基线，负荷改变追踪速度、延迟反馈改真实警觉。
import assert from 'node:assert/strict';
import {ProbeBank} from './m5-bank-probe.mjs';
import {hill} from './modulators.mjs';
import {M5_DEFAULTS as P} from './m5-slow.mjs';
import {measureRecovery,compareRecovery} from './m5-recovery-metrics.mjs';
import {DIMS,sampleTraits} from './traits.mjs';
import {makeRng,gauss} from './rng.mjs';
class TrackingBank extends ProbeBank {
 constructor(traits,rng,{enabled=true,load=true,feedback=true,delay=8,ignoreLoad=false}={}){
  super(traits,rng,{enabled,load:false,feedback,delay});this.loadOn=load;this.load=0;this.ignoreLoad=ignoreLoad;
  if(!(traits.U_max>0))throw new RangeError('U_max 须为正');
 }
 tick(dt=1){
  if(dt!==1)throw new RangeError('仅支持逐次更新');
  const t=this.traits;let fb=0;
  if(this.slow.enabled){
   const inj=Math.max(-t.U_max,Math.min(t.U_max,this.pending.arousal));
   this.load=this.loadOn?Math.min(1,Math.max(0,this.load-this.load/P.loadTau+P.injection*Math.max(0,inj)/t.U_max)):0;
   const previous=this.slow.slow,x=this.m.arousal-t.baseline.arousal;
   if(this.slow.delay>0){this.slow.queue.push(previous);if(this.slow.queue.length>this.slow.delay)this.slow.queue.shift();}
   const delayed=this.slow.delay===0?previous:(this.slow.queue.length>=this.slow.delay?this.slow.queue[0]:0);
   const effective=this.ignoreLoad?0:this.load;
   this.slow.slow=previous+(x-previous)/(P.slowTau*(1+P.loadGain*effective));
   fb=this.slow.feedbackEnabled?-P.feedback*delayed:0;
  }
  for(const d of DIMS){
   let cross=0;for(let j=0;j<DIMS.length;j++)cross+=(t.w[DIMS.indexOf(d)]?.[j]??0)*hill(this.x(DIMS[j]));
   const decay=-this.x(d)/t.tau[d],inj=Math.max(-t.U_max,Math.min(t.U_max,this.pending[d]));
   const raw=this.m[d]+dt*(decay+cross+inj+(d==='arousal'?fb:0))+gauss(this.rng)*t.noise[d]*dt;
   if(!Number.isFinite(raw)||!Number.isFinite(this.slow.slow))throw new RangeError('非有限状态');
   this.m[d]=Math.max(0,Math.min(1,raw));this.pending[d]=0;
  }
 }
}
function controls(){
 const t=sampleTraits(makeRng(7),'谨慎');for(const d of DIMS)t.noise[d]=0;t.w=t.w.map(row=>row.map(()=>0));
 const mk=o=>new TrackingBank(t,makeRng(123),o);
 for(const sign of [1,-1]){
  const b=mk({});b.m.arousal=t.baseline.arousal+sign*.1;b.tick();
  assert.ok(sign*b.slow.slow>0,'无事件下 S 未追踪真实状态的符号');
 }
 const compareLoad=(a,b)=>{
  a.m.arousal=b.m.arousal=t.baseline.arousal+.1;a.load=.5;b.load=0;a.tick();b.tick();
  assert.ok(Math.abs(a.slow.slow)<Math.abs(b.slow.slow),'实际 tick 未消费负荷以降低 S 追踪率');
 };
 compareLoad(mk({}),mk({}));
 assert.throws(()=>compareLoad(mk({ignoreLoad:true}),mk({})),/实际 tick 未消费负荷/,'移除消费者未打红');
 const a=[mk({load:false}),mk({load:false,feedback:false}),mk({load:false,delay:0})],history=a.map(()=>[]);
 for(let tick=1;tick<=30;tick++){
  if(tick===1)for(const b of a)b.inject({arousal:.12});
  for(let i=0;i<a.length;i++){a[i].tick();history[i].push({s:a[i].slow.slow,m:a[i].m.arousal});}
 }
 const check=(normal,off,immediate)=>{
  assert.ok(normal.some((v,i)=>Math.abs(v.m-off[i].m)>1e-12),'反馈切断未改变 arousal');
  assert.ok(normal.some((v,i)=>Math.abs(v.m-immediate[i].m)>1e-12),'delay=0 未改变 arousal');
 };
 check(...history);assert.throws(()=>check(history[0],history[0],history[2]),/反馈切断/);assert.throws(()=>check(history[0],history[1],history[0]),/delay=0/);
 return {signs:true,realTickLoad:true,removedConsumerRed:true,feedback:true,delay:true,feedbackMutantRed:true,delayMutantRed:true};
}
function run({archetype,seed,align,config}){
 const traits=sampleTraits(makeRng(seed),archetype),make=()=>new TrackingBank(traits,makeRng(seed+10000),config);
 const a=Array.from({length:6},make);
 const shadow=(config.enabled===false||config.feedback===false)?Array.from({length:6},()=>new ProbeBank(traits,makeRng(seed+10000),{enabled:false})):[];
 const single=[],double=[];let identical=true,marginal=null;
 for(let tick=1;tick<=600;tick++){
  for(const group of [a,shadow]){
   if(!group.length)continue;
   if(tick===20)for(const i of [1,4,5])group[i].inject({arousal:.25});
   if(tick===80)for(const i of [0,1])group[i].inject({arousal:.25});
   for(const b of group)b.tick();
   if(tick===79&&align)for(const i of [0,1,3,4,5])Object.assign(group[i].m,group[2].m);
  }
  if(tick===79)for(const [i,j] of [[0,3],[1,4],[4,5]]){
   assert.deepEqual(a[i].m,a[j].m,'末击前快状态不同');assert.deepEqual(a[i].slow.dump(),a[j].slow.dump(),'末击前慢状态不同');
   assert.equal(a[i].load,a[j].load,'末击前负荷不同');assert.deepEqual(a[i].pending,a[j].pending,'末击前待注入不同');
  }
  for(let i=0;i<shadow.length;i++)assert.deepEqual(a[i].m,shadow[i].m,'反馈关或全关旧路径不同');
  if(tick===80){assert.deepEqual(a[4].m,a[5].m,'漏击副本不同');assert.deepEqual(a[4].slow.dump(),a[5].slow.dump(),'漏击慢状态不同');
   marginal={single:Math.abs(a[0].m.arousal-a[3].m.arousal),double:Math.abs(a[1].m.arousal-a[4].m.arousal),omitted:Math.abs(a[4].m.arousal-a[5].m.arousal)};}
  if(tick>=80){single.push(Math.abs(a[0].m.arousal-a[2].m.arousal));double.push(Math.abs(a[1].m.arousal-a[2].m.arousal));identical&&=DIMS.every(d=>Object.is(a[0].m[d],a[1].m[d]));}
 }
 if(config.enabled===false&&align)assert.equal(identical,true,'全关同流对齐负控失败');
 const s=measureRecovery(single),d=measureRecovery(double);
 return {archetype,seed,align,config,single:s,double:d,verdict:compareRecovery(s,d),identical,marginal,finalLoad:a.slice(0,3).map(b=>b.load)};
}
const pulseControls=controls(),rows=[];
const samples=[['development',[7,11,13,23,42]],['known-a',[5,17,29,37,53]],['known-b',[2,19,41,61,73]],['known-c',[3,31,43,59,79]],['known-d',[83,89,97,101,103]],['known-e',[107,109,113,127,131]],['known-f',[137,139,149,151,157]],['known-g',[163,167,173,179,181]],['known-h',[191,193,197,199,211]],['new-seeds',[223,227,229,233,239]]];
for(const [sample,seeds] of samples)for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of seeds)for(const align of [true,false])
 for(const [arm,config] of [['full',{}],['load-zero',{load:false}],['feedback-off',{feedback:false}],['delay-zero',{delay:0}],['all-off',{enabled:false}]])
  rows.push({sample,arm,...run({archetype,seed,align,config})});
console.log(JSON.stringify({protocol:'600 更新；S 追踪真实警觉偏差；所有十批正式样本均需通过',pulseControls,rows},null,2));
if(process.argv.includes('--gate')){
 const selected=rows.filter(r=>r.arm==='full'&&r.align),ids=selected.map(r=>`${r.sample}/${r.archetype}/${r.seed}`);
 const expected=samples.flatMap(([sample,seeds])=>['谨慎','冲动','孤僻'].flatMap(archetype=>seeds.map(seed=>`${sample}/${archetype}/${seed}`))).sort();
 const verify=actual=>assert.deepEqual([...actual].sort(),expected,'正式样本身份缺失、重复或替换');
 verify(ids);assert.equal(selected.length,150);assert.throws(()=>verify(ids.slice(1)));assert.throws(()=>verify([...ids.slice(0,-1),ids[0]]));
 const bad=selected.filter(r=>r.verdict!=='pass'||r.marginal.single<=.02||r.marginal.double<=.02||r.marginal.omitted!==0);
 assert.equal(bad.length,0,`完整门未通过：${bad.length}/${selected.length} 组不满足条件`);
}
