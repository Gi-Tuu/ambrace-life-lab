// M5 pin 预登记：固定 seed 与零调制噪声；真实 simulate 在每 tick 结束钳制，
// 分别重跑每个前缀验证四维高低目标及快仓边界；低 arousal 可削慢仓，是外部干预。
import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from './run.mjs';
import {M5ModulatorBank} from './m5-bank.mjs';
import {DIMS,sampleTraits} from './traits.mjs';
import {makeRng} from './rng.mjs';
import {PARAMS} from './params.mjs';

const zeroNoise=Object.fromEntries(DIMS.map(d=>[d,0]));
const eps=1e-12;
test('真实 simulate 钳制路径每 tick 四维高低目标与快仓边界',async()=>{
 for(const value of [.1,.9]){
  const targets=Object.fromEntries(DIMS.map(d=>[d,value]));
  for(let ticks=1;ticks<=16;ticks++){
   const {agents}=await simulate({seed:907,ticks,condition:'C2',events:false,channelMask:{m5:1},pin:{a1:targets},traitsOverride:{a1:{noise:zeroNoise}}});
   const bank=agents.a1.bank;assert.ok(bank instanceof M5ModulatorBank);
   for(const d of DIMS){
    assert.ok(Math.abs(bank.m[d]-value)<eps,`${d} t=${ticks} target=${value} actual=${bank.m[d]}`);
    assert.ok(bank.fast.m[d]>=0&&bank.fast.m[d]<=1,`${d} 快仓越界`);
   }
  }
 }
});
test('持续外部钳制保留负荷与延迟推进，低警觉钳制实际削慢仓',()=>{
 const traits=sampleTraits(makeRng(907),'谨慎');traits.noise=zeroNoise;
 const b=new M5ModulatorBank(traits,()=>.5);
 const event={kind:'shortfall',valence:-.4}, appraisal={parts:{norm:0}};
 b.observeEvent(event,appraisal);b.tick();const slow0=.4*PARAMS.m5.slowScale;assert.equal(b.slow,slow0);assert.equal(b.load,.4);
 b.m.arousal=.9;assert.equal(b.slow,slow0);assert.ok(Math.abs(b.m.arousal-.9)<eps);assert.ok(Math.abs(b.fast.m.arousal-(.9-slow0))<eps);
 const low=slow0/2;b.m.arousal=low;assert.equal(b.slow,low);assert.equal(b.fast.m.arousal,0);assert.equal(b.m.arousal,low);
 let priorLoad=b.load;
 for(let t=1;t<=12;t++){
  b.tick();b.m.arousal=low;
  assert.ok(Math.abs(b.m.arousal-low)<eps);assert.ok(b.fast.m.arousal>=0&&b.fast.m.arousal<=1);
  assert.ok(b.load<priorLoad);priorLoad=b.load;assert.ok(b.queue.length<=8);
 }
 assert.equal(b.queue.length,8);assert.equal(b.exposure.pending,0);
 for(const d of DIMS.filter(x=>x!=='arousal'))for(const v of [.1,.9]){
  const s=b.slow;b.m[d]=v;assert.equal(b.m[d],v);assert.equal(b.slow,s);
 }
});
