// 事后核算历史两条曲线；此数据不是留出，不得作为新候选验收。
import assert from 'node:assert/strict';
import {ProbeBank,probe} from './m5-bank-probe.mjs';
import {measureRecovery,compareRecovery} from './m5-recovery-metrics.mjs';
import {DIMS,sampleTraits} from './traits.mjs';
import {makeRng} from './rng.mjs';
const rows=[];
for(const enabled of [true,false])for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of [7,11,13,23,42]){
 const traits=sampleTraits(makeRng(seed),archetype),options={enabled};
 const make=()=>new ProbeBank(traits,makeRng(seed+10000),options);
 const [single,double,reference]=[make(),make(),make()],ds=[],dd=[];
 for(let t=1;t<=600;t++){
  if(t===20)double.inject({arousal:.25});
  if(t===80)for(const a of [single,double])a.inject({arousal:.25});
  for(const a of [single,double,reference])a.tick();
  if(t===79)for(const a of [single,double])Object.assign(a.m,reference.m);
  if(t>=80){ds.push(Math.abs(single.m.arousal-reference.m.arousal));dd.push(Math.abs(double.m.arousal-reference.m.arousal));
   if(!enabled)assert.ok(DIMS.every(d=>Object.is(single.m[d],double.m[d])),'全关负控不相同');}
 }
 const s=measureRecovery(ds),d=measureRecovery(dd);
 assert.equal(s.first,probe({archetype,seed,align:true,options}).recovery,'单击历史未复现');
 assert.equal(d.first,probe({archetype,seed,align:true,double:true,options}).recovery,'双击历史未复现');
 rows.push({enabled,archetype,seed,single:s,double:d,verdict:compareRecovery(s,d)});
}
console.log(JSON.stringify({description:'已知历史数据的事后测量，非验收；末击前对齐',rows},null,2));
