import {SlowMechanics} from './m5-slow.mjs';
import {makeRng} from './rng.mjs';
export function runCase({double=false,seed=7,noiseAmplitude=0,enabled=true,load=true,feedback=true,delay=8,alignFast=false}={}){
 const rng=makeRng(seed), noise=Array.from({length:600},()=>noiseAmplitude*(rng()*2-1));
 const slow=new SlowMechanics({enabled,load,feedback,delay}),reference=new SlowMechanics({enabled,load,feedback,delay});let fast=0,base=0,peak=0,consecutive=0,recovery=null;const samples=[];
 for(let t=1;t<=600;t++){const stress=(t===80||(double&&t===20))?.25:0;fast=slow.tick({fast,stress,noise:noise[t-1]}).fast;base=reference.tick({fast:base,stress:0,noise:noise[t-1]}).fast;
  if(t===79&&alignFast) fast=base; // 受控对齐：仅消除快速前史，慢量/队列保留
  if(t>=80){const delta=Math.abs(fast-base);peak=Math.max(peak,delta);consecutive=delta<=.02?consecutive+1:0;if(recovery===null&&peak>.02&&consecutive>=5)recovery=t-80-4;}
  if([20,79,80,120,200,600].includes(t))samples.push({t,fast,base,slow:slow.slow,load:slow.load});
 }
 return {seed,double,noiseAmplitude,enabled,load,feedback,delay,alignFast,peak,recovery,censored:recovery===null,samples};
}
if(import.meta.url===new URL(`file:///${process.argv[1]?.replaceAll('\\','/')}`).href){let rows=[];for(const alignFast of [false,true])for(const n of [0,.001])for(const seed of [7,11,13,23,42])for(const cfg of [{},{load:false},{feedback:false},{delay:0},{enabled:false}])for(const double of [false,true])rows.push(runCase({seed,noiseAmplitude:n,double,alignFast,...cfg}));console.log(JSON.stringify({protocol:'600 tick；20、80，剂量.25；阈值.02连续5；未恢复右删失',rows},null,2));}
