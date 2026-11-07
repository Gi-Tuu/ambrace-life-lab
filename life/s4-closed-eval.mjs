// S4 真实闭环评估：每组使用相同 seed/personality，避免 simulate 把 mask 混入随机种子。
import { makeWorld, spawn, scanSecrets } from './body.mjs';
import { Organism } from './agent.mjs';
import { ModulatorBank } from './modulators.mjs';
import { hashSeed } from './rng.mjs';
import { DIMS } from './traits.mjs';
import { simulate } from './run.mjs';

const seeds=[101,103,107,109,113,127,131,137], windows=[400,1200], warmup=100;
const roster=[{id:'a1',name:'岑',archetype:'谨慎',loc:'home'},{id:'a2',name:'绛',archetype:'冲动',loc:'hall'},{id:'a3',name:'蓑',archetype:'孤僻',loc:'watch'}];
const masks={ baseline:{forwardModel:0,forwardLearn:0,precision:0}, cut:{forwardModel:1,forwardLearn:1,precision:0}, full:{forwardModel:1,forwardLearn:1,precision:1} };
const bankTick=ModulatorBank.prototype.tick;
const mean=x=>x.reduce((a,b)=>a+b,0)/x.length;
async function run(seed, arm) {
  const world=makeWorld({pantries:6,stash:3}), agents={}, histories={}, observations=[];
  for (const r of roster) {
    const a=new Organism({...r,seed:hashSeed(seed,`${r.id}:C2:${JSON.stringify(masks.baseline)}`),condition:'C2',channelMask:masks[arm]});
    agents[r.id]=a; world.agents[r.id]=a; spawn(world,r.id,r.loc);
    histories[r.id]=Object.fromEntries(DIMS.map(d=>[d,[]]));
  }
  let active=null;
  try {
    ModulatorBank.prototype.tick=function(...args) {
      const {a,t}=active, before=this.snapshot(), h=histories[a.id];
      const input={m:before,pending:{...this.pending},traits:this.traits};
      const p=a.forwardModel.predict(input);
      const result=bankTick.apply(this,args), after=this.snapshot();
      for (const d of DIMS) {
        const y=Number(after[d]>before[d]);
        const baseline=(1+h[d].reduce((x,z)=>x+z,0))/(2+h[d].length);
        if(t>warmup) observations.push({t,id:a.id,d,y,p:arm==='baseline'?baseline:p.probability[d], weight:arm==='full'?p.weights[d]:1});
        h[d].push(y); if(h[d].length>100) h[d].shift();
      }
      return result;
    };
    for(let t=1;t<=1200;t++) {
      world.t=t; world.percepts=[];
      if(t%97===0) world.percepts.push({for:'all',kind:'alarm',subject:'墙外',salience:0.9});
      if(t%55===0) world.pantry=Math.min(8,world.pantry+2);
      scanSecrets(world);
      for(const a of Object.values(agents)) {active={a,t}; await a.tick(world);}
    }
  } finally { ModulatorBank.prototype.tick=bankTick; }
  return {traits:Object.fromEntries(Object.values(agents).map(a=>[a.id,a.traits])), observations, traces:Object.fromEntries(Object.values(agents).map(a=>[a.id,a.trace.filter(r=>r.action).map(r=>({t:r.t,action:r.action}))]))};
}
function summary(run,ticks) {
  const rows=run.observations.filter(r=>r.t<=ticks), acts=Object.values(run.traces).flat().filter(r=>r.t<=ticks), counts={};
  for(const x of acts) counts[x.action]=(counts[x.action]??0)+1;
  return {n:acts.length,actions:Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,v/acts.length])), channels:Object.fromEntries(DIMS.map(d=>{const rs=rows.filter(r=>r.d===d);return [d,{n:rs.length,brier:mean(rs.map(r=>(r.p-r.y)**2)),meanWeight:mean(rs.map(r=>r.weight))}]}))};
}
function distance(a,b) {const k=new Set([...Object.keys(a),...Object.keys(b)]);return [...k].reduce((s,x)=>s+Math.abs((a[x]??0)-(b[x]??0)),0)/2;}
function disagreement(a,b,ticks) {
  let total=0,changed=0;
  for(const id of Object.keys(a.traces)) {
    const aa=new Map(a.traces[id].filter(x=>x.t<=ticks).map(x=>[x.t,x.action])),bb=new Map(b.traces[id].filter(x=>x.t<=ticks).map(x=>[x.t,x.action]));
    for(const t of new Set([...aa.keys(),...bb.keys()])) {total++; if(aa.get(t)!==bb.get(t)) changed++;}
  }
  return {changed,total,rate:changed/total};
}
const results=[];
for(const seed of seeds) {
  const b=await run(seed,'baseline'),cut=await run(seed,'cut'),repeat=await run(seed,'cut'),full=await run(seed,'full');
  const sim=await simulate({seed,ticks:1200,condition:'C2',channelMask:masks.baseline});
  const simTraces=Object.fromEntries(Object.values(sim.agents).map(a=>[a.id,a.trace.filter(r=>r.action).map(r=>({t:r.t,action:r.action}))]));
  const matchesSimulate=JSON.stringify(b.traces)===JSON.stringify(simTraces);
  if(!matchesSimulate) throw Error(`simulate mismatch seed ${seed}`);
  const sameTraits=JSON.stringify(b.traits)===JSON.stringify(cut.traits)&&JSON.stringify(b.traits)===JSON.stringify(full.traits);
  const deterministicCut=JSON.stringify(cut.traces)===JSON.stringify(repeat.traces)&&JSON.stringify(cut.observations)===JSON.stringify(repeat.observations);
  const negativeControl=JSON.stringify(b.traces)===JSON.stringify(cut.traces);
  if(!sameTraits||!deterministicCut||!negativeControl) throw Error(`controls failed seed ${seed}: traits ${sameTraits}, repeat ${deterministicCut}, cut ${negativeControl}`);
  for(const t of windows) {
    const bs=summary(b,t), cs=summary(cut,t),fs=summary(full,t);
    results.push({seed,ticks:t,matchesSimulate,sameTraits,deterministicCut,negativeControl,baseline:bs,cut:cs,full:fs,totalVariationFullVsCut:distance(fs.actions,cs.actions),actionDisagreement:disagreement(full,cut,t)});
  }
}
console.log(JSON.stringify({protocol:{seeds,windows,warmup,arms:masks,seedRule:'hashSeed(seed, id:C2:baseline mask) identical across arms, baseline compared with simulate',event:'next state > pre-tick state',probability:'baseline rolling Beta(1,1) prior event rate; model normal residual estimate',control:'baseline/cut exact action trajectories, cut/repeat exact actions and predictions',schedule:'same as simulate, no gossip, pantry 6, stash 3',weights:'natural per-channel learned inverse-error weights'},results,limitations:['Three feedback loops produce different trajectories; comparing Brier across them does not hold events or populations fixed.','Once behavior diverges, shared RNG state can be consumed differently; same starting seed does not fix future noise or events.','Disagreement and total variation measure natural weights, not a fixed-mu P5 intervention or a random null distribution.','8 seeds and overlapping time windows limit inference; Brier includes both calibration and discrimination, per-tick data are correlated.','Baseline event-rate probability lacks pending and traits, so model Brier advantage alone does not establish information-matched incremental value.']},null,2));
