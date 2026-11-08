// 新 M5 隔离候选。预登记后执行；不作为生产引擎、不改变原判据。
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {ProbeBank} from './m5-bank-probe.mjs';
import {hill} from './modulators.mjs';
import {M5_DEFAULTS} from './m5-slow.mjs';
import {measureRecovery,compareRecovery} from './m5-recovery-metrics.mjs';
import {DIMS,sampleTraits} from './traits.mjs';
import {makeRng,gauss} from './rng.mjs';
class LoadSetpointBank extends ProbeBank {
 constructor(traits,rng,{enabled=true,load=true,feedback=true,delay=8}={}){
  super(traits,rng,{enabled,load:false,feedback,delay});
  this.loadOn=load;this.load=0;
  if(!(traits.U_max>0))throw new RangeError('U_max 须为正');
 }
 tick(dt=1){
  if(dt!==1)throw new RangeError('探针仅支持逐次更新');
  const t=this.traits,P=M5_DEFAULTS;
  for(const d of DIMS){
   let cross=0;for(let j=0;j<DIMS.length;j++)cross+=(t.w[DIMS.indexOf(d)]?.[j]??0)*hill(this.x(DIMS[j]));
   let decay=-this.x(d)/t.tau[d];
   const inj=Math.max(-t.U_max,Math.min(t.U_max,this.pending[d]));
   let feedback=0;
   if(d==='arousal'&&this.slow.enabled){
    const s=this.slow.tick({fast:0,stress:inj});feedback=s.fast-inj;
    this.load=this.loadOn?Math.min(1,Math.max(0,this.load-this.load/P.loadTau+P.injection*Math.max(0,inj)/t.U_max)):0;
    if(this.load)decay=-(this.m[d]-(t.baseline[d]+(1-t.baseline[d])*this.load))/t.tau[d];
   }
   const raw=this.m[d]+dt*(decay+cross+inj+feedback)+gauss(this.rng)*t.noise[d]*dt;
   if(!Number.isFinite(raw))throw new RangeError('非有限快状态');
   this.m[d]=Math.max(0,Math.min(1,raw));this.pending[d]=0;
  }
 }
}
export function run({archetype,seed,align,config}){
 const traits=sampleTraits(makeRng(seed),archetype);
 const make=()=>new LoadSetpointBank(traits,makeRng(seed+10000),config);
 const a=[make(),make(),make()];
 // 当全关或锁 L 时，逐刻比较旧生产动力学或旧反馈动力学。
 const oldOptions=config.enabled===false?{enabled:false}:{load:false,feedback:config.feedback??true,delay:config.delay??8};
 const shadow=(config.enabled===false||config.load===false)?Array.from({length:3},()=>new ProbeBank(traits,makeRng(seed+10000),oldOptions)):[];
 const single=[],double=[];let identical=true;
 for(let t=1;t<=600;t++){
  for(const group of [a,shadow]){
   if(!group.length)continue;
   if(t===20)group[1].inject({arousal:.25});
   if(t===80)for(const i of [0,1])group[i].inject({arousal:.25});
   for(const b of group)b.tick();
   if(t===79&&align)for(const i of [0,1])Object.assign(group[i].m,group[2].m);
  }
  for(let i=0;i<shadow.length;i++)assert.deepEqual(a[i].m,shadow[i].m,`旧路径不等 ${archetype}/${seed}/${t}/${i}`);
  if(t>=80){single.push(Math.abs(a[0].m.arousal-a[2].m.arousal));double.push(Math.abs(a[1].m.arousal-a[2].m.arousal));
   identical&&=DIMS.every(d=>Object.is(a[0].m[d],a[1].m[d]));}
 }
 if(config.enabled===false&&align)assert.equal(identical,true,'全关同流对齐负控失败');
 const s=measureRecovery(single),d=measureRecovery(double);
 return {archetype,seed,align,config,single:s,double:d,verdict:compareRecovery(s,d),identical,finalLoad:a.map(b=>b.load)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
const rows=[];
for(const [sample,seeds] of [['development',[7,11,13,23,42]],['new-seeds',[5,17,29,37,53]]])
 for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of seeds)
  for(const align of [true,false])
   for(const [arm,config] of [['full',{}],['load-zero',{load:false}],['feedback-off',{feedback:false}],['delay-zero',{delay:0}],['all-off',{enabled:false}]])
    rows.push({sample,arm,...run({archetype,seed,align,config})});
console.log(JSON.stringify({protocol:'600 更新；冻结的新候选，开发种子与新种子分表；自然轨迹不作慢负荷归因',rows},null,2));
}
