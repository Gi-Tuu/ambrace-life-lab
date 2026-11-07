// 真实记忆反馈只读诊断。复制完整检索状态，避免观测导致失败表被修改。
import { simulate } from './run.mjs';
import { EpisodicMemory } from './memory.mjs';
const seeds=[7,11,21,31,41,51,61,71], ticks=400, summaries=[];
const original=EpisodicMemory.prototype.stateBonus;
const increment=(o,k,n=1)=>o[k]=(o[k]??0)+n;
try{ for(const seed of seeds){
 const captured=new Map();
 EpisodicMemory.prototype.stateBonus=function(m,candidates,t,opts){
  const clone=new EpisodicMemory(); clone.rows=structuredClone(this.rows);clone.kCap=this.kCap;clone.failures=new Map(this.failures);
  const top=clone.retrieve(m,candidates,t,6,opts); const result=original.call(this,m,candidates,t,opts);
  const list=captured.get(this)??[]; list.push({t,top:top.map(({r})=>({t:r.t,kind:r.kind,actionKind:r.actionKind})), bonus:result.bonus,candidates:candidates.map(c=>c.kind)});captured.set(this,list);return result;
 };
 const {agents}=await simulate({seed,ticks,condition:'C2',events:false});
 for(const a of Object.values(agents)){
  const acts=a.trace.filter(r=>r.action), byTick=new Map(acts.map(r=>[r.t,r])), events=captured.get(a.memory)??[];
  const actions={},retrievalAction={},retrievalEvent={},bonusPositive={},nullFallback={}, outcome={ok:0,failed:0,unknown:0},outcomePositive={ok:0,failed:0,unknown:0},positiveValues=[];
  for(const r of acts)increment(actions,r.kind);
  let selected=0,eligible=0,empty=0;
  for(const e of events){
   if(!e.top.length)empty++;
   for(const r of e.top){selected++; increment(retrievalEvent,r.kind);if(r.actionKind){increment(retrievalAction,r.actionKind);const x=byTick.get(r.t);const result=x?.kind===r.actionKind?(x.ok?'ok':'failed'):'unknown';increment(outcome,result); if((e.bonus[r.actionKind]??0)>0)increment(outcomePositive,result);}else if(e.candidates.includes(r.kind))increment(nullFallback,r.kind);if(e.candidates.includes(r.actionKind??r.kind))eligible++;}
   for(const[k,v] of Object.entries(e.bonus)) if(v>0){increment(bonusPositive,k);positiveValues.push(v);}
  }
  summaries.push({seed,id:a.id,actionN:acts.length,decisionCalls:events.length,selected,eligible,empty,actions,retrievalAction,retrievalEvent,bonusPositive,positiveN:positiveValues.length,positiveMin:positiveValues.length?Math.min(...positiveValues):null,positiveMax:positiveValues.length?Math.max(...positiveValues):null,positiveMean:positiveValues.length?positiveValues.reduce((x,y)=>x+y,0)/positiveValues.length:null,nullFallback,outcome,outcomePositive});
 }
} }finally{EpisodicMemory.prototype.stateBonus=original;}
console.log(JSON.stringify({protocol:{seeds,ticks,condition:'C2',silent:true,scope:'每次真实决策检索，复制完整 rows/failures/kCap；同一记忆可被多次计数',outcome:'动作记忆的时间与本人 trace 同 tick 匹配；无法匹配记 unknown',limitations:'无 actionKind 的历史无法区分外部与旧版记录；event kind 的 null fallback 不构成自动映射证明；仅相关性非反馈因果'},summaries},null,2));
