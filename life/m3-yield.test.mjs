// M3 收益模型（look_out / take_shared）的对齐闸门：预测必须与真实 actuate 的结果一致，
// 而不是"看起来合理"。任何一条对不上，后面的目标分布与停止检验都不可信。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Organism } from './agent.mjs';
import { makeWorld, spawn, affordancesFor, actuate } from './body.mjs';
import { ShortHorizonPlanner } from './m3-planner.mjs';

function fixture({ loc = 'home', pantry = 3, stash = 3, energy = 0.2, social = 0.2, t = 10 } = {}) {
  const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 7 });
  const b = new Organism({ id: 'a2', name: '绛', archetype: '冲动', seed: 8 });
  const w = makeWorld({ pantries: pantry, stash });
  w.agents.a1 = a;
  w.agents.a2 = b;
  w.t = t;
  spawn(w, 'a1', loc);
  spawn(w, 'a2', 'hall'); // 目标不在场，符合 take_shared 的 WITNESSED 约束
  a.drives.v.energy = energy;
  a.drives.v.social = social;
  return { a, w };
}

test('look_out 收益模型对齐真实 actuate：移动到 watch、社交 +0.12', () => {
  const { a, w } = fixture({ social: 0.2 });
  const action = affordancesFor(w, 'a1').find((x) => x.kind === 'look_out');
  const snapshot = a.m3Snapshot(w);
  const predicted = new ShortHorizonPlanner().step({ snapshot, actions: [action], catalog: [] }).plans[0].predicted.afterFirst;
  const result = actuate(w, 'a1', action);
  assert.ok(result.ok);
  a.drives.reward(result.satiated, result.amount);
  assert.equal(w.loc.a1, 'watch', '真实 actuate 没有把角色移动到瞭台 ⇒ 反例没成立');
  assert.equal(predicted.loc, w.loc.a1, '预测位置与真实位置不一致');
  assert.equal(predicted.social, a.drives.v.social, `预测社交 ${predicted.social} 与真实 ${a.drives.v.social} 不一致 ⇒ 收益模型写错了`);
});

test('take_shared 收益模型对齐真实 actuate：能量按公开预期份量回补', () => {
  const { a, w } = fixture({ loc: 'watch', energy: 0.2 });
  const action = affordancesFor(w, 'a1').find((x) => x.kind === 'take_shared');
  assert.ok(action, 'watch 上没有可越轨的候选');
  const snapshot = a.m3Snapshot(w);
  assert.ok(Object.keys(snapshot.takeable).length > 0, '快照里没有可越轨对象 ⇒ 可用性事实没接进快照');
  const predicted = new ShortHorizonPlanner().step({ snapshot, actions: [action], catalog: [] }).plans[0].predicted.afterFirst;
  const result = actuate(w, 'a1', action);
  assert.ok(result.ok, '真实越轨没有成功 ⇒ 反例没成立');
  a.drives.reward(result.satiated, result.amount);
  assert.equal(predicted.energy, a.drives.v.energy, `预测能量 ${predicted.energy} 与真实 ${a.drives.v.energy} 不一致 ⇒ 份量口径错了`);
});

test('越轨只在当前位置吃不到合法食物时进入候选（存续逃生门，不是默认取食路径）', () => {
  const { a, w } = fixture({ loc: 'home', pantry: 3 });
  const snapshot = a.m3Snapshot(w);
  assert.ok(Object.keys(snapshot.takeable).length > 0);
  const r = new ShortHorizonPlanner().step({ snapshot, actions: affordancesFor(w, 'a1'), catalog: [] });
  assert.ok(!r.plans.some((p) => p.first.kind === 'take_shared'), '家门口就有公仓时仍规划越轨 ⇒ 逃生门被当成默认取食路径');
});

test('夜禁时 look_out 不进入规划（规则层的知识以公开事实给出）', () => {
  const { a, w } = fixture({ t: 22 });
  const snapshot = a.m3Snapshot(w);
  assert.equal(snapshot.lookOutLegal, false, '夜里快照仍标记为合法');
  const r = new ShortHorizonPlanner().step({ snapshot, actions: affordancesFor(w, 'a1'), catalog: [] });
  assert.ok(!r.plans.some((p) => p.first.kind === 'look_out'), '夜里仍规划瞭台 ⇒ 夜禁被收益模型绕开了');
});

test('take_shared 不做第二步：第一步之后的私人库存不预测', () => {
  const { a, w } = fixture({ loc: 'watch', energy: 0.2 });
  const paths = affordancesFor(w, 'a1');
  const r = new ShortHorizonPlanner().step({ snapshot: a.m3Snapshot(w), actions: paths, catalog: paths });
  assert.ok(r.plans.every((p) => p.second?.kind !== 'take_shared'), '出现了"先走一步再偷一次"的二步路径');
});

test('收益模型补齐后 explore 可达：能量满、社交缺口大时目标是 explore', () => {
  const snapshot = { selfId: 'a1', loc: 'home', energy: 0.95, social: 0.05, pantry: 3, energySetpoint: 0.55, socialSetpoint: 0.8, companions: {}, lookOutLegal: true, takeable: {} };
  const acts = [{ id: 'rest', kind: 'rest', cost: 0.02 }, { id: 'look_out', kind: 'look_out', cost: 0.18 }];
  const r = new ShortHorizonPlanner().step({ snapshot, actions: acts, catalog: acts });
  assert.equal(r.goal, 'explore', `目标 ${r.goal}：explore 仍然不可达 ⇒ 收益模型没有真正进入比较`);
});
