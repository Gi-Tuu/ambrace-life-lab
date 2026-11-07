// O18: 每 tick 最开始采公开状态，行动选择及世界更新之前；训练与未来测试按时间隔离。
import { simulate } from './run.mjs';
import { Organism } from './agent.mjs';
import { makeRng } from './rng.mjs';
import { fitDecisionRules, predictDecision } from './o18-metrics.mjs';
const seeds=[7,11,21,31,41,51,61,71], specs=[{ticks:400,event:200,split:300},{ticks:1200,event:600,split:900}];
const original=Organism.prototype.tick, bin=x=>x<.35?'low':x<.6?'mid':'high';
Organism.prototype.tick=async function(w){
  const start=this.trace.length, before={energy:bin(this.drives.v.energy),social:bin(this.drives.v.social),loc:w.loc[this.id]};
  const result=await original.call(this,w);
  for(const row of this.trace.slice(start)) if(row.action) {
    if (!row.tickStart || row.tickStart.t !== w.t || bin(row.tickStart.drives.energy)!==before.energy || bin(row.tickStart.drives.social)!==before.social || row.tickStart.loc!==before.loc) throw Error('生产 tick 入口快照与独立采样不一致');
    row.o18Before=before;
  }
  return result;
};
function majority(xs){const c=new Map();for(const x of xs)c.set(x,(c.get(x)??0)+1);return [...c].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0]??null}
function fit(train){return fitDecisionRules(train)}
function predict(model,x){return predictDecision(model,x)}
function accuracy(model,rows){return rows.length?rows.filter(r=>predict(model,r.x)===r.y).length/rows.length:null}
function shuffleRows(rows,seed){const ys=rows.map(r=>r.y),rng=makeRng(seed);for(let i=ys.length-1;i>0;i--){let j=Math.floor(rng()*(i+1));[ys[i],ys[j]]=[ys[j],ys[i]]}return rows.map((r,i)=>({...r,y:ys[i]}))}
// 正控训练/测试可完全泛化；错配标签负控至少破坏此一一对应。
const synthetic=Array.from({length:120},(_,i)=>({t:i+1,x:{energy:'mid',social:'mid',loc:i%2?'hall':'home'},y:i%2?'a':'b'}));
const pos=accuracy(fit(synthetic.slice(0,60)),synthetic.slice(60));
const swapped=synthetic.slice(60).map(r=>({...r,y:r.y==='a'?'b':'a'}));
const neg=accuracy(fit(synthetic.slice(0,60)),swapped);
if(pos!==1||neg!==0)throw new Error('正负合成控制未通过');
const results=[];
try{for(const spec of specs)for(const seed of seeds)for(const portion of [.45,1.1])for(const arm of ['base','told','cut','cut_told']){
 const mask=arm.startsWith('cut')?{gossip:0}:null;const told=arm==='told'||arm==='cut_told';
 const r=await simulate({seed,ticks:spec.ticks,condition:'C2',riskyPortion:portion,channelMask:mask,gossipAt:told?[spec.event]:[]});
 const per=Object.values(r.agents).map(a=>{const tr=a.trace.filter(x=>x.action&&x.t>spec.event).map(x=>({t:x.t,x:x.o18Before,y:x.action}));if(tr.some(x=>!x.x))throw Error('缺失事前特征');
  const train=tr.filter(x=>x.t<=spec.split),test=tr.filter(x=>x.t>spec.split),model=fit(train),shuffled=fit(shuffleRows(train,seed*100+Number(a.id.slice(1))));
  return {id:a.id,nTrain:train.length,nTest:test.length,train:accuracy(model,train),test:accuracy(model,test),shuffleTrainTest:accuracy(shuffled,test),majorityTest:accuracy({rules:[],fallback:model.fallback},test),rules:model.rules,actions:tr.map(x=>x.y),features:tr.map(x=>x.x)};});
 results.push({seed,...spec,portion,arm,gossip:r.world.gossipLog?.filter(x=>x.ok).length??0,per});
}}finally{Organism.prototype.tick=original}
for(const spec of specs)for(const seed of seeds)for(const portion of [.45,1.1]){const get=arm=>results.find(x=>x.ticks===spec.ticks&&x.seed===seed&&x.portion===portion&&x.arm===arm);const a=get('cut'),b=get('cut_told');if(JSON.stringify(a.per)!==JSON.stringify(b.per))throw Error(`切断负控不一致 ${spec.ticks}/${seed}/${portion}`)}
console.log(JSON.stringify({protocol:{seeds,specs,portions:[.45,1.1],features:'tick 开始时的公开能量、社交及位置',split:'告知之后前半训练、后半测试',control:'gossip=0 的告知/未告知逐动作与特征相同；训练标签洗牌、常数多数类；合成正负控制；训练规则相对多数类的样本内增益排序，零增益退回多数类',limitations:['tick 开始早于本轮外部输入与反射判断，不是完整选择时可见信息','每个体单独拟合规则，测试是后半时间窗口并非新种子','洗牌训练仅为诊断，类别分布及时间相关不变的零分布需另行研究','动作执行前实际已选，捕获在 tick 入口防选择后泄漏','训练/测试均在干预后，非训练前后因果效应；不同臂可因行为分叉改变随机流','两个窗口告知时点不同，不能单独归因于窗口长短']},synthetic:{positive:pos,negative:neg},results},null,2));
