// Phase C AI 合作闸门。每条都应能被反向变异打红（撤掉意愿/组队/重规划即红）。
// 配对闸门：同 seed「独建 vs 协作」完工时间，协作必须更快。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, spawn, scanSecrets } from './body.mjs';
import { willingness, identifyPublicNeeds, decompose, stepCooperation, initCoop, runConstruction, COOP } from './cooperation.mjs';
import { BUILDINGS } from './production.mjs';

function survWorld(coop = false) {
  const w = makeWorld({ preset: 'survival', seed: 7, pantries: 0, coop });
  for (const [id, name] of [['a1', '岑'], ['a2', '绛'], ['a3', '蓑']]) { w.agents[id] = { id, name }; spawn(w, id, 'home'); }
  w.agents.p1 = { id: 'p1', name: '你', isPlayer: true }; spawn(w, 'p1', 'hall');
  return w;
}

test('C1 意愿评估：默认愿意协助；匮乏+风险+低回报转为拒绝/替代', () => {
  const w = survWorld();
  const base = willingness(w, 'a1', { severity: 0.8 });
  assert.equal(base.decision, 'assist');
  assert.ok(base.score >= COOP.assistThreshold);
  // 自身匮乏 + 恶劣天气 + 低回报 ⇒ 拒绝
  w.agents.a1.viab = { v: 0 }; w.weather = 'cold';
  const low = willingness(w, 'a1', { severity: 0 });
  assert.equal(low.decision, 'refuse');
  // 中等 ⇒ 替代
  w.weather = null;
  const mid = willingness(w, 'a1', { severity: 0.3 });
  assert.equal(mid.decision, 'alternative');
  // 玩家不参与
  assert.equal(willingness(w, 'p1', {}).decision, 'refuse');
});

test('C2 自发识别公共需求：缺粮→储粮、无住所→住所、损坏优先', () => {
  const w = survWorld();
  w.survival.store = 0;
  let needs = identifyPublicNeeds(w);
  assert.ok(needs.some((n) => n.type === 'granary'), '缺粮应识别储粮需求');
  assert.ok(needs.some((n) => n.type === 'shelter'), '无住所应识别住所需求');
  w.survival.buildings.push({ type: 'granary', loc: 'yard', integrity: 0 });
  needs = identifyPublicNeeds(w);
  assert.equal(needs[0].repair, true, '损坏建筑应最优先');
});

test('C3 任务分解：采集→奠基→施工；维修单步', () => {
  assert.deepEqual(decompose({ type: 'granary' }), ['gather', 'plan', 'build']);
  assert.deepEqual(decompose({ type: 'granary', repair: true }), ['repair']);
});

test('C4 配对闸门：同 seed 独建 vs 协作，协作完工更快（撤掉组队即红）', () => {
  const solo = runConstruction({ seed: 7, type: 'granary', coop: false, makeWorld, spawn });
  const coop = runConstruction({ seed: 7, type: 'granary', coop: true, makeWorld, spawn });
  assert.equal(solo.completed, true, '独建应能完工');
  assert.equal(coop.completed, true, '协作应能完工');
  assert.ok(coop.workers > 1, '协作应多人');
  assert.ok(coop.ticks < solo.ticks, `协作(${coop.ticks})应快于独建(${solo.ticks})`);
});

test('C5 默认关隔离：coop 默认 off，stepCooperation 不动世界；lab/town 无 survival', () => {
  const w = survWorld(false);
  assert.equal(w.survival.coop.enabled, false);
  const before = JSON.stringify(w.survival);
  assert.equal(stepCooperation(w), null);
  assert.equal(JSON.stringify(w.survival), before, 'coop 关时不应改生存状态');
  for (const preset of ['lab', 'town']) assert.equal(makeWorld({ preset, seed: 7 }).survival, undefined);
});

test('C6 失败重规划：选址被占应换址并记 replan', () => {
  const w = survWorld(true);
  const s = w.survival;
  s.buildings.push({ type: 'shelter', loc: 'yard', integrity: 1 });   // 占住 yard
  s.inv.wood = BUILDINGS.granary.cost.wood; s.inv.stone = BUILDINGS.granary.cost.stone;
  s.coop.task = { type: 'granary', severity: 0.8, loc: 'yard', phase: 'plan', workers: ['a1'], startedAt: 0 };
  stepCooperation(w);
  assert.ok(s.coop.replans >= 1, '被占应触发重规划');
  assert.notEqual(s.coop.task?.loc ?? 'yard', 'yard', '应换到未被占的选址');
});

test('C7 全员拒绝时不组队、记拒绝（撤掉意愿门槛即红）', () => {
  const w = survWorld(true);
  for (const id of ['a1', 'a2', 'a3']) w.agents[id].viab = { v: 0 };
  w.weather = 'cold';
  w.survival.store = 0;
  const r = stepCooperation(w);
  assert.equal(r?.refused, true, '全员拒绝应返回 refused');
  assert.ok(w.survival.coop.refusals >= 1);
  assert.equal(w.survival.coop.task, null, '拒绝时不应建任务');
});

test('C8 开启后随 tick 推进：scanSecrets 驱动合作并完工记入 completions', () => {
  const w = survWorld(true);
  w.survival.store = 0;   // 触发公共需求
  let completed = null;
  for (let t = 1; t <= 200 && !completed; t++) { w.t = t; scanSecrets(w); completed = w.survival.coop.completions[0] ?? null; }
  assert.ok(completed, '开启合作后应随 tick 自动完工');
  assert.ok(completed.workers > 1, '完工记录应含多人');
});
