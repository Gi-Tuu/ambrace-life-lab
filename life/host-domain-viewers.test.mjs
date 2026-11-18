// ARCH-HOST-SPLIT viewers：观看打点的三种模式、非法营地不留痕、重置归零。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewerDomain, observerActive } from './host-viewers.mjs';

function fixture(overrides = {}) {
  const state = {
    lastVisitor: 0,
    viewers: { survival: 0, compare: 0, comparison: 0 },
    campViewers: {},
    ...overrides,
  };
  const marked = [];
  const domain = createViewerDomain({
    getState: () => state,
    presenceMs: 10_000,
    now: () => 5000,
    validCampKey: (key) => key === 'a'.repeat(32) || key === 'b'.repeat(32),
    markSeen: (key, at) => marked.push([key, at]),
  });
  return { state, marked, domain };
}

test('VIEWERS-01 survival 模式只打 survival 与请求自己的营地', () => {
  const { state, domain } = fixture();
  const key = 'a'.repeat(32);
  assert.deepEqual(domain.touch('survival', key), { touched: true, key });
  assert.equal(state.lastVisitor, 5000);
  // 分名字营地走 campViewers；主营地槽位不被它顶掉。
  assert.equal(state.viewers.survival, 0);
  assert.equal(state.campViewers[key], 5000);
  assert.equal(state.viewers.compare, 0);
  domain.touch('survival', 'MAIN');
  assert.equal(state.viewers.survival, 5000);
});

test('VIEWERS-02 MAIN 不污染分营地；compare / comparison 各打各的槽', () => {
  const { state, domain } = fixture();
  domain.touch('survival', 'MAIN');
  assert.equal(state.viewers.survival, 5000);
  assert.equal(state.campViewers.MAIN, 5000);
  assert.equal(state.viewers.compare, 0);
  domain.touch('compare', 'MAIN');
  assert.equal(state.viewers.compare, 5000);
  assert.equal(state.viewers.comparison, 0);
  domain.touch('comparison', 'MAIN');
  assert.equal(state.viewers.comparison, 5000);
});

test('VIEWERS-03 非法/失效营地 key 不更新任何观看槽，也不写 campViewers', () => {
  const { state, domain } = fixture();
  assert.deepEqual(domain.touch('survival', 'not-a-key'), { touched: false, reason: 'CAMP_INVALID' });
  // 全局在场时间仍更新（与 host 原语义一致）；被拒绝的是营地观看槽与 campViewers。
  assert.equal(state.lastVisitor, 5000);
  assert.equal(state.viewers.survival, 0);
  assert.deepEqual(state.campViewers, {});
});

test('VIEWERS-04 markSeen 只在有效营地调用；snapshot/keys/reset 一致', () => {
  const { state, marked, domain } = fixture();
  const key = 'b'.repeat(32);
  domain.touch('survival', key);
  domain.touch('survival', 'MAIN');
  domain.touch('survival', 'bad');
  assert.deepEqual(marked, [[key, 5000]]);
  assert.deepEqual(domain.keys().sort(), ['MAIN', key].sort());
  assert.equal(domain.watching(key), true);
  assert.equal(domain.watching('nothing'), false);
  assert.equal(observerActive(0, 5000, 4999), false);
  domain.reset();
  assert.equal(state.lastVisitor, 0);
  assert.deepEqual(state.viewers, { survival: 0, compare: 0, comparison: 0 });
  assert.deepEqual(state.campViewers, {});
});
