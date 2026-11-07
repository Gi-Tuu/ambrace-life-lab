import { simulate } from './run.mjs';
import { Organism } from './agent.mjs';
import { affordancesFor } from './body.mjs';
import { visibleActions,scoreAll,temperatureOf } from './model.mjs';
const seeds=[7,11,21,31,41,51,61,71],rows=[],seen=new Set(),orig=Organism.prototype.tick;
Organism.prototype.tick=async function(world){
 const key=world._o18Seed+':'+this.id;
 if(world.t>=100&&!seen.has(key)&&affordancesFor(world,this.id).some(a=>a.kind==='take_shared')){seen.add(key);const old=world.riskyPortion,arms=[];
  for(const enabled of [0,1])for(const portion of [.45,1.1]){world.riskyPortion=portion;const affs=affordancesFor(world,this.id);const prediction=this.forwardModel.predict({m:this.bank.snapshot(),pending:{...this.bank.pending},traits:this.traits},{precision:Boolean(this.ch.precision)});const paths=visibleActions(affs,this.traits,this.ch,this.bank,this.ch.precision?prediction.weights:null);const scored=scoreAll(paths,{drives:this.drives,traits:this.traits,bank:this.bank,ch:{...this.ch,expectedYield:enabled},memBonus:{},risk:this.viabilityRisk()});const temp=temperatureOf(this.traits,this.ch,this.bank),max=Math.max(...scored.map(x=>x.u)),z=scored.reduce((s,x)=>s+Math.exp((x.u-max)/temp),0);arms.push({enabled,portion,actions:scored.map(x=>({id:x.id,u:x.u,p:Math.exp((x.u-max)/temp)/z}))});}
  world.riskyPortion=old;if(JSON.stringify(arms[0].actions)!==JSON.stringify(arms[1].actions))throw Error('切断后固定状态评分或概率改变');rows.push({id:this.id,seed:world._o18Seed,t:world.t,energy:this.drives.v.energy,arms});}
 return orig.call(this,world);
};
try{for(const seed of seeds){const wrapper=Organism.prototype.tick;Organism.prototype.tick=async function(w){w._o18Seed=seed;return wrapper.call(this,w)};await simulate({seed,ticks:400,condition:'C2'});Organism.prototype.tick=wrapper;}}finally{Organism.prototype.tick=orig}
console.log(JSON.stringify({protocol:{seeds,tick:'每人 100 刻后第一次存在越轨候选',portion:[.45,1.1],scope:'同状态只改份量，开关两臂，记忆加成固定为零',negative:'关闭 expectedYield 后评分和概率逐位一致',limitations:['未执行动作；实际到账单独测试','固定状态不能推断长期行为变化','可见世界规则并非经验学习']},rows},null,2));
