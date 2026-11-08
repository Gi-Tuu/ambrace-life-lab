// 预登记：真实 simulate C2 + m5:1，seed 7/11/13/23/42、600 tick；只在确定性替身 choose 首次审议处观察。
// 使用真实已生成可见路径集、当前 drives/risk、traits、检索所得精确 memory bonus、同一温度及同一个真实抽样值。
// 唯一变化：评分用的 bank arousal 从 fast+S（截断）切到 fast；保留其它维度，重新调用真实 scoreAll。
// 计算相对分差、softmax 概率与同一随机数选中变化；不改真实决策，明确排除反射、习惯和驳回重选。
// 负控独立关闭 util：切换评分 bank 不应影响评分，逐行严格相等；真实评分重算必须逐行精确复现。
// 只隔离评分读取，不连带切刺激需求、可见性、记忆或温度通道；不声称全路径或因果世界轨迹。
// 包装装置 seed7 跟未包装真实 simulate 逐动作/存续摘要一致；其他 seed 为观察集，不是独立因果复现实验。
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Organism} from './agent.mjs';
import {EpisodicMemory} from './memory.mjs';
import {scoreAll,softmaxPick} from './model.mjs';
import {simulate} from './run.mjs';
const bonus=new WeakMap(), rows=[];
const oldMem=EpisodicMemory.prototype.stateBonus,oldChoose=Organism.prototype.choose;
let wrapped=false;
function snapshot({world,agents}){return createHash('sha256').update(JSON.stringify({t:world.t,pantry:world.pantry,stash:world.stash,loc:world.loc,agents:Object.fromEntries(Object.entries(agents).map(([id,a])=>[id,{actions:a.trace.filter(x=>x.action),counters:a.counters,viab:a.viab.dump()}]))})).digest('hex');}
function prob(scored,temp){const max=Math.max(...scored.map(x=>x.u)),w=scored.map(x=>Math.exp((x.u-max)/temp)),z=w.reduce((x,y)=>x+y,0);return Object.fromEntries(scored.map((s,i)=>[s.id,w[i]/z]));}
function compare(a,b){assert.equal(a.length,b.length);const bm=new Map(b.map(x=>[x.id,x.u]));for(const x of a)assert.equal(x.u,bm.get(x.id),'实际评分不能逐项精确复现');}
function install(){
 EpisodicMemory.prototype.stateBonus=function(...args){const r=oldMem.call(this,...args);bonus.set(this,r.bonus);return r;};
 Organism.prototype.choose=async function(args){
  if(args.rejected||!this.ch.m5||this.deliberator||args.paths.length<2)return oldChoose.call(this,args);
  const {scored,temp,paths,world,ch}=args,mb=bonus.get(this.memory),m=this.bank.snapshot(),fast={...this.bank.fast.m};
  assert.ok(mb);const bank={m:fast,x:d=>fast[d]-this.traits.baseline[d]};
  const common={drives:this.drives,traits:this.traits,ch,memBonus:mb,risk:this.viabilityRisk()};
  const actual=scoreAll(paths,{...common,bank:this.bank});compare(scored,actual);
  const cut=scoreAll(paths,{...common,bank});
  const zero={...ch,util:0},negativeA=scoreAll(paths,{...common,ch:zero,bank:this.bank}),negativeB=scoreAll(paths,{...common,ch:zero,bank});compare(negativeA,negativeB);
  let draw=null;const oldRng=this.rng;
  this.rng=()=>{assert.equal(draw,null);draw=oldRng();return draw;};
  let selected;try{selected=await oldChoose.call(this,args);}finally{this.rng=oldRng;}
  assert.notEqual(draw,null);const actualPick=softmaxPick(()=>draw,actual,temp).picked.id,cutPick=softmaxPick(()=>draw,cut,temp).picked.id;
  assert.equal(selected.id,actualPick);
  const ap=prob(actual,temp),cp=prob(cut,temp),base=actual[0].id,cu=new Map(cut.map(x=>[x.id,x.u]));
  const relative=Math.max(...actual.map(x=>Math.abs((x.u-actual[0].u)-(cu.get(x.id)-cu.get(base)))));
  const tv=Object.keys(ap).reduce((s,id)=>s+Math.abs(ap[id]-cp[id]),0)/2;
  rows.push({seed:currentSeed,t:world.t,id:this.id,slow:this.bank.slow,arousal:m.arousal,fastArousal:fast.arousal,temp,draw,actualPick,cutPick,relative,tv,paths:actual.map(x=>({id:x.id,kind:x.kind,u:x.u,cut:cu.get(x.id),p:ap[x.id],cutP:cp[x.id]}))});
  return selected;
 };
 wrapped=true;
}
function uninstall(){EpisodicMemory.prototype.stateBonus=oldMem;Organism.prototype.choose=oldChoose;wrapped=false;}
let currentSeed=7;
try{
 const plain=await simulate({seed:7,ticks:600,condition:'C2',channelMask:{m5:1}}),hash=snapshot(plain);
 install();
 for(const seed of [7,11,13,23,42]){currentSeed=seed;const result=await simulate({seed,ticks:600,condition:'C2',channelMask:{m5:1}});if(seed===7)assert.equal(snapshot(result),hash,'包装改变真实世界轨迹');}
}finally{if(wrapped)uninstall();}
const affected=rows.filter(x=>x.relative>1e-12),picked=rows.filter(x=>x.actualPick!==x.cutPick);
console.log(JSON.stringify({protocol:'真实候选同前态，仅切评分 arousal 读取；固定需求、记忆、候选、温度和随机数；不覆盖习惯反射、可见性等通道',controlPassed:true,seed7TraceIdentical:true,total:rows.length,relativeChanged:affected.length,probChanged:rows.filter(x=>x.tv>1e-12).length,pickChanged:picked.length,maxTv:Math.max(...rows.map(x=>x.tv)),maxRelative:Math.max(...rows.map(x=>x.relative)),bySeed:Object.fromEntries([7,11,13,23,42].map(s=>[s,{total:rows.filter(x=>x.seed===s).length,changed:rows.filter(x=>x.seed===s&&x.relative>1e-12).length,pickChanged:rows.filter(x=>x.seed===s&&x.actualPick!==x.cutPick).length}])),rows},null,2));
