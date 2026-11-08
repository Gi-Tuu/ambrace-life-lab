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
const samples=[['development',[7,11,13,23,42]],['known-a',[5,17,29,37,53]],['known-b',[2,19,41,61,73]],['known-c',[3,31,43,59,79]],['known-d',[83,89,97,101,103]],['known-e',[107,109,113,127,131]],['known-f',[137,139,149,151,157]],['known-g',[163,167,173,179,181]],['known-h',[191,193,197,199,211]],['known-i',[223,227,229,233,239]],['known-j',[241,251,257,263,269]],['known-k',[271,277,281,283,293]],['known-l',[307,311,313,317,331]]];
const rows=[];
for(const [sample,seeds] of samples)for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of seeds){
 const traits=sampleTraits(makeRng(seed),archetype);
 const traced=Array.from({length:2},()=>new TracedBank(traits,makeRng(seed+10000)));
 const original=Array.from({length:2},()=>new ModulatorBank(traits,makeRng(seed+10000)));
 let before79=null;
 for(let tick=1;tick<=80;tick++){
  if(tick===80){traced[0].inject({arousal:.25});original[0].inject({arousal:.25});}
  for(const b of traced)b.tick();for(const b of original)b.tick();
  if(tick===79){Object.assign(traced[0].m,traced[1].m);Object.assign(original[0].m,original[1].m);before79={...traced[0].m};}
  for(let i=0;i<2;i++)assert.deepEqual(traced[i].m,original[i].m,`旧路径不一致 ${sample}/${archetype}/${seed}/${tick}/${i}`);
 }
 const hit=traced[0].last.arousal,no=traced[1].last.arousal,marginal=Math.abs(hit.output-no.output);
 rows.push({sample,archetype,seed,before79,hit,no,marginal,valid:marginal>.02,upper:hit.raw>=1&&no.raw>=1,lower:hit.raw<=0&&no.raw<=0});
}
console.log(JSON.stringify({protocol:'已知十三批：原四维系统、80 更新、末击正向同前态同流的边际可测性',rows},null,2));
