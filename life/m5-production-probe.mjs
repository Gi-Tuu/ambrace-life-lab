// 真引擎 M5 bank 对齐隔离候选：全部既定样本/消融逐组复现，非世界收益实验。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Organism} from './agent.mjs';
import {appraise} from './appraisal.mjs';
import {ModulatorBank} from './modulators.mjs';
import {M5ModulatorBank} from './m5-bank.mjs';
import {measureRecovery,compareRecovery} from './m5-recovery-metrics.mjs';
import {DIMS} from './traits.mjs';
import {makeRng} from './rng.mjs';
const event={kind:'shortfall',valence:-.25,violates:null,selfCaused:false,about:null,serves:'energy'};
const arms=new Map([['full',{}],['arousal-only',{multidim:false,symmetric:false}],['arousal-symmetric-only',{multidim:false,symmetric:true}],['brake-off',{brake:false}],['read-off',{read:false}],['slow-input-off',{slowInput:false}],['load-zero',{load:false}],['feedback-off',{feedback:false}],['delay-zero',{delay:0}],['brake-read-off',{brake:false,read:false}],['all-off',null]]);
const expected=JSON.parse(readFileSync('D:/Codex-Projects/output/ambrace-life-m5-global-brake-eval.log','utf8').replace(/^\uFEFF/,''));
const selected=expected.rows;let matched=0;const perArm={};
for(const old of selected){
 const {archetype,seed,align,arm}=old,opts=arms.get(arm);assert.ok(arms.has(arm),'未知消融档');
 const actor=new Organism({id:'a1',name:'岑',archetype,seed});
 const make=()=>opts===null?new ModulatorBank(actor.traits,makeRng(seed+10000)):new M5ModulatorBank(actor.traits,makeRng(seed+10000),undefined,opts);
 const a=Array.from({length:6},make),single=[],double=[];let marginal=null,identical=true;
 function hit(bank,tick){
  bank.inject({arousal:.25});
  if(opts!==null){const ctx={traits:actor.traits,drives:actor.drives,memory:actor.memory,relations:actor.relations,t:tick,m:bank.m};bank.observeEvent(event,appraise(event,ctx));}
 }
 const fast=b=>b.fast?.m??b.m;
 for(let tick=1;tick<=600;tick++){
  if(tick===20)for(const i of [1,4,5])hit(a[i],tick);
  if(tick===80)for(const i of [0,1])hit(a[i],tick);
  for(const b of a)b.tick();
  if(tick===79&&align)for(const i of [0,1,3,4,5])Object.assign(fast(a[i]),fast(a[2]));
  if(tick===80){assert.deepEqual({...a[4].m},{...a[5].m},'漏击副本不等');marginal={single:Math.abs(a[0].m.arousal-a[3].m.arousal),double:Math.abs(a[1].m.arousal-a[4].m.arousal),omitted:Math.abs(a[4].m.arousal-a[5].m.arousal)};}
  if(tick>=80){single.push(Math.abs(a[0].m.arousal-a[2].m.arousal));double.push(Math.abs(a[1].m.arousal-a[2].m.arousal));identical&&=DIMS.every(d=>Object.is(a[0].m[d],a[1].m[d]));}
 }
 const s=measureRecovery(single),d=measureRecovery(double),verdict=compareRecovery(s,d);
 for(const [name,actual,want] of [['single',s,old.single],['double',d,old.double],['marginal',marginal,old.marginal],['verdict',verdict,old.verdict],['identical',identical,old.identical]])
  assert.deepEqual(actual,want,`${archetype}/${seed}/${arm}/align=${align}/${name}`);
 matched++;perArm[arm]=(perArm[arm]??0)+1;
}
console.log(JSON.stringify({description:'真实 M5 bank 与已冻结隔离门：两种对齐条件、各消融、600 更新逐组端点与末击',matched,perArm},null,2));
