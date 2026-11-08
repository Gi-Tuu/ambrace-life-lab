// 隔离输入装置：负价或规范冲突暴露代理，不是普遍生理应激；尚未接生产引擎。
const clamp01=v=>Math.max(0,Math.min(1,v));
export function eventExposure(event,appraisal){
 if(!event||!Number.isFinite(event.valence)||!Number.isFinite(appraisal?.parts?.norm))throw new TypeError('事件价态与规范评价必须为有限数');
 const negative=clamp01(Math.max(0,-event.valence));
 const norm=event.violates?clamp01(appraisal.parts.norm):0;
 return Math.max(negative,norm);
}
export class EventExposureLedger{
 constructor({enabled=false,score=eventExposure}={}){this.enabled=enabled;this.score=score;this.pending=0;this.count=0;}
 observe(event,appraisal){
  if(!this.enabled)return 0;
  const value=this.score(event,appraisal);
  if(!Number.isFinite(value)||value<0||value>1)throw new RangeError('暴露量必须位于 [0,1]');
  if(value>0){this.pending=Math.min(1,this.pending+value);this.count++;}
  return value;
 }
 consume(){if(!this.enabled)return 0;const value=this.pending;this.pending=0;return value;}
 dump(){return {pending:this.pending,count:this.count};}
}
