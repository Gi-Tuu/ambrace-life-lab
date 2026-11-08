// 已揭盲 seed 的边界定点诊断；raw 全部在内存捕获，不改生产实现。
import assert from 'node:assert/strict';
import {ModulatorBank,hill} from './modulators.mjs';
import {DIMS,sampleTraits} from './traits.mjs';
import {makeRng,gauss} from './rng.mjs';
class TracedBank extends ModulatorBank{
 tick(dt=1){
  const t=this.traits;this.last={};
  for(const d of DIMS){
   let cross=0;for(let j=0;j<DIMS.length;j++)cross+=(t.w[DIMS.indexOf(d)]?.[j]??0)*hill(this.x(DIMS[j]));
   const before=this.m[d],decay=-this.x(d)/t.tau[d],inj=Math.max(-t.U_max,Math.min(t.U_max,this.pending[d]));
   const raw=before+dt*(decay+cross+inj)+gauss(this.rng)*t.noise[d]*dt;
   this.m[d]=Math.max(0,Math.min(1,raw));this.pending[d]=0;
   this.last[d]={before,decay,cross,inj,raw,output:this.m[d]};
  }
 }
}
const seed=173,archetype='冲动',traits=sampleTraits(makeRng(seed),archetype);
const traced=Array.from({length:3},()=>new TracedBank(traits,makeRng(seed+10000)));
const original=Array.from({length:3},()=>new ModulatorBank(traits,makeRng(seed+10000)));
let before80=null,at80=null;
for(let tick=1;tick<=600;tick++){
 if(tick===80){before80=traced.map(b=>({...b.m}));traced[0].inject({arousal:.25});original[0].inject({arousal:.25});}
 for(const b of traced)b.tick();for(const b of original)b.tick();
 if(tick===79){for(const i of [0,1]){Object.assign(traced[i].m,traced[2].m);Object.assign(original[i].m,original[2].m);}}
 for(let i=0;i<3;i++)assert.deepEqual(traced[i].m,original[i].m,`旧路径不一致 ${tick}/${i}`);
 if(tick===80){at80=traced.map(b=>b.last);assert.deepEqual(traced[1].m,traced[2].m,'漏击副本不一致');}
}
const hit=at80[0].arousal,no=at80[1].arousal;
console.log(JSON.stringify({protocol:'已揭盲冲动/173：同态同流末击与漏击；原 bank 逐 tick 验证',before80,hit,no,absorbedUpper:hit.raw>=1&&no.raw>=1&&hit.output===1&&no.output===1},null,2));
