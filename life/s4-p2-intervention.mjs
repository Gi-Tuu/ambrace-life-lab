// P2 需求干预：冻结 seed/窗口/干预/负控；2026-11-06 用户授权修订 P2。
// 测试可控能量状态能否进入条件决策，而非声称证明原警觉 MI 指标或长期自主性。
// 低/高能量 0.3/0.7；候选路径、记忆 bonus、风险、m 与温度固定；负控从两次 breakdown 删除 energy。
// 既是可独立运行的脚本，也是可被 sweep 按单颗种子调用的判据函数——两条入口共用同一段实现，
// 否则「扫描表里的 P2 列」和「P2 日志」会变成两套可以各自漂移的账。
import { simulate } from './run.mjs';
import { Organism } from './agent.mjs';
import { EpisodicMemory } from './memory.mjs';
import { visibleActions,scoreAll,temperatureOf,softmaxPick } from './model.mjs';
import { affordancesFor } from './body.mjs';
import { makeRng } from './rng.mjs';

// 默认协议：改动任一字段都会让历史日志失去可比性，所以在此冻结并随输出一起打印。
export const P2_PROTOCOL = { seeds:[7,11,21,31,41,51,61,71],ticks:400,stride:10,draws:128,low:.3,high:.7 };

function score(a,paths,bonus,risk,energy,cut){
 const d=Object.assign(Object.create(Object.getPrototypeOf(a.drives)),a.drives,{v:{...a.drives.v,energy}});
 const p=cut?{breakdown(action,r){const b=d.breakdown(action,r);delete b.energy;return b;}}:d;
 return scoreAll(paths,{drives:p,traits:a.traits,bank:a.bank,ch:a.ch,memBonus:bonus,risk});
}
function probs(scored,temp){const max=Math.max(...scored.map(x=>x.u)),v=scored.map(x=>Math.exp((x.u-max)/temp)),z=v.reduce((x,y)=>x+y,0);return new Map(scored.map((x,i)=>[x.id,v[i]/z]));}
function compare(x,y,temp,rng,draws){
 const a=probs(x,temp),b=probs(y,temp),keys=new Set([...a.keys(),...b.keys()]);let tv=0,disagree=0;
 for(const id of keys)tv+=Math.abs((a.get(id)??0)-(b.get(id)??0))/2;
 for(let i=0;i<draws;i++){const u=rng();if(softmaxPick(()=>u,x,temp).picked.id!==softmaxPick(()=>u,y,temp).picked.id)disagree++;}
 return {tv,disagree};
}
// 切断负控：把评分里的 energy 项整体删掉后，低/高两臂必须逐位相同。不成立说明干预根本没落在需求上。
export function assertCutNegative(rows){if(rows.some(x=>x.cutTv>1e-12||x.cutDisagree!==0))throw Error('能量评分切断负控失败');}

export async function p2Intervention(opts={}){
 const {seeds,ticks,stride,draws,low,high,channelMask=null}={...P2_PROTOCOL,...opts};
 const rows=[];
 const original=Organism.prototype.tick;
 try{for(const seed of seeds){
  Organism.prototype.tick=async function(world){const result=await original.call(this,world);if(world.t%stride!==0)return result;
  const aff=affordancesFor(world,this.id),weights=this.ch.precision?this.forwardModel.predict({m:this.bank.snapshot(),pending:{...this.bank.pending},traits:this.traits}).weights:null;
  const paths=visibleActions(aff,this.traits,this.ch,this.bank,weights);if(paths.length<2)return result;
  const mem=new EpisodicMemory();mem.rows=structuredClone(this.memory.rows);mem.failures=new Map(this.memory.failures);mem.kCap=this.memory.kCap;
  const bonus=mem.stateBonus(this.bank.m,aff,world.t,{stateChannel:Boolean(this.ch.mem),precision:weights}).bonus,temp=temperatureOf(this.traits,this.ch,this.bank),risk=this.viabilityRisk();
  const L=score(this,paths,bonus,risk,low,false),H=score(this,paths,bonus,risk,high,false),Lc=score(this,paths,bonus,risk,low,true),Hc=score(this,paths,bonus,risk,high,true);
  const gen=()=>makeRng(seed*100000+world.t*10+Number(this.id.slice(1)));const on=compare(L,H,temp,gen(),draws),off=compare(Lc,Hc,temp,gen(),draws);
  const e=scored=>{const p=probs(scored,temp);return scored.reduce((s,x)=>s+(p.get(x.id)??0)*(x.act.serves?.energy??0),0);};
  rows.push({seed,id:this.id,t:world.t,paths:paths.length,energyDiversity:new Set(paths.map(p=>p.serves?.energy??0)).size>1,tv:on.tv,disagree:on.disagree,cutTv:off.tv,cutDisagree:off.disagree,energyServiceDelta:e(L)-e(H)});return result;
  };
  await simulate({seed,ticks,condition:'C2',events:false,channelMask});
 }}finally{Organism.prototype.tick=original;}
 const bySeed=seeds.map(seed=>{const r=rows.filter(x=>x.seed===seed),avg=k=>r.reduce((s,x)=>s+x[k],0)/(r.length||1);return {seed,n:r.length,eligible:r.filter(x=>x.energyDiversity).length,meanTv:avg('tv'),meanEnergyServiceDelta:avg('energyServiceDelta'),disagree:r.reduce((s,x)=>s+x.disagree,0),cutDisagree:r.reduce((s,x)=>s+x.cutDisagree,0),maxCutTv:Math.max(0,...r.map(x=>x.cutTv))};});
 return {protocol:{seeds,ticks,stride,draws,low,high,scope:'C2 静默真实轨迹事后固定快照，条件概率分布的能量干预；非闭环',negative:'只移除评分中所有 energy 项，保留其他需求、风险和记忆；不通过外部设定模型全关',notes:['干预范围为人工设定且须评审合理性；不是自然状态变化或反射/习惯层的动作。','采样快照与同一世界内角色相关；配对抽样次数不是独立统计样本，不能直接据此计算显著性。','该干预不等价于旧警觉 MI，也不单独证明长期自主性；主动行为和动作熵另行保留。']},snapshots:rows.length,bySeed,rows};
}

if (process.argv[1]?.endsWith('s4-p2-intervention.mjs')) {
 const out = await p2Intervention();
 console.log(JSON.stringify(out,null,2));
 assertCutNegative(out.rows);
}
