import test from 'node:test';
import assert from 'node:assert/strict';
import {fitRuleList,predictRuleList,scoreRuleList,evaluateHeldout,oldSelectorWitness,OLD_FEATURES} from './m3-benchmark.mjs';
const feature=['signal'];
function rows(seed,start,n=80){return Array.from({length:n},(_,i)=>({seed,t:start+i,x:{signal:i%2?1:-1},y:i%2?'B':'A'}));}
const opts={allowedFeatures:feature,predicates:[{left:'signal',op:'ge',value:0},{left:'signal',op:'lt',value:0}]};
test('旧四态选择器：≤7 条规则覆盖承诺和所有平局，完整信号输入下强正控',()=>{
 const model=oldSelectorWitness();assert.equal(model.rules.length,7);assert.ok(model.rules.every(r=>r.all.length<=3));let n=0;
 const names=['recover','connect','explore','guard'];
 for(const previous of [null,...names])for(const remaining of [0,1,3])for(const a of [0,.5,1])for(const b of [0,.5,1])for(const c of [0,.5,1])for(const d of [0,.5,1]){
  const x={previous,remaining,recover:a,connect:b,explore:c,guard:d};
  const expected=previous&&remaining>0?previous:names.reduce((winner,name)=>x[name]>x[winner]?name:winner);
  assert.equal(predictRuleList(model,x),expected);n++;
 }
 assert.equal(n,1215);
});
test('独立种子且未来窗口的可执行规则正控、众数和留出标签隔离',()=>{
 const train=rows(7,1),held=rows(23,101);const result=evaluateHeldout(train,held,opts);
 assert.equal(result.test.accuracy,1);assert.equal(result.baseline.accuracy,.5);assert.ok(result.model.rules.length<=20);
 const inverted=held.map(r=>({...r,y:r.y==='A'?'B':'A'}));const changed=evaluateHeldout(train,inverted,opts);
 assert.deepEqual(changed.model,result.model);assert.equal(changed.test.accuracy,0);
});
test('无特征规则负控只能回退训练众数；洗牌标签不能创造稳定完美映射',()=>{
 const train=rows(7,1),held=rows(23,101);const constant=fitRuleList(train,{allowedFeatures:feature,predicates:[]});
 assert.equal(constant.rules.length,0);assert.equal(scoreRuleList(constant,held,feature).accuracy,.5);
 const scrambled=train.map((r,i)=>({...r,y:Math.floor(i/2)%2?'A':'B'}));
 const fitted=fitRuleList(scrambled,opts);assert.equal(scoreRuleList(fitted,held,feature).accuracy,.5);
});
test('禁止共用种子、未来训练和目标泄漏，强制限制规则预算',()=>{
 const a=rows(7,1),future=rows(23,101);
 assert.throws(()=>evaluateHeldout(a,rows(7,101),opts),/重叠/);
 assert.throws(()=>evaluateHeldout(a,rows(23,50),opts),/严格晚于/);
 assert.throws(()=>fitRuleList(a,{allowedFeatures:['label'],predicates:[]}),/白名单/);
 assert.throws(()=>fitRuleList(a,{...opts,maxRules:21}),/预算/);
 assert.throws(()=>fitRuleList(a,{allowedFeatures:feature,predicates:[{left:'signal',op:'ge',rightFeature:'y'}]}),/白名单/);
 assert.throws(()=>predictRuleList({rules:[{all:Array(4).fill(opts.predicates[0]),label:'A'}],fallback:'B'},{signal:1}),/1–3/);
});

test('评分器拒绝手写规则读取白名单外字段，不能用标签同名旁路',()=>{
 const leaked=rows(23,101).map(r=>({...r,x:{...r.x,hiddenTarget:r.y}}));
 const rule={rules:[{all:[{left:'hiddenTarget',op:'eq',value:'A'}],label:'A'}],fallback:'B'};
 assert.throws(()=>scoreRuleList(rule,leaked,feature),/无效谓词/);
});
