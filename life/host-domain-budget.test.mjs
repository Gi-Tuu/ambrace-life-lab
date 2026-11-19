// ARCH-HOST-SPLIT budget：预算/闸门/熔断从 host 抽出后必须逐项可断言。
// 这些是"无人不花钱、失败退预扣、跨天归零"三条承诺的全部逻辑，不能只靠整机回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isFreeProvider, modelChannel, breakerOpenAt, budgetTick, observerActive,
  pickProviderKey, createBudgetDomain,
} from './host-budget.mjs';

test('BUDGET-01 免费端点判定：回环/白名单免费，付费覆盖优先，坏 URL 不免费', () => {
  const opts = { freeHosts: ['free.example'], paidHosts: ['paid.example'] };
  assert.equal(isFreeProvider('http://127.0.0.1:8080/v1', opts), true);
  assert.equal(isFreeProvider('https://free.example/api', opts), true);
  assert.equal(isFreeProvider('https://paid.example/api', opts), false);
  assert.equal(isFreeProvider('not a url', opts), false);
});

test('BUDGET-02 车道闸门：免费路只受熔断/节点预算，付费路受观众与钱预算', () => {
  assert.deepEqual(modelChannel({ watched: false, free: true }), { go: true, kind: 'node' });
  assert.deepEqual(modelChannel({ watched: false, free: true, breakerOpen: true }), { go: false, kind: 'node', why: 'BREAKER' });
  assert.deepEqual(modelChannel({ watched: false, free: true, nodeBudget: 2, nodeCalls: 2 }), { go: false, kind: 'node', why: 'NODE_BUDGET' });
  assert.deepEqual(modelChannel({ watched: false, free: false }), { go: false, kind: 'money', why: 'NO_OBSERVER' });
  assert.deepEqual(modelChannel({ watched: false, free: false, allowPaidUnattended: true }), { go: true, kind: 'money' });
  assert.deepEqual(modelChannel({ watched: true, free: false, moneyBudget: 3, moneyCalls: 3 }), { go: false, kind: 'money', why: 'BUDGET' });
});

test('BUDGET-03 observerActive 边界与 budgetTick 跨天归零（同日同引用）', () => {
  assert.equal(observerActive(1000, 4000, 3000), true);
  assert.equal(observerActive(1000, 4001, 3000), false);
  const model = { dayKey: 'd1', calls: 5, tokens: 9, moneyCalls: 2, nodeCalls: 3, attempts: [1], survivalChoices: 4 };
  assert.equal(budgetTick(model, 'd1'), model);
  assert.equal(model.calls, 5);
  budgetTick(model, 'd2');
  assert.equal(model.calls, 0);
  assert.equal(model.tokens, 0);
  assert.equal(model.moneyCalls, 0);
  assert.equal(model.nodeCalls, 0);
  assert.deepEqual(model.attempts, []);
  assert.equal(model.survivalChoices, 0);
});

test('BUDGET-04 breakerOpenAt / pickProviderKey 纯函数', () => {
  assert.equal(breakerOpenAt({ openUntil: 2000 }, 1999), true);
  assert.equal(breakerOpenAt({ openUntil: 2000 }, 2000), false);
  assert.equal(pickProviderKey(['a', 'b'], 1, 2), 'b');
  assert.equal(pickProviderKey(['a'], 5, 1), 'a');
  assert.equal(pickProviderKey([], 0, 3), '');
});

test('BUDGET-05 域对象：先预扣再放行，预算用完拒绝，失败退回预扣', () => {
  const state = {
    lastVisitor: 1000,
    model: { calls: 0, tokens: 0, moneyCalls: 0, nodeCalls: 0, attempts: [], dayKey: '' },
    breaker: { fails: 0, openUntil: 0 },
  };
  const domain = createBudgetDomain({
    getState: () => state, budget: 2, nodeBudget: 0, presenceMs: 10_000,
    breakerFails: 2, breakerMs: 5_000, now: () => 2000,
  });
  assert.equal(domain.gate(), null);
  assert.equal(state.model.calls, 1);
  assert.equal(state.model.reserved, 1);
  domain.release();
  assert.equal(state.model.calls, 0);
  assert.equal(state.model.reserved, 0);
  assert.equal(domain.gate(), null);
  domain.charged(17);
  assert.equal(state.model.tokens, 17);
  assert.equal(state.model.reserved, 0);
  assert.equal(domain.gate(), null);
  assert.equal(domain.gate(), 'BUDGET');
  assert.equal(state.model.calls, 2);
  // 没有观众时预扣也不发生
  state.lastVisitor = -100_000;
  state.model.calls = 0;
  assert.equal(domain.gate(), 'NO_OBSERVER');
  assert.equal(state.model.calls, 0);
});

test('BUDGET-06 域对象：车道记账与熔断计数/打开', () => {
  const state = {
    lastVisitor: Date.now(),
    model: { calls: 0, tokens: 0, moneyCalls: 0, nodeCalls: 0, attempts: [], dayKey: '' },
    breaker: { fails: 0, openUntil: 0, trips: 0 },
  };
  const domain = createBudgetDomain({
    getState: () => state, budget: 10, nodeBudget: 0, presenceMs: 10_000,
    breakerFails: 2, breakerMs: 5_000, now: () => 1000,
  });
  domain.chargeLane(true);
  domain.chargeLane(false);
  domain.chargeLane(false);
  assert.equal(state.model.nodeCalls, 1);
  assert.equal(state.model.moneyCalls, 2);
  domain.see(true, false, 1000);
  assert.equal(state.breaker.fails, 1);
  domain.see(true, false, 1000);
  assert.equal(state.breaker.openUntil, 6000);
  assert.equal(state.breaker.trips, 1);
  assert.equal(domain.breakerOpen(1000), true);
  domain.see(true, true, 1000);
  assert.equal(state.breaker.fails, 0);
});
