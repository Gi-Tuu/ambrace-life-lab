// 无外部打击，测既有四维系统中 quiescence 的上穿周期；开发样本，不是验收。
import {ModulatorBank} from './modulators.mjs';
import {sampleTraits} from './traits.mjs';
import {makeRng} from './rng.mjs';
const rows=[];
for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of [7,11,13]){
 const traits=sampleTraits(makeRng(seed),archetype);
 const bank=new ModulatorBank(traits,makeRng(seed+10000));
 const crossings=[];let previous=null,boundary=0;
 for(let t=1;t<=600;t++){
  bank.tick();const q=bank.m.quiescence;
  if(t>=80){if(previous!==null&&previous<=traits.baseline.quiescence&&q>traits.baseline.quiescence)crossings.push(t);previous=q;}
  if(q===0||q===1)boundary++;
 }
 rows.push({archetype,seed,crossings,periods:crossings.slice(1).map((t,i)=>t-crossings[i]),boundary});
}
const periods=rows.flatMap(r=>r.periods).sort((a,b)=>a-b);
const n=periods.length,median=n?(n%2?periods[(n-1)/2]:(periods[n/2-1]+periods[n/2])/2):null;
console.log(JSON.stringify({protocol:'无打击；80–600 更新内 quiescence 基线向上跨越的相邻间隔',median,periods,rows},null,2));
