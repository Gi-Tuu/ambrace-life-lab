// 探索性 P2 权重对照；参数在本脚本运行前固定，不改原有验收阈值。
// relative: 原相对精度；sqrt: 相对标准差倒数；shrink20/80: 用 20/80 个伪观测向中性权重 1 收缩；off: 不启用精度。
import { simulate } from './run.mjs';
import { Organism } from './agent.mjs';
import { ForwardModel } from './s4-predictor.mjs';
import { mutualInfo, miNull, actionEntropy } from './metrics.mjs';
import { DIMS } from './traits.mjs';
const seeds=[7,11,21,31,41,51,61,71], modes=['off','relative','sqrt','shrink20','shrink80'], out=[];
const op=ForwardModel.prototype.predict, ot=Organism.prototype.tick;
try{for(const seed of seeds) for(const mode of modes){
 ForwardModel.prototype.predict=function(input){const r=op.call(this,input);for(const d of DIMS){const w=r.weights[d], n=this.rows[d].n;if(mode==='sqrt')r.weights[d]=Math.sqrt(w);if(mode.startsWith('shrink')){const k=Number(mode.slice(6));r.weights[d]=1-(n/(n+k))*(1-w);}}return r;};
 Organism.prototype.tick=async function(w){if(mode==='off')this.ch.precision=0;return ot.call(this,w);};
 const {agents}=await simulate({seed,ticks:400,condition:'C2',events:false});
 const people=Object.values(agents).map(a=>{const mi=mutualInfo(a.trace), n=miNull(a.trace);return {id:a.id,mi,null95:n,coupled:mi>n,entropy:actionEntropy(a.trace),initiated:a.counters.initiated};});
 out.push({seed,mode,coupled:people.filter(a=>a.coupled).length,people});
}} finally {ForwardModel.prototype.predict=op;Organism.prototype.tick=ot;}
console.log(JSON.stringify({protocol:{seeds,modes,ticks:400,note:'相同初始化；分叉后随机流和世界状态不保证同步。探索性，不构成 P5 验收；当前 MI 的逐标签置换已知不保自相关。'},out},null,2));
