// M5：真实四维快仓 + 逐事件慢仓。仅显式 C2/m5 开启；默认实例仍为原 ModulatorBank。
import {ModulatorBank} from './modulators.mjs';
import {DIMS} from './traits.mjs';
import {gauss} from './rng.mjs';
import {hill} from './modulators.mjs';
import {PARAMS} from './params.mjs';
import {EventExposureLedger} from './m5-event-exposure.mjs';
const clamp01=v=>Math.max(0,Math.min(1,v));
class FastBank extends ModulatorBank {
 constructor(traits,rng,override,{brake=true,multidim=true,symmetric=true}={}){super(traits,rng,override);this.brake=brake;this.multidim=multidim;this.symmetric=symmetric;}
 tick(dt=1){
  const t=this.traits;
  for(const d of DIMS){
   let brake=0;
   if(this.brake&&(this.multidim||d==='arousal')){const x=this.m[d]-t.baseline[d];const r=this.symmetric?Math.max(-1,Math.min(1,x/(x>=0?1-t.baseline[d]:t.baseline[d]))):Math.max(0,Math.min(1,x/(1-t.baseline[d])));brake=-t.U_max*r;}
   let cross=0;for(let j=0;j<DIMS.length;j++)cross+=(t.w[DIMS.indexOf(d)]?.[j]??0)*hill(this.x(DIMS[j]));
   const decay=-this.x(d)/t.tau[d],inj=Math.max(-t.U_max,Math.min(t.U_max,this.pending[d]));
   this.m[d]=clamp01(this.m[d]+dt*(decay+cross+inj+brake)+gauss(this.rng)*t.noise[d]*dt);this.pending[d]=0;
  }
 }
}
export function validateM5State(state,expectedDelay=null,expectedScale=null){
 const okDim=(obj,clamped)=>obj&&DIMS.every(d=>Number.isFinite(obj[d])&&(!clamped||(obj[d]>=0&&obj[d]<=1)));
 const e=state?.exposure,scale=state?.version===1?1:state?.slowScale;
 if(!state||(state.version!==1&&state.version!==2)||!Number.isFinite(scale)||scale<=0||(expectedScale!==null&&scale!==expectedScale)||!Number.isSafeInteger(state.delay)||state.delay<0||(expectedDelay!==null&&state.delay!==expectedDelay)||!okDim(state.fast,true)||!okDim(state.pending,false)||!Number.isFinite(state.slow)||state.slow<0||!Number.isFinite(state.load)||state.load<0||state.load>1||!Array.isArray(state.queue)||state.queue.length>state.delay||state.queue.some(v=>!Number.isFinite(v)||v<0)||!e||!Number.isFinite(e.pending)||e.pending<0||e.pending>1||!Number.isSafeInteger(e.count)||e.count<0)throw new TypeError('无效或不兼容的 M5 存档');
 return true;
}
export class M5ModulatorBank{
 constructor(traits,rng,override,{brake=true,multidim=true,symmetric=true,read=true,slowInput=true,load=true,feedback=true,delay=PARAMS.m5.delay,exposure=true}={}){
  if(!Number.isSafeInteger(delay)||delay<0)throw new RangeError('M5 delay 必须是非负整数');
  this.traits=traits;this.rng=rng;this.options={brake:Boolean(brake),multidim:Boolean(multidim),symmetric:Boolean(symmetric),read:Boolean(read),slowInput:Boolean(slowInput),load:Boolean(load),feedback:Boolean(feedback),delay,exposure:Boolean(exposure)};
  this.fast=new FastBank(traits,rng,override,{brake:this.options.brake,multidim:this.options.multidim,symmetric:this.options.symmetric});this.pending=this.fast.pending;
  this.slow=0;this.load=0;this.queue=[];this.exposure=new EventExposureLedger({enabled:this.options.exposure});
  this.m={};
  for(const d of DIMS)Object.defineProperty(this.m,d,{enumerable:true,configurable:false,
   get:()=>d==='arousal'&&this.options.read?clamp01(this.fast.m[d]+this.slow):this.fast.m[d],
   set:v=>{
    if(!Number.isFinite(v))throw new TypeError('钳制值必须有限');
    const target=clamp01(v);
    if(d==='arousal'&&this.options.read){if(this.slow>target)this.slow=target;this.fast.m[d]=clamp01(target-this.slow);}
    else this.fast.m[d]=target;
   }});
 }
 x(d){return this.m[d]-this.traits.baseline[d];}
 inject(spec){this.fast.inject(spec);}
 observeEvent(event,appraisal){return this.exposure.observe(event,appraisal);}
 tick(dt=1){
  if(dt!==1)throw new RangeError('启用 M5 时只能按单个调制更新推进');
  this.fast.tick(1);
  const p=PARAMS.m5,u=this.exposure.consume(),previous=this.slow;
  this.load=this.options.load?clamp01(this.load-this.load/p.loadTau+u):0;
  if(this.options.delay>0){this.queue.push(previous);if(this.queue.length>this.options.delay)this.queue.shift();}
  const delayed=this.options.delay===0?previous:(this.queue.length>=this.options.delay?this.queue[0]:0);
  const input=this.options.slowInput?u*p.slowScale:0,feedback=this.options.feedback?p.feedback*delayed:0;
  this.slow=Math.max(0,previous-previous/(p.slowTau*(1+p.loadGain*this.load))+input-feedback);
  if(!Number.isFinite(this.slow))throw new RangeError('M5 慢状态非有限');
 }
 snapshot(){return {...this.m};}
 summary(){return ModulatorBank.prototype.summary.call(this);}
 dumpM5(){return {version:2,slowScale:PARAMS.m5.slowScale,delay:this.options.delay,fast:{...this.fast.m},pending:{...this.pending},slow:this.slow,load:this.load,queue:[...this.queue],exposure:this.exposure.dump()};}
 loadM5(state,legacyM){
  if(state==null){
   for(const d of DIMS){const v=legacyM?.[d];if(Number.isFinite(v))this.fast.m[d]=clamp01(v);this.pending[d]=0;}
   this.slow=0;this.load=0;this.queue=[];this.exposure.pending=0;this.exposure.count=0;return 'legacy';
  }
  validateM5State(state,this.options.delay,PARAMS.m5.slowScale);
  const e=state.exposure;
  Object.assign(this.fast.m,state.fast);Object.assign(this.pending,state.pending);
  this.slow=state.slow;this.load=state.load;this.queue=[...state.queue];this.exposure.pending=e.pending;this.exposure.count=e.count;return 'loaded';
 }
}
