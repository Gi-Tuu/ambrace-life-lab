// 红闸门后的探索性诊断；不更改候选参数或验收阈值。
import {probe, ProbeBank} from './m5-bank-probe.mjs';
import {ModulatorBank} from './modulators.mjs';
import {sampleTraits} from './traits.mjs';
import {makeRng} from './rng.mjs';
import assert from 'node:assert/strict';
const counts=[];
for (const cross of [true,false]) for (const noise of [true,false]) for (const options of [{},{load:false},{enabled:false}]) {
 const pairs=[];
 for (const archetype of ['谨慎','冲动','孤僻']) for (const seed of [7,11,13,23,42]) {
  const a=probe({archetype,seed,double:false,align:true,options,cross,noise});
  const b=probe({archetype,seed,double:true,align:true,options,cross,noise});
  pairs.push({archetype,seed,single:a.recovery,double:b.recovery,singlePeak:a.peak,doublePeak:b.peak});
 }
 counts.push({cross,noise,options,longer:pairs.filter(p=>p.single!==null&&p.double!==null&&p.double>p.single).length,equal:pairs.filter(p=>p.single!==null&&p.double!==null&&p.double===p.single).length,shorter:pairs.filter(p=>p.single!==null&&p.double!==null&&p.double<p.single).length,censored:pairs.filter(p=>p.single===null||p.double===null).length,pairs});
}
// 关闭探针与原生产计算在同 traits、同流、相同注入上的逐刻/逐维比较。
let checked=0;
for(const archetype of ['谨慎','冲动','孤僻']) for(const seed of [7,11,13,23,42]) {
 const traits=sampleTraits(makeRng(seed),archetype);
 const a=new ModulatorBank(traits,makeRng(seed+10000));
 const b=new ProbeBank(traits,makeRng(seed+10000),{enabled:false});
 for(let tick=1;tick<=600;tick++) {
  if(tick===20||tick===80){a.inject({arousal:.25});b.inject({arousal:.25});}
  a.tick();b.tick();assert.deepEqual(b.m,a.m,`${archetype}/${seed}/${tick}`);assert.deepEqual(b.pending,a.pending);checked++;
 }
}
console.log(JSON.stringify({probeOffMatchesProductionUpdates:checked, counts},null,2));
