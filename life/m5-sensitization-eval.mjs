// M5 一次修复候选：仅隔离探针；历史负荷敏化后续正向注入，不改生产引擎。
import assert from 'node:assert/strict';
import { ProbeBank, probe } from './m5-bank-probe.mjs';
import { hill } from './modulators.mjs';
import { M5_DEFAULTS } from './m5-slow.mjs';
import { DIMS, sampleTraits } from './traits.mjs';
import { makeRng, gauss } from './rng.mjs';

class CandidateBank extends ProbeBank {
 constructor(traits,rng,options,sensitize) {super(traits,rng,options);this.sensitize=sensitize;this.extraTotal=0;this.hitLimit=0;}
 tick(dt=1) {
  const t=this.traits;
  for(const d of DIMS){
   let cross=0;
   for(let j=0;j<DIMS.length;j++)cross+=(t.w[DIMS.indexOf(d)]?.[j]??0)*hill(this.x(DIMS[j]));
   let decay=-this.x(d)/t.tau[d];
   const inj=Math.max(-t.U_max,Math.min(t.U_max,this.pending[d]));
   let feedback=0,extra=0;
   if(d==='arousal'&&this.slow.enabled){
    const state=this.slow.tick({fast:0,stress:inj});
    feedback=state.fast-inj;decay/=1+M5_DEFAULTS.loadGain*state.load;
    if(this.sensitize)extra=Math.max(0,inj)*M5_DEFAULTS.loadGain*state.load;
   }
   const original=this.m[d]+dt*(decay+cross+inj+feedback)+gauss(this.rng)*t.noise[d]*dt;
   const raw=extra?original+dt*extra:original;
   if(!Number.isFinite(raw))throw new RangeError(`非有限状态 ${d}`);
   if(raw<0||raw>1)this.hitLimit++;
   this.extraTotal+=extra;
   this.m[d]=Math.max(0,Math.min(1,raw));this.pending[d]=0;
  }
 }
}
function run(archetype,seed,options,sensitize){
 const traits=sampleTraits(makeRng(seed),archetype);
 const make=()=>new CandidateBank(traits,makeRng(seed+10000),options,sensitize);
 const banks=[make(),make(),make()];
 const shadow=Array.from({length:3},()=>new ProbeBank(traits,makeRng(seed+10000),options));
 const history=[];
 for(let t=1;t<=600;t++){
  for(const set of [banks,shadow]){
   if(t===20)set[1].inject({arousal:.25});
   if(t===80)for(const i of [0,1])set[i].inject({arousal:.25});
   for(const b of set)b.tick();
   if(t===79)for(const i of [0,1])Object.assign(set[i].m,set[2].m);
  }
  // 负荷锁零或敏化关闭必须复现原探针的每个维度与慢状态。
  if(!sensitize||options.load===false||options.enabled===false)for(let i=0;i<3;i++){
   assert.deepEqual(banks[i].m,shadow[i].m,`快速状态负控失败 ${archetype}/${seed}/${t}/${i}`);
   assert.deepEqual(banks[i].slow.dump(),shadow[i].slow.dump(),`慢状态负控失败 ${archetype}/${seed}/${t}/${i}`);
  }
  if(t>=80)history.push({t,single:Math.abs(banks[0].m.arousal-banks[2].m.arousal),double:Math.abs(banks[1].m.arousal-banks[2].m.arousal),same:DIMS.every(d=>Object.is(banks[0].m[d],banks[1].m[d]))});
 }
 function measure(k){
  let peak=0,consecutive=0,recovery=null,impact=history[0][k];
  for(const h of history){peak=Math.max(peak,h[k]);consecutive=h[k]<=.02?consecutive+1:0;
   if(recovery===null&&peak>.02&&consecutive>=5)recovery=h.t-80-4;}
  return {impact,recovery,censored:recovery===null,afterOut:recovery===null?null:history.filter(h=>h.t>80+recovery+4&&h[k]>.02).length};
 }
 const result={archetype,seed,options,sensitize,single:measure('single'),double:measure('double'),allDimensionsMatch:history.every(h=>h.same),extra:banks.map(b=>b.extraTotal),hitLimit:banks.map(b=>b.hitLimit)};
 if(options.enabled===false)assert.equal(result.allDimensionsMatch,true,'关闭慢层负控失败');
 if(!sensitize&&Object.keys(options).length===0)for(const d of [false,true])
  assert.equal(result[d?'double':'single'].recovery,probe({archetype,seed,double:d,align:true}).recovery,'原闸门重放失败');
 return result;
}
const configs=[{name:'original',options:{},sensitize:false},{name:'candidate',options:{},sensitize:true},
 {name:'load-zero',options:{load:false},sensitize:true},{name:'all-off',options:{enabled:false},sensitize:true}];
const rows=[];
for(const cfg of configs)for(const archetype of ['谨慎','冲动','孤僻'])for(const seed of [7,11,13,23,42])
 rows.push({name:cfg.name,...run(archetype,seed,cfg.options,cfg.sensitize)});
console.log(JSON.stringify({protocol:'一次修复候选；600 更新；同流及快状态对齐；首次入带定义不变',rows},null,2));

// 显式运行预登记的拒绝闸门；默认输出读数，--gate=candidate 必须因失败退出非零。
const gateArg=process.argv.find(x=>x.startsWith('--gate='));
if(gateArg){
 const name=gateArg.slice('--gate='.length);
 assert.ok(configs.some(c=>c.name===name),`未知配置 ${name}`);
 const selected=rows.filter(r=>r.name===name);
 const bad=selected.filter(r=>r.single.impact<=.02||r.double.impact<=.02||r.single.censored||r.double.censored||r.double.recovery<=r.single.recovery);
 assert.equal(bad.length,0,`${name} 不符合逐组双击延长闸门：${bad.length}/${selected.length} 组未达标`);
}
