// M3 受限规则基准：仅能读取显式白名单中的选择前特征；结果为受限规则族证据。
// 谓词：有限阈值、类别相等、两个事前标量比较；每条最多 3 项合取，最多 20 条。
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const prohibited = new Set(['y', 'label', 'target', 'nextState', 'next_state', 'selected', 'result']);
const count = ys => { const m=new Map(); for(const y of ys) m.set(y,(m.get(y)??0)+1); return m; };
function majority(ys) { const c=count(ys); return [...c].sort((a,b)=>b[1]-a[1]||String(a[0]).localeCompare(String(b[0])))[0]?.[0]??null; }
function validateFeatures(allowed) {
 if (!Array.isArray(allowed) || !allowed.length || new Set(allowed).size!==allowed.length || allowed.some(k=>typeof k!=='string'||!k||prohibited.has(k))) throw new TypeError('必须提供无目标标签的唯一特征白名单');
}
function validateRows(rows,allowed) {
 if(!Array.isArray(rows)||!rows.length) throw new TypeError('数据不能为空');
 for(const r of rows){if(!r||!Number.isFinite(r.t)||!(typeof r.seed==='number'||typeof r.seed==='string')||typeof r.y!=='string'||!r.y||!r.x)throw new TypeError('每条记录须有 seed、t、x、y');for(const k of allowed)if(!has(r.x,k)||!(typeof r.x[k]==='string'||r.x[k]===null||Number.isFinite(r.x[k])))throw new TypeError(`事前特征无效: ${k}`);}
}
function checkPredicate(p,allowed) {
 if(!p||!allowed.includes(p.left)||!['eq','gt','ge','lt','le'].includes(p.op))throw new TypeError('无效谓词');
 if(('rightFeature' in p)===('value' in p))throw new TypeError('谓词必须使用特征或常数其一');
 if('rightFeature' in p&&!allowed.includes(p.rightFeature))throw new TypeError('比较特征不在白名单');
 if('value' in p&&!(p.value===null||typeof p.value==='string'||Number.isFinite(p.value)))throw new TypeError('阈值无效');
}
export function matches(p,x) {
 const a=x[p.left],b=has(p,'rightFeature')?x[p.rightFeature]:p.value;
 if(p.op==='eq')return a===b;
 if(!Number.isFinite(a)||!Number.isFinite(b))return false;
 if(p.op==='gt')return a>b;if(p.op==='ge')return a>=b;if(p.op==='lt')return a<b;if(p.op==='le')return a<=b;
 throw new TypeError('未知运算');
}
export function predictRuleList(model,x) {
 if(!model||!Array.isArray(model.rules)||model.rules.length>20)throw new TypeError('规则表超出预算');
 for(const rule of model.rules){if(!Array.isArray(rule.all)||!rule.all.length||rule.all.length>3)throw new TypeError('每条规则须有 1–3 个原子条件');if(rule.all.every(p=>matches(p,x)))return rule.label;}
 return model.fallback;
}
export function scoreRuleList(model,rows,allowedFeatures) {
 validateFeatures(allowedFeatures);validateRows(rows,allowedFeatures);
 if(!model||!Array.isArray(model.rules)||model.rules.length>20)throw new TypeError('规则表超出预算');
 for(const rule of model.rules){if(!Array.isArray(rule.all)||!rule.all.length||rule.all.length>3)throw new TypeError('每条规则须有 1–3 个原子条件');for(const predicate of rule.all)checkPredicate(predicate,allowedFeatures);}
 let correct=0;const byClass={};for(const r of rows){const prediction=predictRuleList(model,r.x);const hit=prediction===r.y;if(hit)correct++;const c=byClass[r.y]??{n:0,correct:0};c.n++;if(hit)c.correct++;byClass[r.y]=c;}
 return {n:rows.length,correct,accuracy:correct/rows.length,byClass};
}
// 穷举受限候选的贪心覆盖搜索，不保证找到表达能力上存在的规则。
export function fitRuleList(train,{allowedFeatures,predicates,maxRules=20,beamWidth=24}={}) {
 validateFeatures(allowedFeatures);validateRows(train,allowedFeatures);
 if(!Number.isInteger(maxRules)||maxRules<0||maxRules>20||!Number.isInteger(beamWidth)||beamWidth<1)throw new RangeError('规则预算无效');
 if(!Array.isArray(predicates)||predicates.length>64)throw new RangeError('谓词须由预登记协议提供，最多 64 条');
 predicates.forEach(p=>checkPredicate(p,allowedFeatures));
 let remaining=[...train],rules=[];
 for(let n=0;n<maxRules&&remaining.length;n++) {
  const base=majority(remaining.map(r=>r.y));let beam=[{indices:[],rows:remaining}],best=null;
  for(let depth=1;depth<=3;depth++) {
   const next=[];
   for(const b of beam)for(let i=(b.indices.at(-1)??-1)+1;i<predicates.length;i++){
    const subset=b.rows.filter(r=>matches(predicates[i],r.x));if(!subset.length)continue;
    const label=majority(subset.map(r=>r.y));const hit=subset.filter(r=>r.y===label).length,baseHit=subset.filter(r=>r.y===base).length;
    const node={indices:[...b.indices,i],rows:subset,label,gain:hit-baseHit};
    if(node.gain>0&&(!best||node.gain>best.gain||(node.gain===best.gain&&subset.length>best.rows.length)))best=node;
    next.push(node);
   }
   next.sort((a,b)=>b.gain-a.gain||b.rows.length-a.rows.length||a.indices.join(',').localeCompare(b.indices.join(',')));beam=next.slice(0,beamWidth);
   if(!beam.length)break;
  }
  if(!best)break;
  const selected=best.indices.map(i=>predicates[i]);rules.push({all:selected,label:best.label});remaining=remaining.filter(r=>!selected.every(p=>matches(p,r.x)));
 }
 return {rules,fallback:majority(remaining.length?remaining.map(r=>r.y):train.map(r=>r.y)),allowedFeatures:[...allowedFeatures],method:'greedy beam; no completeness guarantee'};
}
export function evaluateHeldout(train,test,options) {
 validateFeatures(options?.allowedFeatures);validateRows(train,options.allowedFeatures);validateRows(test,options.allowedFeatures);
 const trainingSeeds=new Set(train.map(r=>r.seed));if(test.some(r=>trainingSeeds.has(r.seed)))throw new Error('留出种子与训练重叠');
 if(Math.max(...train.map(r=>r.t))>=Math.min(...test.map(r=>r.t)))throw new Error('留出窗口须严格晚于训练窗口');
 const model=fitRuleList(train,options),trainScore=scoreRuleList(model,train,options.allowedFeatures),testScore=scoreRuleList(model,test,options.allowedFeatures);
 const baseline={rules:[],fallback:majority(train.map(r=>r.y))};return {model,train:trainScore,test:testScore,baseline:scoreRuleList(baseline,test,options.allowedFeatures),scope:'仅限指定特征、谓词和贪心搜索；失败不证明任意 20 条 if-else 不存在'};
}
// 显式正控：候选已计算、但选择动作之前可见的四个竞争信号；无目标标签。
// 若新候选的对应决策前信号也存在，必须同样提供，不能只给旧系统。
export const OLD_FEATURES=Object.freeze(['previous','remaining','recover','connect','explore','guard']);
export function oldSelectorWitness() {
 const atoms=(...xs)=>xs.map(([left,op,right])=>({left,op,...(left !== 'previous' && typeof right==='string'&&OLD_FEATURES.includes(right)?{rightFeature:right}:{value:right})}));
 return {rules:[...['recover','connect','explore','guard'].map(label=>({all:atoms(['previous','eq',label],['remaining','gt',0]),label})),
  {all:atoms(['recover','ge','connect'],['recover','ge','explore'],['recover','ge','guard']),label:'recover'},
  {all:atoms(['connect','gt','recover'],['connect','ge','explore'],['connect','ge','guard']),label:'connect'},
  {all:atoms(['explore','gt','recover'],['explore','gt','connect'],['explore','ge','guard']),label:'explore'}],fallback:'guard'};
}
