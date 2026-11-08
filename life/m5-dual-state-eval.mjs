// 快慢分量隔离候选：快分量维持原 W，实际对外 arousal 合成为 clip(fast+slow)。
import assert from 'node:assert/strict';
import {ModulatorBank} from './modulators.mjs';
import {M5_DEFAULTS as P} from './m5-slow.mjs';
import {measureRecovery,compareRecovery} from './m5-recovery-metrics.mjs';
import {DIMS,sampleTraits} from './traits.mjs';
import {makeRng} from './rng.mjs';
class DualBank {
 constructor(traits,rng,{enabled=true,load=true,feedback=true,delay=8,read=true}={}){
  this.traits=traits;this.fast=new ModulatorBank(traits,rng);this.enabled=enabled;
  this.loadOn=load;this.feedback=feedback;this.delay=delay;this.read=read;this.slow=0;this.load=0;this.queue=[];
  if(!(traits.U_max>0)||!Number.isSafeInteger(delay)||delay<0)throw new RangeError('参数非法');
  this.sync();
 }
 sync(){this.m={...this.fast.m};if(this.enabled&&this.read)this.m.arousal=Math.max(0,Math.min(1,this.fast.m.arousal+this.slow));}
 inject(spec){this.fast.inject(spec);}
 tick(){
  const max=this.traits.U_max,inj=Math.max(-max,Math.min(max,this.fast.pending.arousal));
  this.fast.tick(1);
  if(this.enabled){
   const u=Math.max(0,inj)/max,previous=this.slow;
   this.load=this.loadOn?Math.min(1,Math.max(0,this.load-this.load/P.loadTau+P.injection*u)):0;
   if(this.delay>0){this.queue.push(previous);if(this.queue.length>this.delay)this.queue.shift();}
   const delayed=this.delay===0?previous:(this.queue.length>=this.delay?this.queue[0]:0);
   this.slow=Math.max(0,previous-previous/(P.slowTau*(1+P.loadGain*this.load))+P.injection*u-(this.feedback?P.feedback*delayed:0));
   if(!Number.isFinite(this.slow))throw new RangeError('非有限慢状态');
  }
  this.sync();
 }
 dump(){return {slow:this.slow,load:this.load,queue:[...this.queue]};}
}
function controls(){
 const traits=sampleTraits(makeRng(7),'谨慎');for(const d of DIMS)traits.noise[d]=0;
 traits.w=traits.w.map(row=>row.map(()=>0));
 const mk=x=>new DualBank(traits,makeRng(123),{load:false,...x});
 const a=[mk({}),mk({feedback:false}),mk({delay:0}),mk({read:false})],history=a.map(()=>[]);
 for(let t=1;t<=25;t++){
  if(t===1)for(const x of a)x.inject({arousal:.12});
  for(let i=0;i<a.length;i++){a[i].tick();history[i].push({s:a[i].slow,m:a[i].m.arousal});}
 }
 const [normal,cut,immediate,noRead]=history;
 const check=(n,c,z,r)=>{
  assert.ok(n.some((x,i)=>Math.abs(x.s-c[i].s)>1e-12),'反馈切断未改变 S');
  assert.ok(n.some((x,i)=>Math.abs(x.m-c[i].m)>1e-12),'反馈切断未改变 arousal');
  assert.ok(n.some((x,i)=>Math.abs(x.s-z[i].s)>1e-12),'delay=0 未改变 S');
  assert.ok(n.some((x,i)=>Math.abs(x.m-z[i].m)>1e-12),'delay=0 未改变 arousal');
  assert.ok(n.some((x,i)=>Math.abs(x.m-r[i].m)>1e-12),'慢分量读取未进入统一 arousal');
 };
 check(normal,cut,immediate,noRead);
 assert.throws(()=>check(normal,normal,immediate,noRead),/反馈切断/);
 assert.throws(()=>check(normal,cut,normal,noRead),/delay=0/);
 assert.throws(()=>check(normal,cut,immediate,normal),/慢分量读取/);
 return {ticks:25,feedback:true,delay:true,read:true,allThreeMutantsRed:true};
}
function run({archetype,seed,align,config}){
 const traits=sampleTraits(makeRng(seed),archetype),make=()=>new DualBank(traits,makeRng(seed+10000),config);
 // 单/双/参考/漏单末击/漏双末击/漏双末击副本
 const a=Array.from({length:6},make);
 const shadow=(config.enabled===false||config.read===false)?Array.from({length:6},()=>new ModulatorBank(traits,makeRng(seed+10000))):[];
 const single=[],double=[];let identical=true,marginal=null;
 for(let t=1;t<=600;t++){
  if(t===20)for(const i of [1,4,5])a[i].inject({arousal:.25});
  if(t===80)for(const i of [0,1])a[i].inject({arousal:.25});
  if(shadow.length){if(t===20)for(const i of [1,4,5])shadow[i].inject({arousal:.25});if(t===80)for(const i of [0,1])shadow[i].inject({arousal:.25});}
  for(const b of a)b.tick();for(const b of shadow)b.tick();
  if(t===79&&align){
   for(const i of [0,1,3,4,5]){Object.assign(a[i].fast.m,a[2].fast.m);a[i].sync();if(shadow.length)Object.assign(shadow[i].m,shadow[2].m);}
  }
  if(t===79)for(const [i,j] of [[0,3],[1,4],[4,5]]){
   assert.deepEqual(a[i].fast.m,a[j].fast.m,'末击前快状态不同');assert.deepEqual(a[i].dump(),a[j].dump(),'末击前慢状态不同');
   assert.deepEqual(a[i].fast.pending,a[j].fast.pending,'末击前待注入不同');
  }
  for(let i=0;i<shadow.length;i++)assert.deepEqual(a[i].m,shadow[i].m,'全关或切慢读数未逐位回退');
  if(t===80){assert.deepEqual(a[4].m,a[5].m,'漏击副本不同');assert.deepEqual(a[4].dump(),a[5].dump(),'漏击慢状态不同');
   marginal={single:Math.abs(a[0].m.arousal-a[3].m.arousal),double:Math.abs(a[1].m.arousal-a[4].m.arousal),omitted:Math.abs(a[4].m.arousal-a[5].m.arousal)};}
  if(t>=80){single.push(Math.abs(a[0].m.arousal-a[2].m.arousal));double.push(Math.abs(a[1].m.arousal-a[2].m.arousal));identical&&=DIMS.every(d=>Object.is(a[0].m[d],a[1].m[d]));}
 }
 if(config.enabled===false&&align)assert.equal(identical,true,'全关同流对齐负控失败');
 const s=measureRecovery(single),d=measureRecovery(double);
 return {archetype,seed,align,config,single:s,double:d,verdict:compareRecovery(s,d),identical,marginal,finalSlow:a.slice(0,3).map(b=>b.slow),finalLoad:a.slice(0,3).map(b=>b.load)};
}
const pulseControls=controls(),rows=[];
const samples=[['development',[7,11,13,23,42]],['known-a',[5,17,29,37,53]],['known-b',[2,19,41,61,73]],['known-c',[3,31,43,59,79]],['known-d',[83,89,97,101,103]],['new-seeds',[107,109,113,127,131]]];
for(const [sample,seeds] of samples)for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of seeds)for(const align of [true,false])
 for(const [arm,config] of [['full',{}],['load-zero',{load:false}],['feedback-off',{feedback:false}],['delay-zero',{delay:0}],['read-off',{read:false}],['all-off',{enabled:false}]])
  rows.push({sample,arm,...run({archetype,seed,align,config})});
console.log(JSON.stringify({protocol:'600 更新；快慢分量合成 arousal；六批预先登记',pulseControls,rows},null,2));
if(process.argv.includes('--gate')){
 const selected=rows.filter(r=>r.arm==='full'&&r.align),ids=selected.map(r=>`${r.sample}/${r.archetype}/${r.seed}`);
 const expected=samples.flatMap(([sample,seeds])=>['谨慎','冲动','孤僻'].flatMap(archetype=>seeds.map(seed=>`${sample}/${archetype}/${seed}`))).sort();
 const verify=actual=>assert.deepEqual([...actual].sort(),expected,'正式样本身份缺失、重复或替换');
 verify(ids);assert.throws(()=>verify(ids.slice(1)));assert.throws(()=>verify([...ids.slice(0,-1),ids[0]]));assert.throws(()=>verify([...ids.slice(0,-1),'new-seeds/谨慎/99999']));
 const bad=selected.filter(r=>r.verdict!=='pass'||r.marginal.single<=.02||r.marginal.double<=.02||r.marginal.omitted!==0);
 assert.equal(bad.length,0,`完整门未通过：${bad.length}/${selected.length} 组不满足条件`);
}
