// 隔离机械装置，不接真实引擎。单个机会推进一次；禁用路径不写状态、不消耗 RNG。
// u=max(0,stress), D=S 的 delay 步前值（delay=0 使用本步更新前 S）；
// S=max(0,S-S/80+0.08u-feedback*0.02D)，L=max(0,L-L/160+0.08u)；
// fast=fast-fast/(40*(1+4L))-feedback*0.02D+stress+noise。
// fast 为可正负的相对偏差，不在此处钳制；S/L 为非负量。
export const M5_DEFAULTS=Object.freeze({slowTau:80,loadTau:160,delay:8,injection:.08,feedback:.02,loadGain:4,fastTau:40});
export class SlowMechanics {
 constructor({enabled=true,load=true,feedback=true,delay=M5_DEFAULTS.delay}={}) {
  if(!Number.isSafeInteger(delay)||delay<0)throw new RangeError('delay 须为非负整数');
  this.enabled=enabled;this.loadEnabled=load;this.feedbackEnabled=feedback;this.delay=delay;this.slow=0;this.load=0;this.queue=[];
 }
 tick({fast=0,stress=0,noise=0}={}) {
  if (![fast,stress,noise].every(Number.isFinite)) throw new TypeError('输入必须有限');
  const P=M5_DEFAULTS;if(!this.enabled)return {fast:fast-fast/P.fastTau+stress+noise,slow:this.slow,load:this.load};
  const input=Math.max(0,stress),previous=this.slow;
  // 先入 S[t-1] 再取队首：delay=8 在 t=9 读 S[1]，不是 S[0]。
  if(this.delay>0){this.queue.push(previous);if(this.queue.length>this.delay)this.queue.shift()}
  const delayed=this.delay===0?previous:(this.queue.length>=this.delay?this.queue[0]:0);
  this.slow=Math.max(0,previous-previous/P.slowTau+P.injection*input-(this.feedbackEnabled?P.feedback*delayed:0));
  this.load=this.loadEnabled?Math.max(0,this.load-this.load/P.loadTau+P.injection*input):0;
  return {fast:fast-fast/(P.fastTau*(1+P.loadGain*this.load))-(this.feedbackEnabled?P.feedback*delayed:0)+stress+noise,slow:this.slow,load:this.load};
 }
 dump(){return {slow:this.slow,load:this.load,queue:[...this.queue]};}
}
