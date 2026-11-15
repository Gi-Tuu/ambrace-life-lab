// SA8：两本账分离 + 熔断只关免费路（节点/中继），付费路不受熔断影响。
// 负向对照：把熔断判断挪到两路之前（也挡付费）⇒ 本闸门红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelChannel } from './host.mjs';

const FREE = { free: true, watched: true };
const PAID = { free: false, watched: true };

test('SA8-1 免费路：熔断与节点预算各自挡住，互不牵连钱账', () => {
  assert.deepEqual(modelChannel({ ...FREE, breakerOpen: true }), { go: false, kind: 'node', why: 'BREAKER' });
  assert.deepEqual(modelChannel({ ...FREE, nodeCalls: 5, nodeBudget: 5 }), { go: false, kind: 'node', why: 'NODE_BUDGET' });
  // 钱账用尽不影响免费路
  assert.deepEqual(modelChannel({ ...FREE, moneyCalls: 999, moneyBudget: 1 }), { go: true, kind: 'node' });
});

test('SA8-2 付费路：熔断不影响（只关免费路）；无人禁付费；钱账独立', () => {
  assert.deepEqual(modelChannel({ ...PAID, breakerOpen: true }), { go: true, kind: 'money' }, '熔断不得连坐付费路');
  assert.equal(modelChannel({ ...PAID, watched: false }).why, 'NO_OBSERVER');
  assert.equal(modelChannel({ ...PAID, watched: false, allowPaidUnattended: true }).go, true);
  assert.deepEqual(modelChannel({ ...PAID, moneyCalls: 2, moneyBudget: 2 }), { go: false, kind: 'money', why: 'BUDGET' });
  // 节点账用尽不影响付费路
  assert.deepEqual(modelChannel({ ...PAID, nodeCalls: 999, nodeBudget: 1 }), { go: true, kind: 'money' });
});
