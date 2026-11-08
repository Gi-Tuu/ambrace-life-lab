import {LOCS} from './body.mjs';
// M3 研究候选：确定性的两步机会搜索。纯快照，不访问真实 world 或 RNG。
// 近似只模拟位置、公开粮仓、能源及当前已知同屋对话；假设第二步其他人不移动，不预测事件、调制或存续。
// actions 是本刻由调用方确定可用的动作；catalog 是公开、可预测的候选模板，不含私有库存。
const KNOWN_LOCS = new Set(Object.keys(LOCS));
// PLAN §28：世界预设可以给出自己的房间表；没有 locs 的旧快照仍回退到 lab 的 KNOWN_LOCS。
const locSet = (s) => (Array.isArray(s?.locs) && s.locs.length ? new Set(s.locs) : KNOWN_LOCS);
const clamp=x=>Math.max(0,Math.min(1,x));
const finite=(x,fallback)=>Number.isFinite(x)?x:fallback;
function cloneSnapshot(s){return {selfId:s.selfId,loc:s.loc,energy:s.energy,social:s.social,pantry:s.pantry,energySetpoint:s.energySetpoint,socialSetpoint:s.socialSetpoint,companions:{...(s.companions??{})},
 // 收益模型补的两项公开事实也必须跟着快照走，否则首步之后 takeable/夜禁信息就丢了（实测预测能量不变）
 lookOutLegal:s.lookOutLegal,takeable:{...(s.takeable??{})}};}
function validateSnapshot(s){if(!s||typeof s.selfId!=='string'||!s.selfId||!locSet(s).has(s.loc)||![s.energy,s.social,s.pantry,s.energySetpoint,s.socialSetpoint].every(Number.isFinite)||s.energy<0||s.energy>1||s.social<0||s.social>1||s.pantry<0||s.energySetpoint<0||s.energySetpoint>1||s.socialSetpoint<0||s.socialSetpoint>1||(s.companions!=null&&(typeof s.companions!=='object'||Array.isArray(s.companions)||Object.values(s.companions).some(x=>!Number.isFinite(x)||x<0||x>1))))throw new TypeError('预测需要合法的公开快照');}
function allowed(s,a){
 if(!a||typeof a.id!=='string'||!a.id||typeof a.kind!=='string')return false;
 if(a.kind==='rest')return true;
 if(a.kind==='move_to')return locSet(s).has(a.to)&&a.to!==s.loc;
 if(a.kind==='eat')return (s.loc==='home'||s.loc==='store')&&s.pantry>0;
 if(a.kind==='talk')return typeof a.target==='string'&&a.target!==s.selfId&&Object.hasOwn(s.companions??{},a.target);
 // look_out：真实效果是移动到瞭台并补社交（actuate: satiated social 0.12）。夜禁是规则层知识，
 // 由调用方以公开事实 `lookOutLegal` 给出；缺省按允许处理，保持旧快照兼容。
 if(a.kind==='look_out')return s.lookOutLegal!==false;
 // take_shared：只在"当前位置吃不到合法食物"时进入候选——这是存续逃生门，不是默认取食路径。
 // 目标集合由调用方按**当前可观察事实**给出（away 且 stash>0），不是对未来的预测。
 if(a.kind==='take_shared')return Object.keys(s.takeable??{}).length>0&&!((s.loc==='home'||s.loc==='store')&&s.pantry>0);
 // 同屋者只使用本刻已观察的对象与自身熟悉度；无此输入及私人物资均不推测。
 return false;
}
function advance(input,a){
 const s=cloneSnapshot(input);
 if(a.kind==='rest')s.energy=clamp(s.energy+.05);
 else if(a.kind==='eat'){s.pantry-=1;s.energy=clamp(s.energy+.5);}
 else if(a.kind==='move_to'){s.loc=a.to;s.companions={};}
 else if(a.kind==='talk'){const assessed=Math.min(1,s.companions[a.target]+.06),met=Math.min(1,assessed+.07);s.companions[a.target]=met;s.social=clamp(s.social+.26+.24*met);}
 // look_out 与真实 actuate 对齐：移动到瞭台、社交 +0.12（clamp），同屋对象按未知清空。
 else if(a.kind==='look_out'){s.loc='watch';s.companions={};s.social=clamp(s.social+.12);}
 // take_shared：能量按调用方给出的公开预期份量回补（真实 actuate 的 satiated energy amount）。
 // 私人库存的减少、秘密与信任罚**不在这里建模**——那属于真实引擎的评价/关系层，规划器不假装知道。
 else if(a.kind==='take_shared'){const portion=finite(s.takeable?.[a.target],0);s.energy=clamp(s.energy+portion);}
 // 未知结果不可按有收益计算，调用方已验证的其它首步只当作零直接收益。
 return s;
}
function deficit(s){return Math.max(0,s.energySetpoint-s.energy)+Math.max(0,s.socialSetpoint-s.social);}
function cost(a){const x=finite(a.cost,0);return Math.max(0,x);}
function chooseGoal(first,second){
 const kinds=[first?.kind,second?.kind];
 // take_shared 也是取食路径（存续逃生门），归 recover；否则"越轨"会被错记成 maintain
 if(kinds.includes('eat')||kinds.includes('take_shared'))return 'recover';
 if(kinds.includes('talk'))return 'connect';
 if(kinds.includes('look_out'))return 'explore';
 return 'maintain';
}
function identity(a){return {id:a.id,kind:a.kind,to:typeof a.to==='string'?a.to:undefined,target:typeof a.target==='string'?a.target:undefined};}
export class ShortHorizonPlanner{
 constructor({commitment=4,discount=.8,effortWeight=.1}={}){
  if(!Number.isSafeInteger(commitment)||commitment<1||!Number.isFinite(discount)||discount<0||discount>1||!Number.isFinite(effortWeight)||effortWeight<0)throw new RangeError('无效的规划参数');
  this.commitment=commitment;this.discount=discount;this.effortWeight=effortWeight;this.state=null;this.remaining=0;
 }
 step({snapshot,actions,catalog,reflex=false}){
  if(reflex)return {goal:this.state?.goal??null,action:null,remaining:this.remaining,interrupted:null,reused:false,reflex:true,plans:[]};
  validateSnapshot(snapshot);if(!Array.isArray(actions)||!Array.isArray(catalog))throw new TypeError('动作和公开候选模板必须为数组');
  const kinds=['rest','eat','move_to','talk','look_out','take_shared'];
  if([...actions,...catalog].some(a=>!a||typeof a.id!=='string'||!a.id||!kinds.includes(a.kind)||!Number.isFinite(a.cost)||a.cost<0))throw new TypeError('动作类型或成本未知');
  if(new Set(actions.map(a=>a.id)).size!==actions.length)throw new TypeError('当前动作 id 必须唯一');
  const eligible=actions.filter(a=>allowed(snapshot,a));
  let interrupted=null;
  if(!eligible.length){
   if(this.state&&this.remaining>0)interrupted='committed_goal_unavailable';
   this.state=null;this.remaining=0;
   return {goal:null,action:null,remaining:0,interrupted:interrupted??'no_eligible_action',reused:false,plans:[]};
  }
  const plans=[];
  for(const first of eligible){
   const s1=advance(snapshot,first),gain1=deficit(snapshot)-deficit(s1),c1=cost(first);
   // 已实现收益模型的首步才外推；look_out/take_shared 现在都在模型内（与 actuate 对齐）。
   const modeledFirst=['rest','eat','move_to','talk','look_out','take_shared'].includes(first.kind);
   // 对话会改变信任与熟悉度，下一次对话成本需重新生成；未知未来成本不沿用旧模板。
   // take_shared 不做第二步：私人库存在第一步之后是否还在，属于不预测的范围（预登记口径）。
   const secondOptions=modeledFirst?[null,...catalog.filter(a=>a.kind!=='take_shared'&&allowed(s1,a)&&!(first.kind==='talk'&&a.kind==='talk'))]:[null];
   for(const second of secondOptions){const s2=second?advance(s1,second):s1,gain2=deficit(s1)-deficit(s2),c2=second?cost(second):0;
    const score=gain1-this.effortWeight*c1+this.discount*(gain2-this.effortWeight*c2);
    plans.push({goal:chooseGoal(first,second),first:identity(first),second:second?identity(second):null,gain1,gain2,cost1:c1,cost2:c2,score,predicted:{afterFirst:modeledFirst?s1:null,afterSecond:modeledFirst?s2:null},predictionComplete:modeledFirst});
   }
  }
  plans.sort((a,b)=>b.score-a.score||a.first.id.localeCompare(b.first.id)||(a.second?.id??'').localeCompare(b.second?.id??''));
  let matching=null, reused=false;
  if(this.state&&this.remaining>0){
   // 承诺锁定功能目标；目标内每刻用当前合法动作重新竞争，不重复旧动作对象。
   matching=plans.find(p=>p.goal===this.state.goal);
   if(matching){this.remaining--;reused=true;}
   else{interrupted='committed_goal_unavailable';this.state=null;this.remaining=0;}
  }
  const best=matching??plans[0];
  if(!reused){this.state={goal:best.goal};this.remaining=this.commitment-1;}
  const actual=eligible.find(a=>a.id===best.first.id);
  return {goal:this.state.goal,action:structuredClone(actual),remaining:this.remaining,interrupted,reused,plans};
 }
 dump(){return {state:this.state?{goal:this.state.goal}:null,remaining:this.remaining};}
 load(d){
  if(!d||d.state==null){this.state=null;this.remaining=0;return;}
  if(!['recover','connect','explore','maintain'].includes(d.state.goal)||!Number.isSafeInteger(d.remaining)||d.remaining<0||d.remaining>=this.commitment)throw new TypeError('无效的规划存档');
  this.state={goal:d.state.goal};this.remaining=d.remaining;
 }
}
