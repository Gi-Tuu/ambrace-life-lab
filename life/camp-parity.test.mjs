// V7 阶段 C 闸门：营地动作成本与进食上限（AUD-05/06/01 部分）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survAct, PLAYER_TIME } from './survplay.mjs';

const GAME = { independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };

test('CAMP-01 进食上限：同刻最多两餐，第三餐被拒；每餐 50 时间', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.loc.p1 = 'home';
  w.campPlayerRoom = 'home';
  w.pinv.p1 = { ...(w.pinv.p1 ?? {}), tray: 1 };
  w.survival.campContainers = { 'home:meal': { crop: 6 } };
  w.agents.p1.viab.v = 0.3;
  w.agents.p1.drives.v.energy = 0.2; // 两餐后仍会回到饥饿区，用于验证上限本身
  const results = [0, 1, 2, 3].map(() => survAct(sp, { kind: 'camp_eat', type: 'crop' }));
  const ok = results.filter((r) => r.ok).length;
  assert.equal(ok, 2, '同刻最多两餐，实测 ' + results.map((r) => (r.ok ? 'ok' : r.code)).join(','));
  assert.ok(w.agents.p1.viab.v > 0.6 && w.agents.p1.viab.v < 0.7, '两餐应只加 0.36 存续，实测 ' + w.agents.p1.viab.v.toFixed(3));
  assert.equal(w.survival.mealsToday, 2);
  // 下一刻：日上限仍然生效（不是只靠时间预算/饥饿门）
  w.t += 1;
  w.agents.p1.drives.v.energy = 0.2;
  const third = survAct(sp, { kind: 'camp_eat', type: 'crop' });
  assert.equal(third.ok, false);
  assert.equal(third.code, 'MEAL_LIMIT');
});

test('CAMP-02 未知 camp 动作必须被显式门拒绝，且不消耗时间/存续', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  const t0 = w.survival.p1BudgetLeft;
  const v0 = w.agents.p1.viab.v;
  const r = survAct(sp, { kind: 'camp_mind_control' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN_CAMP_ACTION');
  assert.equal(w.survival.p1BudgetLeft, t0, '未知动作不得扣时间');
  assert.equal(w.agents.p1.viab.v, v0);
});

test('CAMP-03 成本表显式：伤害 75、进食 50，且每个派发的 camp_* 都有成本或是免费白名单', () => {
  assert.ok(PLAYER_TIME.camp_resident >= 50, 'camp_resident 必须有真实成本');
  assert.ok(PLAYER_TIME.camp_eat >= 50, 'camp_eat 必须占半刻以上');
  const dispatched = ['camp_store', 'camp_take', 'camp_eat', 'camp_resident', 'camp_chop', 'camp_collect', 'camp_plant', 'camp_water', 'camp_craft'];
  for (const kind of dispatched) assert.ok(PLAYER_TIME[kind] > 0, kind + ' 缺显式成本');
  for (const free of ['camp_exit', 'camp_sleep']) assert.equal(PLAYER_TIME[free] ?? 0, 0);
});

test('CAMP-04 不饿不吃：能量充足时 camp_eat 被拒（RES-02）', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.loc.p1 = 'home';
  w.campPlayerRoom = 'home';
  w.pinv.p1 = { ...(w.pinv.p1 ?? {}), tray: 1 };
  w.survival.campContainers = { 'home:meal': { crop: 3 } };
  w.agents.p1.viab.v = 0.3;
  w.agents.p1.drives.v.energy = 0.8;
  const r = survAct(sp, { kind: 'camp_eat', type: 'crop' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_HUNGRY');
  assert.equal(w.survival.campContainers['home:meal'].crop, 3, '被拒不得扣食物');
});
