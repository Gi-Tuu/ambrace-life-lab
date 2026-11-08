// 恢复测量装置：首次入带与依赖窗口末点的持续入带，均相对最后一次打击计时。
export function measureRecovery(deviations, {startTick=80, threshold=.02, minRun=5}={}) {
 if(!Array.isArray(deviations)||!deviations.length||!Number.isInteger(startTick)||!Number.isFinite(threshold)||threshold<0||!Number.isInteger(minRun)||minRun<1||deviations.some(x=>!Number.isFinite(x)||x<0))throw new TypeError('恢复输入非法');
 const impact=deviations[0],endTick=startTick+deviations.length-1;
 if(impact<=threshold)return {valid:false,reason:'NO_IMPACT',impact,startTick,endTick,threshold,minRun,first:null,stable:null,afterFirst:null};
 let run=0,first=null;
 for(let i=0;i<deviations.length;i++){
  run=deviations[i]<=threshold?run+1:0;
  if(first===null&&run>=minRun)first=i-minRun+1;
 }
 let suffix=0;
 for(let i=deviations.length-1;i>=0&&deviations[i]<=threshold;i--)suffix++;
 const stable=suffix>=minRun?deviations.length-suffix:null;
 const afterFirst=first===null?null:deviations.slice(first+minRun).filter(x=>x>threshold).length;
 return {valid:true,impact,startTick,endTick,threshold,minRun,first,stable,afterFirst};
}
export function compareRecovery(single,double) {
 if(!single?.valid||!double?.valid)return 'invalid';
 const validProtocol=r=>Number.isInteger(r.startTick)&&Number.isInteger(r.endTick)&&r.endTick>=r.startTick&&Number.isFinite(r.threshold)&&r.threshold>=0&&Number.isInteger(r.minRun)&&r.minRun>0;
 if(!validProtocol(single)||!validProtocol(double)||['startTick','endTick','threshold','minRun'].some(k=>single[k]!==double[k]))return 'invalid';
 const validEndpoint=r=>{
  const last=r.endTick-r.startTick-r.minRun+1;
  const ok=x=>x===null||(Number.isInteger(x)&&x>=1&&x<=last);
  return Number.isFinite(r.impact)&&r.impact>r.threshold&&ok(r.first)&&ok(r.stable)&&!(r.first===null&&r.stable!==null)&&!(r.first!==null&&r.stable!==null&&r.stable<r.first);
 };
 if(!validEndpoint(single)||!validEndpoint(double))return 'invalid';
 if(single.first===null||double.first===null)return 'unconfirmed';
 if(double.first<=single.first)return 'fail-first';
 if(single.stable===null||double.stable===null)return 'unconfirmed';
 if(double.stable<=single.stable)return 'fail-stable';
 return 'pass';
}
