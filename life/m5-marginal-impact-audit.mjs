// 事后检查旧候选末次打击的边际效应；同前史、同随机流，仅比较 tick 80 有无注入。
import assert from 'node:assert/strict';
import {FeedbackBank} from './m5-feedback-load-eval.mjs';
import {sampleTraits} from './traits.mjs';
import {makeRng} from './rng.mjs';
const rows=[];
for(const [sample,seeds] of [['development',[7,11,13,23,42]],['prior-known',[5,17,29,37,53]],['new-seeds',[2,19,41,61,73]]])
 for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of seeds){
  const traits=sampleTraits(makeRng(seed),archetype);
  const make=()=>new FeedbackBank(traits,makeRng(seed+10000),{});
  // single+/single0/double+/double0/double0-copy/reference
  const a=Array.from({length:6},make);
  for(let t=1;t<=80;t++){
   if(t===20)for(const i of [2,3,4])a[i].inject({arousal:.25});
   if(t===80)for(const i of [0,2])a[i].inject({arousal:.25});
   for(const b of a)b.tick();
   if(t===79){
    for(let i=0;i<5;i++)Object.assign(a[i].m,a[5].m);
    for(const [i,j] of [[0,1],[2,3],[3,4]]){
     assert.deepEqual(a[i].m,a[j].m,'末击前快状态不一致');
     assert.deepEqual(a[i].slow.dump(),a[j].slow.dump(),'末击前慢状态不一致');
     assert.equal(a[i].load,a[j].load,'末击前负荷不一致');
     assert.deepEqual(a[i].pending,a[j].pending,'末击前待处理输入不一致');
    }
   }
  }
  assert.deepEqual(a[3].m,a[4].m,'末击全漏掉时负控不为零');
  assert.deepEqual(a[3].slow.dump(),a[4].slow.dump(),'末击全漏掉时慢状态不一致');
  assert.equal(a[3].load,a[4].load,'末击全漏掉时负荷不一致');
  const single=Math.abs(a[0].m.arousal-a[1].m.arousal);
  const double=Math.abs(a[2].m.arousal-a[3].m.arousal);
  rows.push({sample,archetype,seed,single,double,omittedControl:Math.abs(a[3].m.arousal-a[4].m.arousal),valid:single>.02&&double>.02});
 }
console.log(JSON.stringify({protocol:'已揭盲历史的事后末击边际核验；80 次更新；同状态、同流、逐组切断末击',rows},null,2));
