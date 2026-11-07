// P5 固定快照干预：实际轨迹采样后固定 μ、候选、记忆和需求，仅钳制 π。
// 单次采样动作来自共用均匀随机数；这不是闭环效果，也不证明自然习得权重有足够幅度。
import { simulate } from './run.mjs';
import { Organism } from './agent.mjs';
import { EpisodicMemory } from './memory.mjs';
import { affordancesFor } from './body.mjs';
import { visibleActions, scoreAll, temperatureOf, softmaxPick } from './model.mjs';
import { makeRng } from './rng.mjs';
import { DIMS } from './traits.mjs';
import { actionId } from './rules.mjs';

const seeds = [7,11,21,31,41,51,61,71], ticks = 400, stride = 10, draws = 64;
const high = Object.fromEntries(DIMS.map(d => [d, 1]));
const low = { ...high, arousal: 0.05 };
const rows = [];
function decision(a, world, visWeight, memWeight) {
  const affs = affordancesFor(world, a.id), ch = a.ch;
  const paths = visibleActions(affs, a.traits, ch, a.bank, visWeight);
  if (!paths.length) return null;
  // retrieve 会修改失败表；每臂独立复制，不能让第一臂污染第二臂。
  const mem = new EpisodicMemory();
  mem.rows = structuredClone(a.memory.rows);
  mem.failures = new Map(a.memory.failures);
  mem.kCap = a.memory.kCap;
  const bonus = mem.stateBonus(a.bank.m, affs, world.t, {stateChannel: Boolean(ch.mem), precision: memWeight});
  const scored = scoreAll(paths, { drives: a.drives, traits: a.traits, bank: a.bank, ch, memBonus: bonus.bonus, risk: a.viabilityRisk() });
  return { paths: paths.map(actionId), memories: bonus.retrieved, bonus: bonus.bonus, scored, temp: temperatureOf(a.traits, ch, a.bank) };
}
function samplePair(left,right, seed) {
  const rng=makeRng(seed); let changed=0;
  for(let i=0;i<draws;i++) { const u=rng(); const a=softmaxPick(()=>u,left.scored,left.temp).picked.id; const b=softmaxPick(()=>u,right.scored,right.temp).picked.id; if(a!==b) changed++; }
  return changed;
}
const original=Organism.prototype.tick;
try {
  for (const seed of seeds) {
    Organism.prototype.tick=async function(world) {
      const result=await original.call(this, world);
      if(world.t%stride !== 0) return result;
      const hh=decision(this,world,high,high), lh=decision(this,world,low,high), hl=decision(this,world,high,low), ll=decision(this,world,low,low), off1=decision(this,world,null,null), off2=decision(this,world,null,null);
      if([hh,lh,hl,ll,off1,off2].some(x=>!x)) return result;
      const weights=this.forwardModel.predict({m:this.bank.snapshot(), pending:{...this.bank.pending}, traits:this.traits}).weights;
      const natural=decision(this,world,weights,weights);
      const disabled = w => decision(this,world, false ? w : null, false ? w : null);
      const disabledHigh=disabled(high), disabledLow=disabled(low);
      const sampleSeed=seed*100000+world.t*10+Number(this.id.slice(1));
      rows.push({seed,t:world.t,id:this.id,visChanged:JSON.stringify(hh.paths)!==JSON.stringify(lh.paths),memoryChanged:JSON.stringify(hh.memories)!==JSON.stringify(hl.memories),memoryBonusNonzero:Object.values(hh.bonus).some(x=>x!==0),visDrawChanges:samplePair(hh,lh,sampleSeed),memoryDrawChanges:samplePair(hh,hl,sampleSeed),bothDrawChanges:samplePair(hh,ll,sampleSeed),naturalDrawChanges:samplePair(natural,off1,sampleSeed),disabledDrawChanges:samplePair(disabledHigh,disabledLow,sampleSeed),offDrawChanges:samplePair(off1,off2,sampleSeed)});
      return result;
    };
    await simulate({seed,ticks,condition:'C2'});
  }
} finally { Organism.prototype.tick=original; }
const sum=k=>rows.reduce((s,r)=>s+Number(r[k]),0);
const bySeed=seeds.map(seed=>{const rs=rows.filter(r=>r.seed===seed); return {seed,n:rs.length,visSnapshots:rs.filter(r=>r.visChanged).length,memorySnapshots:rs.filter(r=>r.memoryChanged).length,visDrawChanges:rs.reduce((s,r)=>s+r.visDrawChanges,0),memoryDrawChanges:rs.reduce((s,r)=>s+r.memoryDrawChanges,0),bothDrawChanges:rs.reduce((s,r)=>s+r.bothDrawChanges,0)};});
console.log(JSON.stringify({protocol:{seeds,ticks,stride,draws,high,low,scope:'相同真实轨迹的事后固定快照；共用随机数的条件选择分布，非闭环',negative:'两臂均不传权重，逐次比较'},snapshots:rows.length,visSnapshots:sum('visChanged'),memorySnapshots:sum('memoryChanged'),memoryBonusNonzeroSnapshots:sum('memoryBonusNonzero'),visDrawChanges:sum('visDrawChanges'),memoryDrawChanges:sum('memoryDrawChanges'),bothDrawChanges:sum('bothDrawChanges'),naturalDrawChanges:sum('naturalDrawChanges'),disabledDrawChanges:sum('disabledDrawChanges'),offDrawChanges:sum('offDrawChanges'),bySeed},null,2));
if(sum('offDrawChanges')!==0 || sum('disabledDrawChanges')!==0) throw new Error('负向对照失败');
