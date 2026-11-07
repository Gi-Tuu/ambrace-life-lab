import test from 'node:test';import assert from 'node:assert/strict';import {SlowMechanics} from './m5-slow.mjs';import {runCase} from './m5-mechanics-eval.mjs';
test('关闭层不改状态或旧快通道计算',()=>{const m=new SlowMechanics({enabled:false});const before=m.dump(),r=m.tick({fast:.4,stress:.25,noise:.01});assert.equal(r.fast,.4-.4/40+.25+.01);assert.deepEqual(m.dump(),before)});
test('负荷可独立锁零，反馈与立即反馈不混同',()=>{const a=new SlowMechanics({load:false}),b=new SlowMechanics({feedback:false}),c=new SlowMechanics({delay:0});for(let i=0;i<12;i++){a.tick({stress:.25});b.tick({stress:.25});c.tick({stress:.25})}assert.equal(a.load,0);assert.ok(b.load>0);assert.notEqual(b.slow,c.slow)});
test('实验重复且有实质打击，右删失明确',()=>{const a=runCase({seed:7,double:false}),b=runCase({seed:7,double:false});assert.deepEqual(a,b);assert.ok(a.peak>.02);assert.equal(a.censored,a.recovery===null)});


test('同刻最后打击、快状态对齐后双击恢复更慢；负荷锁零和关闭层负控不产生差值',()=>{
 const run=(opts,double)=>runCase({...opts,double,alignFast:true,noiseAmplitude:0});
 const single=run({},false),double=run({},true);
 assert.ok(single.peak>.02&&double.peak>.02&&!single.censored&&!double.censored);
 assert.ok(double.recovery>single.recovery, `双击 ${double.recovery} 未大于单击 ${single.recovery}`);
 for(const opts of [{load:false},{enabled:false}]){const a=run(opts,false),b=run(opts,true);assert.equal(b.recovery,a.recovery);}
});
test('同噪声五种子：对齐后双击比单击恢复慢，且不丢弃删失',()=>{
 for(const seed of [7,11,13,23,42]){const a=runCase({seed,alignFast:true,noiseAmplitude:.001}),b=runCase({seed,alignFast:true,noiseAmplitude:.001,double:true});assert.ok(!a.censored&&!b.censored,`seed ${seed} 未恢复须保留为删失`);assert.ok(b.recovery>a.recovery,`seed ${seed} 未延长`);}
});
test('自然未对齐的旧通道可因首击残余而变慢，说明负控不能省略对齐',()=>{
 const a=runCase({enabled:false,double:false}),b=runCase({enabled:false,double:true});assert.ok(b.recovery>a.recovery);
});

// 脉冲的 S[1] 在第 1+delay 步首次反馈；立即反馈和 delay=1 都在 t=2 使用 S[1]。
test('延迟队列按登记的 S[t-delay] 取值，不多滞后一刻',()=>{
 for(const delay of [0,1,8]){
  const a=new SlowMechanics({delay,load:false}),b=new SlowMechanics({delay,load:false,feedback:false});
  const first=delay===0?2:delay+1;
  for(let t=1;t<=first;t++){
   const stress=t===1?.25:0;
   a.tick({stress});b.tick({stress});
   if(t<first)assert.equal(a.slow,b.slow,`delay=${delay},t=${t} 反馈过早`);
   else assert.ok(b.slow-a.slow>0.00039&&b.slow-a.slow<0.00041,`delay=${delay},t=${t} 不等于 0.02*S[1]`);
  }
 }
});
