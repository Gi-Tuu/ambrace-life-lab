// 事后核对冲击本身是否有效；与恢复判据分开报告。
import {ProbeBank} from './m5-bank-probe.mjs';
import {sampleTraits} from './traits.mjs';
import {makeRng} from './rng.mjs';
const rows=[];
for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of [7,11,13,23,42])for(const isDouble of [false,true]){
 const tr=sampleTraits(makeRng(seed),archetype);
 const make=()=>new ProbeBank(tr,makeRng(seed+10000),{});
 const a=make(),b=make();
 for(let t=1;t<=80;t++){
  if(t===80||(isDouble&&t===20))a.inject({arousal:.25});
  a.tick();b.tick();if(t===79)Object.assign(a.m,b.m);
 }
 rows.push({archetype,seed,double:isDouble,impact:Math.abs(a.m.arousal-b.m.arousal)});
}
console.log(JSON.stringify(rows,null,2));
