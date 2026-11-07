// M3 停止条件反例：给定组件自己计算出的四个竞争信号，4 个 if 精确复现状态选择。
import test from 'node:test';
import assert from 'node:assert/strict';
import {BehaviorState, BEHAVIOR_STATES} from './m3-state.mjs';
function fourIf(previous, remaining, s) {
 if (previous && remaining > 0) return previous;
 if (s.recover >= s.connect && s.recover >= s.explore && s.recover >= s.guard) return 'recover';
 if (s.connect > s.recover && s.connect >= s.explore && s.connect >= s.guard) return 'connect';
 if (s.explore > s.recover && s.explore > s.connect && s.explore >= s.guard) return 'explore';
 return 'guard';
}
test('四条 if 精确覆盖候选的选择及承诺，触发不超过 20 条的停止条件',()=>{
 let n=0;
 for(const previous of [null,...BEHAVIOR_STATES])for(const remaining of [0,1,3])for(const energy of [0,.2,1,5])for(const social of [0,.2,1,5])for(const stimulus of [0,.5,2])for(const risk of [0,.6]){
  const m=new BehaviorState();m.load({state:previous,remaining});const before=m.dump();
  const drives={errors:()=>[{name:'energy',urgency:energy},{name:'social',urgency:social},{name:'stimulation',urgency:stimulus,dir:1}]};
  const bank={m:{approach:.4,quiescence:.6,inhibit:.3,arousal:.5}};
  const r=m.step({drives,bank,risk,commitment:4});assert.equal(r.state,fourIf(before.state,before.remaining,r.signals));n++;
 }
 assert.ok(n>=1000);
});
