// P2 时间相关诊断：不改既有指标；零分布分别为逐标签随机置换与个体内循环位移。
import { simulate } from './run.mjs';
import { Organism } from './agent.mjs';
import { channelsFor } from './model.mjs';
import { makeRng } from './rng.mjs';
const seeds=[7,11,21,31,41,51,61,71], ticks=400, margin=40, permutations=200, runs=100;
function bin(xs) { const s=[...xs].sort((a,b)=>a-b), a=s[Math.floor(s.length/3)],b=s[Math.floor(s.length*2/3)]; return xs.map(x=>x<=a?0:x<=b?1:2); }
function mi(x,y) { const X=new Map(),Y=new Map(),J=new Map(), n=x.length; for(let i=0;i<n;i++){X.set(x[i],(X.get(x[i])??0)+1);Y.set(y[i],(Y.get(y[i])??0)+1);let k=`${x[i]}|${y[i]}`;J.set(k,(J.get(k)??0)+1);} let z=0;for(const[k,c] of J){const [a,b]=k.split('|');z+=c/n*Math.log((c*n)/(X.get(Number(a))*Y.get(b)));}return z; }
function evaluate(raw, labels, seed) {
 const x=bin(raw), y=labels.map(String), obs=mi(x,y),rng=makeRng(seed), shifted=[], perm=[];
 for(let k=margin;k<=x.length-margin;k++) shifted.push(mi(x,y.map((_,i)=>y[(i+k)%y.length])));
 for(let k=0;k<permutations;k++){const p=[...y];for(let i=p.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[p[i],p[j]]=[p[j],p[i]];}perm.push(mi(x,p));}
 const pval=arr=>(1+arr.filter(z=>z>=obs-1e-15).length)/(arr.length+1);
 return {mi:obs,shiftP:pval(shifted),permP:pval(perm),shiftN:shifted.length};
}
const original=Organism.prototype.tick, real=[];
try { for(const seed of seeds) for(const condition of ['C0','C2']) {
 Organism.prototype.tick=async function(w){this.condition=condition;this.ch=channelsFor(condition,null);return original.call(this,w);};
 const {agents}=await simulate({seed,ticks,condition:'C2',events:false});
 for(const a of Object.values(agents)){const rec=a.trace.filter(r=>r.action); const result=evaluate(rec.map(r=>r.m.arousal),rec.map(r=>r.kind),seed*10+Number(a.id.slice(1)));real.push({seed,condition,id:a.id,n:rec.length,...result});}
} } finally { Organism.prototype.tick=original; }
// AR(1) 的独立对照和同步耦合正对照；使用相同基础过程但独立噪声。
const synthetic=[];
for(let s=0;s<runs;s++) {const rng=makeRng(100000+s);let x=0,z=0;const xs=[],neg=[],pos=[],commonX=[],commonY=[];
 for(let i=0;i<ticks+100;i++){x=.95*x+(rng()-.5);z=.95*z+(rng()-.5);if(i>=100){xs.push(x);neg.push(z>0?'hi':'lo');pos.push(x+(rng()-.5)>.0?'hi':'lo');const trend=3*Math.sin((i-100)*Math.PI/200); commonX.push(x+trend); commonY.push(z+trend>0?'hi':'lo');}}
 for(const [condition,xx,y] of [['independent',xs,neg],['coupled',xs,pos],['shared_trend',commonX,commonY]]) synthetic.push({seed:s,condition,...evaluate(xx,y,200000+s)});
}
function summary(rows){return {n:rows.length,shiftReject:rows.filter(r=>r.shiftP<=.05).length,permReject:rows.filter(r=>r.permP<=.05).length};}
console.log(JSON.stringify({protocol:{seeds,ticks,margin,permutations,syntheticRuns:runs,real:'C2 同 seed 初始化后切 condition，分支后随机流不保证同步',null:'个体内位移至少40样本；逐标签随机置换作为对照',limits:['循环移位假定过程近似平稳且间隔足够；环境非平稳或有共同趋势可制造假阳性。','单条轨迹的 p 值和多个角色与种子不独立；本报告未做多重比较校正。','模拟耦合正例为同步关系，不验证对弱耦合或其他时滞的功效。','shared_trend 是由共同驱动引起的关联，拒绝独立性并非统计假阳性，但不能推断直接因果。']},realSummary:Object.fromEntries(['C0','C2'].map(c=>[c,summary(real.filter(r=>r.condition===c))])),syntheticSummary:Object.fromEntries(['independent','coupled','shared_trend'].map(c=>[c,summary(synthetic.filter(r=>r.condition===c))])),real,synthetic},null,2));
