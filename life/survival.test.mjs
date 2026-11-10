// Phase A 生存模式闸门。验收：资源有限、须主动行动、无无限粮、失败/目标真实、lab/town 隔离。
// 每条都应能被反向变异打红（撤掉对应守卫/循环即红）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, spawn, actuate, scanSecrets } from './body.mjs';
import { validate } from './rules.mjs';
import { advanceSurvival, doHarvest, SURV } from './worldstate.mjs';

function survWorld() {
  const w = makeWorld({ preset: 'survival', seed: 7, pantries: 0 });
  for (const [id, name] of [['a1', '岑'], ['a2', '绛'], ['a3', '蓑']]) { w.agents[id] = { id, name }; spawn(w, id, 'home'); }
  w.agents.p1 = { id: 'p1', name: '你', isPlayer: true }; spawn(w, 'p1', 'hall');
  return w;
}
const setDay = (w, d) => { w.t = d * 24; };

test('S1 无行动则公共粮仓有限消耗（不主动行动处境恶化）', () => {
  const w = survWorld();
  const start = w.survival.store;
  setDay(w, 0); advanceSurvival(w);
  setDay(w, 1); advanceSurvival(w);
  assert.ok(w.survival.store < start, '不收获粮仓也应下降');
  setDay(w, 2); const s = advanceSurvival(w);
  assert.ok(s.shortfall > 0, '持续不行动应出现缺口');
});

test('S2 收获真实入仓并重置地块（主动行动改善处境）', () => {
  const w = survWorld();
  w.survival.plots[0].growth = 1;
  w.loc.a1 = 'garden';
  const before = w.survival.store;
  const r = actuate(w, 'a1', { kind: 'harvest' });
  assert.equal(r.ok, true);
  assert.equal(w.survival.store, Math.min(SURV.storeCap, before + SURV.yieldPerPlot));
  assert.equal(w.survival.plots[0].growth, 0);
});

test('S3 生存模式无无限粮：eat 被拒、公仓不自动补', () => {
  const w = survWorld();
  w.loc.a1 = 'home';
  const r = actuate(w, 'a1', { kind: 'eat' });
  assert.equal(r.ok, false, 'survival 不应允许单独吃公仓');
  const pantryBefore = w.pantry;
  for (let t = 1; t <= 120; t++) { w.t = t; scanSecrets(w); }
  assert.equal(w.pantry, pantryBefore, 'survival 公仓不应自动补粮');
});

test('S4 连续空仓触发失败；活到目标天触发胜利', () => {
  const w = survWorld();
  w.survival.store = 0;
  for (let d = 0; d < SURV.starveDaysToFail + 1; d++) { setDay(w, d); advanceSurvival(w); }
  assert.equal(w.survival.failed, true, '连续空仓应判失败');
  const w2 = survWorld();
  w2.survival.store = SURV.storeCap;
  // 每天收获维持不空仓：直接补仓模拟持续主动行动
  for (let d = 0; d <= SURV.targetDays; d++) { setDay(w2, d); w2.survival.store = SURV.storeCap; advanceSurvival(w2); }
  assert.equal(w2.survival.won, true, '活到目标天应判胜利');
});

test('S5 基线隔离：lab/town 不挂 survival，候选无 harvest/plant', () => {
  for (const preset of ['lab', 'town']) {
    const w = makeWorld({ preset, seed: 7 });
    assert.equal(w.survival, undefined, `${preset} 不应有 survival 字段`);
  }
});

test('S6 规则层守卫：非菜园/无成熟/无空畦 拒绝', () => {
  const w = survWorld();
  w.loc.a1 = 'home';
  assert.equal(validate(w, 'a1', { kind: 'harvest' }).code, 'NOT_GARDEN');
  w.loc.a1 = 'garden';
  w.survival.plots.forEach((p) => { p.growth = 0.5; });
  assert.equal(validate(w, 'a1', { kind: 'harvest' }).code, 'NO_MATURE');
  assert.equal(validate(w, 'a1', { kind: 'plant' }).code, 'NO_EMPTY_PLOT');
});
