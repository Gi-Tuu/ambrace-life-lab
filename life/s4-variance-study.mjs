// Fixed protocol: means trained first 50 world ticks, residual calibration 51-100, then held-out predictions.
import { Organism } from './agent.mjs';
import { ModulatorBank } from './modulators.mjs';
import { simulate } from './run.mjs';
import { ForwardModel } from './s4-predictor.mjs';
import { DIMS } from './traits.mjs';
const cohorts={explore:[101,103,107,109,113,127,131,137],holdout:[201,203,207,209,213,227,231,237]}, windows=[400,1200], lambda=50, rolling=64, rows=[];
const agentTick=Organism.prototype.tick, bankTick=ModulatorBank.prototype.tick;
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
function variance(a){if(a.length<2)return null;const m=mean(a);return a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1)}
function cdf(z){const a=Math.abs(z),t=1/(1+0.2316419*a),tail=Math.exp(-a*a/2)/Math.sqrt(2*Math.PI)*t*(0.319381530+t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));return z>=0?1-tail:tail;}
try{for(const [cohort,seeds] of Object.entries(cohorts))for(const seed of seeds){
 const models=new Map(), histories=new Map();let active=null;
 Organism.prototype.tick=async function(world){active={id:this.id,t:world.t};try{return await agentTick.call(this,world)}finally{active=null}};
 ModulatorBank.prototype.tick=function(...args){
  const {id,t}=active;if(!models.has(id)){models.set(id,new ForwardModel());histories.set(id,Object.fromEntries(DIMS.map(d=>[d,{early:[],cal:[],rolling:[]}])))}
  const model=models.get(id),h=histories.get(id),input={m:this.snapshot(),pending:{...this.pending},traits:this.traits}, pred=model.predict(input);
  // Pooled variance uses within-channel centered calibration residuals, not between-channel offsets.
  let df=0,sum=0;for(const d of DIMS){const a=h[d].cal,v=variance(a);if(v!==null){df+=a.length-1;sum+=v*(a.length-1)}}
  const shared=df?sum/df:null;
  const result=bankTick.apply(this,args),actual=this.snapshot();
  for(const d of DIMS){
   const a=h[d], y=Number(actual[d]>input.m[d]), bias=a.cal.length?mean(a.cal):0, calVar=variance(a.cal), earlyVar=variance(a.early), rollingVar=variance(a.rolling);
   if(t>100){
    const vs={shared,early:earlyVar,phase:calVar,rolling:rollingVar,shrink:calVar===null||shared===null?null:((a.cal.length-1)*calVar+lambda*shared)/(a.cal.length-1+lambda)};
    const probs=Object.fromEntries(Object.entries(vs).map(([k,v])=>[k,input.m[d]>=1?0:v===null?0.5:cdf((pred.mu[d]+bias-input.m[d])/Math.sqrt(Math.max(v,1e-12)))]));
    rows.push({cohort,seed,t,d,id,y,...probs});
   }
   const err=actual[d]-pred.mu[d];if(t<=50)a.early.push(err);else if(t<=100){a.cal.push(err);a.rolling.push(err)}else {a.rolling.push(err);if(a.rolling.length>rolling)a.rolling.shift()}
  }
  if(t<=50)model.observe(input,pred,actual);
  return result;
 };
 await simulate({seed,ticks:1200,condition:'C2',channelMask:{forwardModel:0,forwardLearn:0,precision:0}});
}}finally{Organism.prototype.tick=agentTick;ModulatorBank.prototype.tick=bankTick;}
const methods=['shared','early','phase','rolling','shrink'];
function bins(rs,key){return Array.from({length:5},(_,i)=>{const x=rs.filter(r=>Math.min(4,Math.floor(r[key]*5))===i);return {n:x.length,p:x.length?mean(x.map(r=>r[key])):null,y:x.length?mean(x.map(r=>r.y)):null}})}
function summarize(cohort,ticks,d){const r=rows.filter(x=>x.cohort===cohort&&x.t<=ticks&&x.d===d), seeds=cohorts[cohort];let output={cohort,ticks,dimension:d,n:r.length};for(const k of methods){const loss=x=>(x[k]-x.y)**2;const b=bins(r,k);output[k]={brier:mean(r.map(loss)),ece: b.reduce((s,x)=>s+(x.n?x.n*Math.abs(x.p-x.y):0),0)/r.length,reliability:b,seedGainVsShared:seeds.map(seed=>mean(r.filter(x=>x.seed===seed).map(x=>(x.shared-x.y)**2-loss(x))))}}return output}
console.log(JSON.stringify({protocol:{cohorts,windows,meanTraining:'world tick <= 50, then frozen',varianceCalibration:'51-100, centered residuals, no future data',methods:{shared:'pooled channel residual variance, frozen',early:'each channel variance in 1-50 prequential errors, frozen',phase:'each channel variance in 51-100 residuals, frozen',rolling:'each channel last 64 residuals, updated after prediction',shrink:'each channel phase variance shrunk toward shared by 50 pseudo observations, frozen'},event:'next state > current',model:'all methods share identical frozen mu and per-channel fixed calibration residual mean',trajectory:'same baseline C2 with S4 channels disabled'},results:Object.keys(cohorts).flatMap(c=>windows.flatMap(t=>DIMS.map(d=>summarize(c,t,d)))),limitations:['Exploratory parameters specified before holdout evaluation, but share implementation and experiment design; not an independently audited prospective deployment test.','Rolling uses evaluation outcomes after each forecast; comparisons assess online adaptation as well as variance estimator.','Frozen mean and phase residual bias may become stale; no claim of closed-loop effect.','Five-bin ECE is descriptive, bin choices and correlated samples affect it; Brier mixes calibration and discrimination.','Eight seeds per cohort, overlapping windows, multiple comparisons and no null correction preclude strong statistical claims.','Historical early residuals are prequential while mean model learns; not exchangeable with phase residuals.']},null,2));
