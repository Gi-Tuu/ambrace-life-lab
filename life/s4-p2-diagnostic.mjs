// 2x2 同种子、同初始化人格；切换在 tick 内，避免 simulate 的 mask seed 污染。
// 自此后因行为分支与 RNG 消耗，轨迹不再逐刻配对。
import { simulate } from './run.mjs';
import { Organism } from './agent.mjs';
import { EpisodicMemory } from './memory.mjs';
import { mutualInfo, miNull, actionEntropy } from './metrics.mjs';
const seeds=[7,11,21,31,41], output=[];
const origAdd=EpisodicMemory.prototype.add, origTick=Organism.prototype.tick;
try {
 for (const seed of seeds) for(const mapped of [false,true]) for(const precision of [false,true]) {
  EpisodicMemory.prototype.add=function(t, row) { return origAdd.call(this,t, mapped?row:{...row,actionKind:null}); };
  Organism.prototype.tick=async function(w){this.ch.precision=Number(precision); return origTick.call(this,w);};
  const {agents}=await simulate({seed,ticks:400,condition:'C2',events:false});
  const people=Object.values(agents).map(a=>{const mi=mutualInfo(a.trace), nul=miNull(a.trace);return {id:a.id, archetype:a.traits.archetype, entropy:actionEntropy(a.trace),mi,null95:nul,coupled:mi>nul,actions:a.counters.actions,initiated:a.counters.initiated,habit:a.counters.habit};});
  output.push({seed,mapped,precision,coupled:people.filter(x=>x.coupled).length,people});
 }
} finally {EpisodicMemory.prototype.add=origAdd; Organism.prototype.tick=origTick;}
console.log(JSON.stringify({protocol:{seeds,ticks:400,condition:'C2',factorial:['actionKind mapping','precision'],matching:'相同 seed、人格和初始随机流；行为分支之后轨迹和随机流可能不同',limits:'每格三角色，少量种子，仅诊断；原无条件置换会破坏时间相关'},output},null,2));
