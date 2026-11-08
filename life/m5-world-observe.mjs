// 预登记：固定 7/11/13/23/42，C2，600 tick，3 角色；默认与 M5 比较采用相同初始 seed 和初始 traits。
// 两组动态行为改变会令共享随机流消费分叉，结果是自然世界观察，不是逐刻同流因果证明。
// 每角色每 tick 后采 S/L、合并 arousal 饱和(>=1)，包括反射未推进刻；报告行动种类、存续、关系和 S4 更新误差。
// S4 为预测训练期 MAE，非留出验收；默认定制循环须与 simulate 同 mask 默认完整行为摘要一致。
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {makeWorld,spawn,scanSecrets} from './body.mjs';
import {socialRound} from './social.mjs';
import {Organism} from './agent.mjs';
import {ForwardModel} from './s4-predictor.mjs';
import {hashSeed} from './rng.mjs';
import {simulate} from './run.mjs';
const roster=[{id:'a1',name:'岑',archetype:'谨慎',loc:'home'},{id:'a2',name:'绛',archetype:'冲动',loc:'hall'},{id:'a3',name:'蓑',archetype:'孤僻',loc:'watch'}];
const dims=['arousal','valence','certainty','dominance'];
let active=null;const oldObs=ForwardModel.prototype.observe;
ForwardModel.prototype.observe=function(input,prediction,actual){
 if(active){active.s4n++;for(const d of Object.keys(prediction.mu)){active.s4abs[d]=(active.s4abs[d]??0)+Math.abs(actual[d]-prediction.mu[d]);}}
 return oldObs.call(this,input,prediction,actual);
};
function digest({world,agents}){
 const v={t:world.t,pantry:world.pantry,stash:world.stash,loc:world.loc,expect:world.expect,agents:Object.fromEntries(Object.entries(agents).map(([id,a])=>[id,{actions:a.trace.filter(r=>r.action),counters:a.counters,viab:a.viab.dump()}]))};
 return createHash('sha256').update(JSON.stringify(v)).digest('hex');
}
async function trial(seed,on){
 const world=makeWorld({pantries:6,stash:3});const agents={},stats={};
 for(const r of roster){
  // 两侧使用 simulate 中 m5:0 的 seed 标签，初态一致；仅真实 M5 掩码不同。
  const a=new Organism({...r,seed:hashSeed(seed,`${r.id}:C2:${JSON.stringify({m5:0})}`),condition:'C2',channelMask:{m5:on?1:0}});
  agents[r.id]=world.agents[r.id]=a;spawn(world,r.id,r.loc);
  stats[r.id]={ticks:0,sat:0,slowSum:0,slowMax:0,loadSum:0,loadMax:0,s4n:0,s4abs:{}};
 }
 for(let t=1;t<=600;t++){
  world.t=t;world.percepts=[];
  if(t%97===0)world.percepts.push({for:'all',kind:'alarm',subject:'墙外',salience:.9});
  if(t%55===0)world.pantry=Math.min(8,world.pantry+2);
  scanSecrets(world);
  for(const id of Object.keys(agents)){
   const a=agents[id],s=stats[id];active=s;await a.tick(world);active=null;
   s.ticks++;s.sat+=a.bank.m.arousal>=1?1:0;
   const slow=a.bank.slow??0,load=a.bank.load??0;
   s.slowSum+=slow;s.slowMax=Math.max(s.slowMax,slow);s.loadSum+=load;s.loadMax=Math.max(s.loadMax,load);
  }
 }
 if(world.socialGossip>0)socialRound(world,{presence:false});
 const summary=Object.fromEntries(Object.entries(agents).map(([id,a])=>{
  const s=stats[id],actions={};for(const row of a.trace)if(row.action)actions[row.kind]=(actions[row.kind]??0)+1;
  return [id,{actions,counters:a.counters,viability:a.viab.dump(),relations:a.relations.dump(600),sat:s.sat,satDenom:s.ticks,slowMean:s.slowSum/s.ticks,slowMax:s.slowMax,loadMean:s.loadSum/s.ticks,loadMax:s.loadMax,s4Samples:s.s4n,s4TrainMae:Object.fromEntries(Object.entries(s.s4abs).map(([d,x])=>[d,x/s.s4n]))}];
 }));
 return {world,agents,summary};
}
const rows=[];
try{
 for(const seed of [7,11,13,23,42]){
  const off=await trial(seed,false),on=await trial(seed,true);
  if(seed===7){const base=await simulate({seed,ticks:600,condition:'C2',channelMask:{m5:0}});assert.equal(digest(off),digest(base),'模拟装置与正式 simulate 不等价');}
  rows.push({seed,off:off.summary,on:on.summary});
 }
}finally{ForwardModel.prototype.observe=oldObs;}
console.log(JSON.stringify({protocol:'600 ticks, 5 seed, 3 角色; 相同初始随机种子，动态 RNG 可分叉; S4 训练期误差非留出验收; tick 后饱和包含反射刻',baselineMatch:true,rows},null,2));
