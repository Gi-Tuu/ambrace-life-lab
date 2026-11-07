import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotBeforeTick, fitDecisionRules, predictDecision, evaluateTemporal } from './o18-metrics.mjs';
const row = (t, loc, y) => ({ t, x: { energy: 'mid', social: 'mid', loc }, y });
const data = Array.from({ length: 40 }, (_, i) => row(i + 1, i % 2 ? 'hall' : 'home', i % 2 ? 'a' : 'b'));

test('事前快照为值拷贝，之后状态和最终位置改变不污染', () => {
  const a = { id: 'x', drives: { v: { energy: .2, social: .7 } } }, w = { loc: { x: 'home' } };
  const s = snapshotBeforeTick(a, w); a.drives.v.energy = .9; w.loc.x = 'watch';
  assert.deepEqual(s, { energy: 'low', social: 'high', loc: 'home' }); assert.ok(Object.isFrozen(s));
});

test('时序留出正例完全可预测，匹配冲突不读取真实标签', () => {
  const r = evaluateTemporal(data, { after: 0, split: 20, until: 40 });
  assert.equal(r.train.accuracy, 1); assert.equal(r.test.accuracy, 1);
  assert.equal(r.test.n, 20); assert.equal(r.baseline.accuracy, .5);
  assert.equal(predictDecision({ fallback: 'z', rules: [{ field: 'loc', value: 'home', label: 'a' }, { field: 'energy', value: 'mid', label: 'b' }] }, data[0].x), 'a');
});

test('反向留出标签不会改变已拟合模型，且负控变红', () => {
  const base = evaluateTemporal(data, { after: 0, split: 20, until: 40 });
  const changed = data.map(r => r.t > 20 ? { ...r, y: r.y === 'a' ? 'b' : 'a' } : r);
  const r = evaluateTemporal(changed, { after: 0, split: 20, until: 40 });
  assert.deepEqual(base.model, r.model); assert.equal(r.test.accuracy, 0);
});

test('未知值回退到训练多数类，不读取测试集标签', () => {
  const m = fitDecisionRules(data.slice(0, 20));
  assert.equal(predictDecision(m, { energy: 'unknown', social: 'unknown', loc: 'new' }), m.fallback);
});

test('缺失特征、空集合及不合法边界不能悄悄通过', () => {
  assert.throws(() => snapshotBeforeTick({ id: 'x', drives: { v: { energy: 0, social: 0 } } }, { loc: {} }));
  assert.throws(() => fitDecisionRules([]));
  assert.throws(() => evaluateTemporal(data, { after: 0, split: 20, until: 20 }));
  assert.throws(() => evaluateTemporal(data, { after: 0, split: 39, until: 39.5 }));
});
