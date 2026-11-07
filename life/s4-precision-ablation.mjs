// Same mu and same target, changing only the uncertainty-to-probability mapping.
import { Organism } from './agent.mjs';
import { ModulatorBank } from './modulators.mjs';
import { simulate } from './run.mjs';
import { ForwardModel } from './s4-predictor.mjs';
import { DIMS } from './traits.mjs';
const seeds = process.env.S4_EVAL_HOLDOUT === '1' ? [301,303,307,309,313,327,331,337] : [101,103,107,109,113,127,131,137];
const windows=[400,1200], warmup=100, rows=[];
const agentTick=Organism.prototype.tick, bankTick=ModulatorBank.prototype.tick;
function cdf(z){const a=Math.abs(z),t=1/(1+0.2316419*a),tail=Math.exp(-a*a/2)/Math.sqrt(2*Math.PI)*t*(0.319381530+t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));return z>=0?1-tail:tail;}
try {
 for(const seed of seeds){const models=new Map(); let active=null;
  Organism.prototype.tick=async function(world){active={id:this.id,t:world.t};try{return await agentTick.call(this,world)}finally{active=null}};
  ModulatorBank.prototype.tick=function(...args){
   const {id,t}=active; if(!models.has(id))models.set(id,new ForwardModel()); const model=models.get(id);
   const input={m:this.snapshot(),pending:{...this.pending},traits:this.traits}; const pred=model.predict(input), cut=model.predict(input,{precision:false});
   // All channel residuals are from previous observations, and frozen after warmup.
   const state=model.dump(), den=DIMS.reduce((s,d)=>s+Math.max(0,state[d].n-1),0);
   const pooled=den?DIMS.reduce((s,d)=>s+state[d].m2,0)/den:null;
   const result=bankTick.apply(this,args), actual=this.snapshot();
   for(const d of DIMS){
    const y=Number(actual[d]>input.m[d]), pc=pred.probability[d];
    const deterministic=Number(pred.mu[d]>input.m[d]);
    const shared=cut.probability[d];
    if (cut.mu[d] !== pred.mu[d]) throw new Error(`precision changed mu: ${d}`);
    if(t>warmup)rows.push({seed,t,id,d,y,pc,deterministic,shared,mu:pred.mu[d],sharedVariance:pooled,channelPrecision:pred.precision[d]});
   }
   if(t<=warmup)model.observe(input,pred,actual);
   return result;
  };
  await simulate({seed,ticks:1200,condition:'C2',channelMask:{forwardModel:0,forwardLearn:0,precision:0}});
 }
}finally{Organism.prototype.tick=agentTick;ModulatorBank.prototype.tick=bankTick;}
const mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
function bins(rs,key){return Array.from({length:5},(_,i)=>{const x=rs.filter(r=>Math.min(4,Math.floor(r[key]*5))===i);return {interval:`${i/5}-${(i+1)/5}`,n:x.length,p:x.length?mean(x.map(r=>r[key])):null,y:x.length?mean(x.map(r=>r.y)):null}})}
function paired(v){let n=0;const obs=mean(v);for(let m=0;m<256;m++){const x=mean(v.map((a,i)=>m&(1<<i)?a:-a));if(x>=obs-1e-15)n++}return {seedDifference:v,mean:obs,oneSidedP:n/256}}
function summarize(ticks,d){const r=rows.filter(x=>x.t<=ticks&&x.d===d);const b=(x,k)=>(x[k]-x.y)**2;const seedDiff=key=>seeds.map(seed=>mean(r.filter(x=>x.seed===seed).map(x=>b(x,key)-b(x,'pc'))));return {ticks,dimension:d,n:r.length,brier:Object.fromEntries(['deterministic','shared','pc'].map(k=>[k,mean(r.map(x=>b(x,k)))])),gainVsDeterministic:paired(seedDiff('deterministic')),gainVsShared:paired(seedDiff('shared')),reliability:Object.fromEntries(['deterministic','shared','pc'].map(k=>[k,bins(r,k)]))}}
console.log(JSON.stringify({protocol:{seeds,windows,warmup,target:'actual next state > pre-tick state',sameMu:true,deterministic:'P=1 if mu > current, else 0; direction classifier interpreted as probability for Brier only',shared:'same mean and per-channel historical mean residual; all channels pooled residual variance from pre-warmup, frozen',pc:'same mean and per-channel frozen residual variance',evaluation:'C2 true trajectory, S4 channels disabled; frozen predictor after first 100 world ticks',null:'paired seed sign permutation, 256 permutations'},results:windows.flatMap(t=>DIMS.map(d=>summarize(t,d))),limitations:['This assesses residual-variance probability mapping, not effect of behavioral precision switch on reliability; actual precision weights and event probabilities are related via estimated variance but differ in meaning.','Deterministic classification is an intentionally extreme probability comparator, not the only possible model without per-channel precision.','Pooled variance is a stronger comparator but assumes shared residual scale and preserves per-channel mean residual; it is not a model devoid of all uncertainty.','Frozen first 100 ticks per seed; shared and channel estimates may each be noisy; tick rows within seed are correlated.','Eight seeds, overlapping windows and multiple comparisons limit inference.','Same trajectories are reused exploratory data; not a fresh prospective holdout.']},null,2));
