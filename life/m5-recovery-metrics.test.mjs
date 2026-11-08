import test from 'node:test';
import assert from 'node:assert/strict';
import {measureRecovery,compareRecovery} from './m5-recovery-metrics.mjs';

test('首次入带后再出带时，分别保留首次与窗口末持续时间',()=>{
 const x=measureRecovery([.1,...Array(5).fill(.02),.03,...Array(6).fill(.01)]);
 assert.deepEqual({first:x.first,stable:x.stable,afterFirst:x.afterFirst,endTick:x.endTick},{first:1,stable:7,afterFirst:1,endTick:92});
});
test('最后不足五次入带时未确认，恰好五次才确认',()=>{
 const a=measureRecovery([.1,...Array(5).fill(.01),.03,...Array(4).fill(.01)]);
 const b=measureRecovery([.1,...Array(5).fill(.01),.03,...Array(5).fill(.01)]);
 assert.equal(a.first,1);assert.equal(a.stable,null);assert.equal(b.stable,7);
});
test('无有效冲击与无恢复分别识别，阈值边界归入带内',()=>{
 assert.equal(measureRecovery([.02,...Array(5).fill(0)]).reason,'NO_IMPACT');
 const x=measureRecovery([.03,...Array(12).fill(.03)]);assert.equal(x.first,null);assert.equal(x.stable,null);
 const y=measureRecovery([.03,...Array(5).fill(.02)]);assert.equal(y.first,1);assert.equal(y.stable,1);
 for(const invalid of [[],[.1,NaN],[.1,-.1]])assert.throws(()=>measureRecovery(invalid));
});
test('正例和可打红对照：双击必须在两个端点都严格晚于单击',()=>{
 const obs=(first,stable)=>({valid:true,impact:.1,first,stable,startTick:80,endTick:600,threshold:.02,minRun:5});
 assert.equal(compareRecovery(obs(2,3),obs(3,4)),'pass');
 assert.equal(compareRecovery(obs(2,3),obs(2,4)),'fail-first');
 assert.equal(compareRecovery(obs(2,3),obs(3,3)),'fail-stable');
 assert.equal(compareRecovery(obs(2,3),obs(3,null)),'unconfirmed');
 assert.equal(compareRecovery(obs(2,null),obs(3,4)),'unconfirmed');
 assert.equal(compareRecovery({valid:false},obs(3,4)),'invalid');
});

test('比较器拒绝窗口、阈值或连续长度不同，以及缺失协议',()=>{
 const base={valid:true,impact:.1,first:2,stable:3,startTick:80,endTick:600,threshold:.02,minRun:5};
 const late={...base,first:3,stable:4};
 assert.equal(compareRecovery(base,late),'pass');
 for(const [field,value] of [['startTick',81],['endTick',601],['threshold',.03],['minRun',6]]){
  assert.equal(compareRecovery(base,{...late,[field]:value}),'invalid',field);
  const missing={...late};delete missing[field];assert.equal(compareRecovery(base,missing),'invalid',field+' 缺失');
 }
});

test('比较器拒绝伪造或越界的恢复端点及无效冲击',()=>{
 const base={valid:true,impact:.1,first:2,stable:3,startTick:80,endTick:600,threshold:.02,minRun:5};
 for(const bad of [{first:-1},{first:517},{stable:1},{first:null,stable:4},{first:'3'},{impact:.02}])
  assert.equal(compareRecovery(base,{...base,...bad}),'invalid');
});
