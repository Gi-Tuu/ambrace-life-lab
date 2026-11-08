// 预登记：真实 Organism.assess 同流受控测量，不是自然世界闭环。
// 留出：5 个未用于此候选设计的种子 × 三原型；单次末击 tick80，双击 tick20/80；600 更新。
// 六个同流角色：单击、双击、无击参考、单击漏末击、双击漏末击及其副本。
// 同流角色独立构造但消耗相同 RNG；不做行动。对齐组 tick79 仅对齐四维快仓；自然组不对齐。
// 原 0.02、连续5、首次及窗口持续入带、末击边际、样本身份保持；事件剂量由真实 appraisal 决定，历史可改变剂量。
// 同一 seed 的三原型不是独立随机样本；消融各自独立，输出全部结果。该装置不改任何引擎文件。
import assert from 'node:assert/strict';
import {Organism} from './agent.mjs';
import {DIMS} from './traits.mjs';
import {measureRecovery,compareRecovery} from './m5-recovery-metrics.mjs';
const event={kind:'shortfall',valence:-.25,violates:null,selfCaused:false,about:null,serves:'energy'};
const samples=[['heldout',[457,461,463,467,479]]];
const arms=[['full',{}],['brake-off',{m5Brake:0}],['read-off',{m5Read:0}],['slow-input-off',{m5SlowInput:0}],['load-zero',{m5Load:0}],['feedback-off',{m5Feedback:0}],['delay-zero',{m5Delay:0}],['all-off',{m5:0}]];
function run(archetype,seed,align,mask){
 const actors=Array.from({length:6},()=>{const a=new Organism({id:'a1',name:'岑',archetype,seed,channelMask:{m5:1,...mask}});a.world={t:0,agents:{}};return a;});
 const a=actors.map(x=>x.bank),fast=b=>b.fast??b;
 const single=[],double=[];let marginal,dose20=null,dose80=[];
 for(let tick=1;tick<=600;tick++){
  for(const actor of actors)actor.world.t=tick;
  if(tick===20)for(const i of [1,4,5]){const result=actors[i].assess(event);if(i===1)dose20=result.u;}
  if(tick===80)for(const i of [0,1])dose80.push(actors[i].assess(event).u);
  for(const b of a)b.tick();
  if(tick===79&&align)for(const i of [0,1,3,4,5])Object.assign(fast(a[i]).m,fast(a[2]).m);
  if(tick===79){for(const [i,j] of [[0,3],[1,4],[4,5]]){assert.deepEqual(fast(a[i]).m,fast(a[j]).m);assert.deepEqual(a[i].pending,a[j].pending);if(a[i].dumpM5)assert.deepEqual(a[i].dumpM5(),a[j].dumpM5());}}
  if(tick===80){assert.deepEqual(a[4].snapshot(),a[5].snapshot());marginal={single:Math.abs(a[0].m.arousal-a[3].m.arousal),double:Math.abs(a[1].m.arousal-a[4].m.arousal),omitted:Math.abs(a[4].m.arousal-a[5].m.arousal)};}
  if(tick>=80){single.push(Math.abs(a[0].m.arousal-a[2].m.arousal));double.push(Math.abs(a[1].m.arousal-a[2].m.arousal));}
 }
 const s=measureRecovery(single),d=measureRecovery(double);
 return {single:s,double:d,verdict:compareRecovery(s,d),marginal,dose20,dose80};
}
const rows=[];
for(const [sample,seeds] of samples)for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of seeds)for(const align of [true,false])for(const [arm,mask] of arms)rows.push({sample,archetype,seed,align,arm,...run(archetype,seed,align,mask)});
const selected=rows.filter(r=>r.arm==='full'&&r.align);
const identities=selected.map(r=>`${r.sample}/${r.archetype}/${r.seed}`).sort();
const expected=samples.flatMap(([sample,seeds])=>['谨慎','冲动','孤僻'].flatMap(archetype=>seeds.map(seed=>`${sample}/${archetype}/${seed}`))).sort();
assert.deepEqual(identities,expected);assert.equal(selected.length,15);
const bad=selected.filter(r=>r.verdict!=='pass'||r.marginal.single<=.02||r.marginal.double<=.02||r.marginal.omitted!==0);
console.log(JSON.stringify({protocol:'真实 assess 事件、20/80、600 更新；5 个新留出 seed × 3 原型，同流非世界闭环',bad:bad.length,rows},null,2));
if(process.argv.includes('--gate'))assert.equal(bad.length,0,`真实事件门未通过：${bad.length}/15`);
