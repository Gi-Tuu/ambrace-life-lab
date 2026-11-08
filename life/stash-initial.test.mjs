// F1 闸门（PLAN §26）：stash 死旋钮修复后，显式传入的初始私人库存必须真实生效；默认档不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, spawn } from './body.mjs';

test('F1 显式 stash 生效：t0 私人库存等于传入值（0/3/5 三档）', () => {
  for (const stash of [0, 3, 5]) {
    const w = makeWorld({ pantries: 6, stash });
    spawn(w, 'a1', 'home');
    spawn(w, 'a2', 'hall');
    assert.equal(w.stash.a1, stash, `stash=${stash} 没生效 ⇒ 死旋钮还在`);
    assert.equal(w.stash.a2, stash);
    assert.equal(w.expect.a1, stash, '预期库存应跟初始库存一致，否则开局就登记"缺口"秘密');
  }
});

test('F1 默认档不变：不传 stash 时仍为 3（历史默认路径逐位不变的前提）', () => {
  const w = makeWorld({ pantries: 6 });
  spawn(w, 'a1', 'home');
  assert.equal(w.stash.a1, 3);
  const w2 = makeWorld({ pantries: 3 }); // host 演示现在的调用形状
  spawn(w2, 'a1', 'home');
  assert.equal(w2.stash.a1, 3, '演示路径的初始库存变了 ⇒ 违反 F1 停止条件');
});
