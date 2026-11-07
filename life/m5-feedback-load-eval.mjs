// 第二候选：负荷分别作用于回归目标与内源回馈增益。隔离验证，不接生产。
import assert from 'node:assert/strict';
import {ProbeBank} from './m5-bank-probe.mjs';
import {run as oldRun} from './m5-setpoint-eval.mjs';
import {hill} from './modulators.mjs';
import {M5_DEFAULTS} from './m5-slow.mjs';
import {measureRecovery,compareRecovery} from './m5-recovery-metrics.mjs';
import {DIMS,sampleTraits} from './traits.mjs';
import {makeRng,gauss} from './rng.mjs';
class FeedbackBank extends ProbeBank {
 constructor(traits,rng,{enabled=true,load=true,feedback=true,delay=8,setpoint=true,gain=true}={}){
  super(traits,rng,{enabled,load:false,feedback,delay});
  this.loadOn=load;this.setpointOn=setpoint;this.gainOn=gain;this.load=0;
  if(!(traits.U_max>0))throw new RangeError('U_max 须为正');
 }
 tick(dt=1){
  if(dt!==1)throw new RangeError('探针仅支持逐次更新');
  const t=this.traits,P=M5_DEFAULTS;
  for(const d of DIMS){
   let cross=0;
   for(let j=0;j<DIMS.length;j++){
    let w=t.w[DIMS.indexOf(d)]?.[j]??0;
    if(d==='arousal'&&DIMS[j]==='quiescence'&&this.slow.enabled&&this.gainOn&&this.load)w/=1+P.loadGain*this.load;
    cross+=w*hill(this.x(DIMS[j]));
   }
   let decay=-this.x(d)/t.tau[d];
   const inj=Math.max(-t.U_max,Math.min(t.U_max,this.pending[d]));let feedback=0;
   if(d==='arousal'&&this.slow.enabled){
    const s=this.slow.tick({fast:0,stress:inj});feedback=s.fast-inj;
    this.load=this.loadOn?Math.min(1,Math.max(0,this.load-this.load/P.loadTau+P.injection*Math.max(0,inj)/t.U_max)):0;
    if(this.setpointOn&&this.load)decay=-(this.m[d]-(t.baseline[d]+(1-t.baseline[d])*this.load))/t.tau[d];
   }
   const raw=this.m[d]+dt*(decay+cross+inj+feedback)+gauss(this.rng)*t.noise[d]*dt;
   if(!Number.isFinite(raw))throw new RangeError('非有限快状态');
   this.m[d]=Math.max(0,Math.min(1,raw));this.pending[d]=0;
  }
 }
}
function run({archetype,seed,align,config}){
 const traits=sampleTraits(makeRng(seed),archetype);
 const make=()=>new FeedbackBank(traits,makeRng(seed+10000),config);
 const a=[make(),make(),make()];
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
 if(config.gain===false&&config.setpoint!==false&&config.load!==false&&config.enabled!==false){
  const prev=oldRun({archetype,seed,align,config:{}});
  assert.deepEqual(s,prev.single,'目标单消费者单击不一致');assert.deepEqual(d,prev.double,'目标单消费者双击不一致');
 }
 return {archetype,seed,align,config,single:s,double:d,verdict:compareRecovery(s,d),identical,finalLoad:a.map(b=>b.load)};
}
const rows=[];
for(const [sample,seeds] of [['development',[7,11,13,23,42]],['prior-known',[5,17,29,37,53]],['new-seeds',[2,19,41,61,73]]])
 for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of seeds)for(const align of [true,false])
  for(const [arm,config] of [['full',{}],['target-only',{gain:false}],['gain-only',{setpoint:false}],['load-zero',{load:false}],['feedback-off',{feedback:false}],['delay-zero',{delay:0}],['all-off',{enabled:false}]])
   rows.push({sample,arm,...run({archetype,seed,align,config})});
console.log(JSON.stringify({protocol:'600 更新，保留交叉回馈；预登记的独立消费者与负控；新验证种子分列',rows},null,2));

// 预登记完整闸门：只检查未用于设计的新种子，缺失或未确认都不放行。
if(process.argv.includes('--gate')){
 const selected=rows.filter(r=>r.sample==='new-seeds'&&r.arm==='full'&&r.align);
 assert.equal(selected.length,15,'新种子样本不完整');
 const bad=selected.filter(r=>r.verdict!=='pass');
 assert.equal(bad.length,0,`双端点闸门未通过：${bad.length}/${selected.length} 组不满足严格延长`);
}
