// 探索性：按动作类别分组轮询检索；对照原逻辑。不是已注册验收。
// 每组按既有分数排序，组按各自最高分降序；每轮每组一条，总量不超过 kCap。
// 无 actionKind/不可用动作归入独立的非关联组，保持原数据，不参加动作 bonus。
// 成功和失败当前没有记入记忆行；此算法不区分它们，也不能证明解决成败语义。
import {simulate} from './run.mjs'; import {Organism} from './agent.mjs'; import {EpisodicMemory} from './memory.mjs';
import {mutualInfo,miNull,actionEntropy,ruleCoverage} from './metrics.mjs'; import {affordancesFor} from './body.mjs';
import {visibleActions,scoreAll,temperatureOf,softmaxPick} from './model.mjs'; import {makeRng} from './rng.mjs'; import {DIMS} from './traits.mjs';
const seeds=[7,11,21,31,41],ticks=1200,outputs=[];
const origRet=EpisodicMemory.prototype.retrieve,origBonus=EpisodicMemory.prototype.stateBonus, origTick=Organism.prototype.tick;
function fairRet(m,candidates,t,k=3,opts={}){
 const group=new Map(), names=new Set(candidates.map(c=>c.kind));
 for(const r of this.rows){const eligible=r.actionKind&&names.has(r.actionKind);const key=eligible?r.actionKind:'\u0000other';
  const s=this.score(r,m,eligible?candidates:[],t,opts.precision);
  if(opts.stateChannel===false)s.total=.3*s.recency+.25*r.importance+.3*s.relevance;
  const arr=group.get(key)??[];arr.push({r,s});group.set(key,arr);
 }
 const queues=[...group].map(([key,v])=>({key,v:v.sort((a,b)=>b.s.total-a.s.total)})).sort((a,b)=>b.v[0].s.total-a.v[0].s.total||a.key.localeCompare(b.key));
 const top=[]; const cap=Math.min(k,this.kCap);while(top.length<cap&&queues.some(q=>q.v.length)){for(const q of queues){if(top.length>=cap)break;if(q.v.length)top.push(q.v.shift());}}
 if(!top.length)this.rows.forEach(r=>this.failures.set(r.id,(this.failures.get(r.id)??0)+1));top.forEach(x=>this.touchHit(x.r.id));return top;
}
function fairBonus(m,candidates,t,opts){
 const top=this.retrieve(m,candidates,t,6,opts), groups=new Map();
 for(const {r,s} of top){if(!r.actionKind||!candidates.some(c=>c.kind===r.actionKind))continue;const a=groups.get(r.actionKind)??[];a.push(opts.stateChannel===false?.5:s.sim);groups.set(r.actionKind,a);}
 const means=new Map([...groups].map(([k,v])=>[k,v.reduce((a,b)=>a+b,0)/v.length]));const mean=[...means.values()].reduce((a,b)=>a+b,0)/(means.size||1),bonus={};
 for(const [k,mu] of means)bonus[k]=Number(Math.max(0,Math.min(.12,.3*(mu-mean))).toFixed(4));return {bonus,retrieved:[...means].map(([kind,mu])=>({kind,sim:Number(mu.toFixed(2))})).slice(0,3)};
}
const high=Object.fromEntries(DIMS.map(d=>[d,1])),low={...high,arousal:.05};
function decision(a,w,vw,mw){const aff=affordancesFor(w,a.id),paths=visibleActions(aff,a.traits,a.ch,a.bank,vw), mem=new EpisodicMemory();mem.rows=structuredClone(a.memory.rows);mem.failures=new Map(a.memory.failures);mem.kCap=a.memory.kCap;const b=mem.stateBonus(a.bank.m,aff,w.t,{stateChannel:true,precision:mw});const scored=scoreAll(paths,{drives:a.drives,traits:a.traits,bank:a.bank,ch:a.ch,memBonus:b.bonus,risk:a.viabilityRisk()});return {paths:paths.map(x=>x.id),scored,temp:temperatureOf(a.traits,a.ch,a.bank)};}
function diff(a,b,rng){let n=0;for(let i=0;i<32;i++){const u=rng();if(softmaxPick(()=>u,a.scored,a.temp).picked.id!==softmaxPick(()=>u,b.scored,b.temp).picked.id)n++;}return n;}
try{for(const seed of seeds)for(const mode of ['original','provenance','fair']){
 EpisodicMemory.prototype.retrieve=mode==='fair'?fairRet:origRet;EpisodicMemory.prototype.stateBonus=mode==='original'?origBonus:fairBonus;
 const snapshots=new Map();Organism.prototype.tick=async function(w){const r=await origTick.call(this,w);if(w.t<=400&&w.t%20===0){const key=this.id,x=snapshots.get(key)??{n:0,vis:0,mem:0,natural:0,off:0,stage400:null};
  const hh=decision(this,w,high,high),lh=decision(this,w,low,high),hl=decision(this,w,high,low),off=decision(this,w,null,null),natural=decision(this,w,this.forwardModel.predict({m:this.bank.snapshot(),pending:{...this.bank.pending},traits:this.traits}).weights,this.forwardModel.predict({m:this.bank.snapshot(),pending:{...this.bank.pending},traits:this.traits}).weights);
  const mk=()=>makeRng(seed*100000+w.t*10+Number(this.id.slice(1))); x.n++;x.vis+=diff(hh,lh,mk());x.mem+=diff(hh,hl,mk());x.natural+=diff(natural,off,mk());x.off+=diff(off,off,mk());if(w.t===400)x.stage400=this.viab.stage;snapshots.set(key,x);}return r;};
 const {world,agents}=await simulate({seed,ticks,condition:'C2',events:false});
 for(const a of Object.values(agents)){const tr=a.trace.filter(x=>x.t<=400), mi=mutualInfo(tr),nul=miNull(tr);outputs.push({seed,mode,id:a.id,entropy:actionEntropy(tr),mi,null95:nul,coupled:mi>nul,initiated:tr.filter(x=>x.action&&(x.kind==='talk'||x.kind==='take_shared'||x.kind==='look_out')).length,p3coverage400:ruleCoverage(tr,world,20).coverage,stage400:snapshots.get(a.id)?.stage400,stage1200:a.viab.stage,ledger1200:a.viab.ledger.length,viability1200:a.viab.v,p5:snapshots.get(a.id)});}
}} finally {EpisodicMemory.prototype.retrieve=origRet;EpisodicMemory.prototype.stateBonus=origBonus;Organism.prototype.tick=origTick;}
console.log(JSON.stringify({protocol:{seeds,ticks,arms:['original','provenance','fair'],p2window:400,p3window:400,viabilityWindow:1200,p5:'前400 tick 每20 tick 固定事后状态，各臂32个共用随机数；低权重只改变 arousal 到 .05',limits:['公平组使用分数排序及轮询，kCap 总量保持；成败字段不存在因此并未区分结果。','原版存在历史 fallback；provenance 臂只去除 fallback，fair 臂同时使用公平队列，可与 provenance 对比。','轨迹分叉后随机流不保证同步，样本非独立；P2逐标签置换有自相关缺陷；P3沿用现有口径且使用终态位置。','候选为探索性，P5钳制不是自然学习、也不是闭环行为检验。']},outputs},null,2));
