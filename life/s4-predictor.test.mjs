import test from 'node:test';
import assert from 'node:assert/strict';
import { ForwardModel } from './s4-predictor.mjs';
import { DIMS } from './traits.mjs';
const obj = f => Object.fromEntries(DIMS.map((d, i) => [d, f(d, i)]));
const traits = { baseline: obj(() => 0.5), tau: obj(() => 100), U_max: 0.1 };
const input = k => ({ m: obj(() => 0.5), pending: obj((d, i) => ((k * (i + 2)) % 9 - 4) * 0.01), traits });
const actual = x => obj(d => x.m[d] + x.pending[d]);

test('预测先于观察，在线模型从已知注入学习而优于持久性', () => {
  const model = new ForwardModel();
  let modelError = 0, baselineError = 0;
  for (let i = 0; i < 400; i++) {
    const x = input(i), prediction = model.predict(x);
    assert.deepEqual(prediction, model.predict(x)); // predict itself is read-only
    const y = actual(x);
    if (i >= 100) for (const d of DIMS) {
      modelError += (prediction.mu[d] - y[d]) ** 2;
      baselineError += (x.m[d] - y[d]) ** 2;
    }
    model.observe(x, prediction, y);
  }
  assert.ok(modelError < baselineError * 0.1);
});
test('逐维误差驱动相对精度，模型保存恢复', () => {
  const model = new ForwardModel();
  for (let i = 0; i < 200; i++) {
    const x = input(i), prediction = model.predict(x), y = actual(x);
    y.arousal += (i % 2 ? 0.03 : -0.03);
    model.observe(x, prediction, y);
  }
  const result = model.predict(input(201));
  assert.ok(result.precision.arousal < result.precision.inhibit);
  assert.ok(result.weights.arousal < result.weights.inhibit);
  for (const d of DIMS) assert.ok(result.probability[d] >= 0 && result.probability[d] <= 1);
  const restored = new ForwardModel(); restored.load(model.dump());
  assert.deepEqual(restored.predict(input(201)), result);
  assert.deepEqual(restored.dump(), model.dump());
});

test('饱和上界处严格上升事件不可能', () => {
  const model = new ForwardModel(), x = input(1);
  x.m.arousal = 1;
  assert.equal(model.predict(x).probability.arousal, 0);
  model.observe(x, model.predict(x), { ...x.m, arousal: 1 });
  assert.equal(model.predict(x).probability.arousal, 0);
});

test('冷启动精度切断：均值、概率保持未判定且权重为一', () => {
  const model = new ForwardModel(), x = input(7);
  const enabled = model.predict(x), disabled = model.predict(x, { precision: false });
  assert.deepEqual(enabled.mu, disabled.mu);
  assert.deepEqual(disabled.probability, obj(() => 0.5));
  assert.deepEqual(disabled.precision, obj(() => null));
  assert.deepEqual(disabled.weights, obj(() => 1));
});
test('切断逐通道精度使用池化方差，保留 μ，且不改变学习状态', () => {
  const trained = new ForwardModel();
  for (let i = 0; i < 180; i++) {
    const x = input(i), pred = trained.predict(x), y = actual(x);
    y.arousal += i % 2 ? 0.03 : -0.03;
    y.inhibit += i % 2 ? 0.002 : -0.002;
    trained.observe(x, pred, y);
  }
  const original = trained.dump(), x = input(181);
  const enabled = trained.predict(x), disabled = trained.predict(x, { precision: false });
  assert.deepEqual(enabled.mu, disabled.mu);
  assert.notDeepEqual(enabled.probability, disabled.probability);
  assert.deepEqual(disabled.weights, obj(() => 1));
  assert.ok(DIMS.every(d => disabled.precision[d] === disabled.precision.arousal));
  assert.notEqual(enabled.precision.arousal, enabled.precision.inhibit);
  assert.deepEqual(trained.dump(), original);
  const a = new ForwardModel(), b = new ForwardModel(); a.load(original); b.load(original);
  const y = actual(x);
  a.observe(x, enabled, y); b.observe(x, disabled, y);
  assert.deepEqual(a.dump(), b.dump());
});
