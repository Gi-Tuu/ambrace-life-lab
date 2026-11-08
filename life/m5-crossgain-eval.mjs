// 全维交互增益负荷的隔离探针；原始四维耦合、输入/输出钳制与随机调用顺序保留。
import assert from 'node:assert/strict';
import {ProbeBank} from './m5-bank-probe.mjs';
import {hill} from './modulators.mjs';
import {M5_DEFAULTS} from './m5-slow.mjs';
import {measureRecovery,compareRecovery} from './m5-recovery-metrics.mjs';
import {DIMS,sampleTraits} from './traits.mjs';
import {makeRng,gauss} from './rng.mjs';

class CrossGainBank extends ProbeBank {
 constructor(traits,rng,{enabled=true,load=true,feedback=true,delay=8,multidim=true}={}){
  super(traits,rng,{enabled,load:false,feedback,delay});
  this.loadOn=load;this.multidim=multidim;this.load=0;
  if(!(traits.U_max>0))throw new RangeError('U_max 须为正');
 }
 tick(dt=1){
  if(dt!==1)throw new RangeError('仅支持逐次更新');
  const t=this.traits,P=M5_DEFAULTS;
  let arousalFeedback=0;
  if(this.slow.enabled){
   const inj=Math.max(-t.U_max,Math.min(t.U_max,this.pending.arousal));
   const s=this.slow.tick({fast:0,stress:inj});arousalFeedback=s.fast-inj;
   this.load=this.loadOn?Math.min(1,Math.max(0,this.load-this.load/P.loadTau+P.injection*Math.max(0,inj)/t.U_max)):0;
  }
  for(const d of DIMS){
   let cross=0;for(let j=0;j<DIMS.length;j++)cross+=(t.w[DIMS.indexOf(d)]?.[j]??0)*hill(this.x(DIMS[j]));
   if(this.slow.enabled&&this.load&&(this.multidim||d==='arousal'))cross/=1+P.loadGain*this.load;
   const decay=-this.x(d)/t.tau[d];
   const inj=Math.max(-t.U_max,Math.min(t.U_max,this.pending[d]));
   const feedback=d==='arousal'?arousalFeedback:0;
   const raw=this.m[d]+dt*(decay+cross+inj+feedback)+gauss(this.rng)*t.noise[d]*dt;
   if(!Number.isFinite(raw))throw new RangeError('非有限快状态');
   this.m[d]=Math.max(0,Math.min(1,raw));this.pending[d]=0;
  }
 }
}
function controlExperiment(){
 const t=sampleTraits(makeRng(7),'谨慎');
 for(const d of DIMS)t.noise[d]=0;
 t.w=t.w.map(row=>row.map(()=>0));
 const make=opts=>new CrossGainBank(t,makeRng(123),{load:false,...opts});
 const banks=[make({}),make({feedback:false}),make({delay:0})];
 const history=banks.map(()=>[]);
 for(let k=1;k<=25;k++){
  if(k===1)for(const b of banks)b.inject({arousal:.12});
  for(let i=0;i<banks.length;i++){banks[i].tick();history[i].push({s:banks[i].slow.slow,m:banks[i].m.arousal});}
 }
 const [normal,cut,immediate]=history;
 const check=(a,b,c)=>{
  assert.ok(a.some((v,i)=>Math.abs(v.s-b[i].s)>1e-12),'反馈切断未改变 S');
  assert.ok(a.some((v,i)=>Math.abs(v.m-b[i].m)>1e-12),'反馈切断未改变 arousal');
  assert.ok(a.some((v,i)=>Math.abs(v.s-c[i].s)>1e-12),'delay=0 未改变 S');
  assert.ok(a.some((v,i)=>Math.abs(v.m-c[i].m)>1e-12),'delay=0 未改变 arousal');
 };
 check(normal,cut,immediate);
 assert.throws(()=>check(normal,normal,immediate),/反馈切断/,'反馈开关失效未打红');
 assert.throws(()=>check(normal,cut,normal),/delay=0/,'延迟开关失效未打红');
 return {ticks:25,feedbackCutVerified:true,immediateVerified:true,feedbackMutantRed:true,delayMutantRed:true};
}
function run({archetype,seed,align,config}){
 const traits=sampleTraits(makeRng(seed),archetype);
 const make=()=>new CrossGainBank(traits,makeRng(seed+10000),config);
 // single+, double+, nohit reference, single0, double0, duplicate double0
 const a=Array.from({length:6},make);
 const oldOptions=config.enabled===false?{enabled:false}:{load:false,feedback:config.feedback??true,delay:config.delay??8};
 const shadow=(config.enabled===false||config.load===false)?Array.from({length:6},()=>new ProbeBank(traits,makeRng(seed+10000),oldOptions)):[];
 const single=[],double=[];let identical=true,marginal=null;
 for(let t=1;t<=600;t++){
  for(const group of [a,shadow]){
   if(!group.length)continue;
   if(t===20)for(const i of [1,4,5])group[i].inject({arousal:.25});
   if(t===80)for(const i of [0,1])group[i].inject({arousal:.25});
   for(const b of group)b.tick();
   if(t===79&&align)for(const i of [0,1,3,4,5])Object.assign(group[i].m,group[2].m);
  }
  if(t===79)for(const [i,j] of [[0,3],[1,4],[4,5]]){
   assert.deepEqual(a[i].m,a[j].m,'末击前快状态不同');assert.deepEqual(a[i].slow.dump(),a[j].slow.dump(),'末击前慢状态不同');
   assert.equal(a[i].load,a[j].load,'末击前负荷不同');assert.deepEqual(a[i].pending,a[j].pending,'末击前待注入不同');
  }
  for(let i=0;i<shadow.length;i++){
   assert.deepEqual(a[i].m,shadow[i].m,`L=0 或全关旧路径不同 ${archetype}/${seed}/${t}/${i}`);
   assert.deepEqual(a[i].slow.dump(),shadow[i].slow.dump(),`慢状态不同 ${archetype}/${seed}/${t}/${i}`);
  }
  if(t===80){
   assert.deepEqual(a[4].m,a[5].m,'漏末击副本不一致');assert.deepEqual(a[4].slow.dump(),a[5].slow.dump(),'漏击慢状态不一致');
   marginal={single:Math.abs(a[0].m.arousal-a[3].m.arousal),double:Math.abs(a[1].m.arousal-a[4].m.arousal),omitted:Math.abs(a[4].m.arousal-a[5].m.arousal)};
  }
  if(t>=80){single.push(Math.abs(a[0].m.arousal-a[2].m.arousal));double.push(Math.abs(a[1].m.arousal-a[2].m.arousal));identical&&=DIMS.every(d=>Object.is(a[0].m[d],a[1].m[d]));}
 }
 if(config.enabled===false&&align)assert.equal(identical,true,'全关同流对齐负控失败');
 const s=measureRecovery(single),d=measureRecovery(double),verdict=compareRecovery(s,d);
 return {archetype,seed,align,config,single:s,double:d,verdict,identical,marginal,finalLoad:a.slice(0,3).map(b=>b.load)};
}
const pulseControls=controlExperiment(),rows=[];
const samples=[['development',[7,11,13,23,42]],['known-a',[5,17,29,37,53]],['known-b',[2,19,41,61,73]],['known-c',[3,31,43,59,79]],['new-seeds',[83,89,97,101,103]]];
for(const [sample,seeds] of samples)for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of seeds)for(const align of [true,false])
 for(const [arm,config] of [['full',{}],['arousal-only',{multidim:false}],['load-zero',{load:false}],['feedback-off',{feedback:false}],['delay-zero',{delay:0}],['all-off',{enabled:false}]])
  rows.push({sample,arm,...run({archetype,seed,align,config})});
console.log(JSON.stringify({protocol:'600 更新；四维交互增益负荷；所有五批正式样本均需通过',pulseControls,rows},null,2));
if(process.argv.includes('--gate')){
 const selected=rows.filter(r=>r.arm==='full'&&r.align);
 assert.equal(selected.length,75,'正式样本数不完整');
 const ids=selected.map(r=>`${r.sample}/${r.archetype}/${r.seed}`);
 const expected=samples.flatMap(([sample,seeds])=>['谨慎','冲动','孤僻'].flatMap(archetype=>seeds.map(seed=>`${sample}/${archetype}/${seed}`))).sort();
 const validateIds=actual=>assert.deepEqual([...actual].sort(),expected,'正式样本身份缺失、重复或不在预登记名单');
 validateIds(ids);
 assert.throws(()=>validateIds(ids.slice(1)),/正式样本身份/,'缺失样本变异未打红');
 assert.throws(()=>validateIds([...ids.slice(0,-1),ids[0]]),/正式样本身份/,'重复样本变异未打红');
 assert.throws(()=>validateIds([...ids.slice(0,-1),'new-seeds/谨慎/99999']),/正式样本身份/,'替换身份变异未打红');
 const bad=selected.filter(r=>r.verdict!=='pass'||r.marginal.single<=.02||r.marginal.double<=.02||r.marginal.omitted!==0);
 assert.equal(bad.length,0,`完整闸门未通过：${bad.length}/${selected.length} 组不满足条件`);
}
