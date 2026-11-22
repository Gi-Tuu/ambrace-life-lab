// V7.1 P0 闸门：同一份食物的存续/能量效果对玩家与居民一致；不重复计粮。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survAct } from './survplay.mjs';
import { advanceSurvival } from './worldstate.mjs';

const GAME = { independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };

test('FOOD-01-RATION-PARITY 玩家一份饭 = 居民一份日粮（存续/能量同一折算）', () => {
  // 玩家：餐台一份
  const spP = createSurvPlay(7, GAME);
  const wP = spP.world;
  wP.loc.p1 = 'home'; wP.campPlayerRoom = 'home';
  wP.pinv.p1 = { ...(wP.pinv.p1 ?? {}), tray: 1 };
  wP.survival.campContainers = { 'home:meal': { crop: 1 } };
  wP.agents.p1.viab.v = 0.5;
  wP.agents.p1.drives.v.energy = 0.1;
  const p0 = { v: wP.agents.p1.viab.v, e: wP.agents.p1.drives.v.energy };
  const r = survAct(spP, { kind: 'camp_eat', type: 'crop' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const pd = { v: wP.agents.p1.viab.v - p0.v, e: wP.agents.p1.drives.v.energy - p0.e };

  // 居民：日界配给一份
  const spR = createSurvPlay(7, GAME);
  const wR = spR.world;
  wR.agents.a1.viab.v = 0.5;
  wR.agents.a1.drives.v.energy = 0.1;
  wR.survival.store = Math.max(4, wR.survival.store);
  const r0 = { v: wR.agents.a1.viab.v, e: wR.agents.a1.drives.v.energy };
  wR.t = 24;
  advanceSurvival(wR);
  const rd = { v: wR.agents.a1.viab.v - r0.v, e: wR.agents.a1.drives.v.energy - r0.e };

  assert.ok(Math.abs(pd.v - rd.v) < 1e-6, `存续效果应一致：玩家 ${pd.v} vs 居民 ${rd.v}`);
  assert.ok(Math.abs(pd.e - rd.e) < 1e-6, `能量效果应一致：玩家 ${pd.e} vs 居民 ${rd.e}`);
});

test('FOOD-02-NO-DOUBLE-COUNT 不重复计粮：日界配给与主动进食各扣各的库存', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.loc.p1 = 'home'; w.campPlayerRoom = 'home';
  w.pinv.p1 = { ...(w.pinv.p1 ?? {}), tray: 1 };
  w.survival.campContainers = { 'home:meal': { crop: 1 } };
  w.agents.p1.drives.v.energy = 0.1;
  w.survival.store = 10;
  w.t = 24;
  advanceSurvival(w); // 公仓按 eaters 扣（含玩家）
  const storeAfterRation = w.survival.store;
  assert.equal(w.survival.campContainers['home:meal'].crop, 1, '日界配给不应动私宅餐台');
  const r = survAct(sp, { kind: 'camp_eat', type: 'crop' });
  assert.equal(r.ok, true);
  assert.equal(w.survival.store, storeAfterRation, '主动进食不应再扣公仓');
  assert.equal(w.survival.campContainers['home:meal'].crop, 0, '主动进食只扣餐台');
});

test('FOOD-03-RESIDENT-GRANARY 居民能自己去公仓吃：一份 = 0.09 存续，每日一次，无粮不能吃', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.loc.a1 = 'store';
  w.agents.a1.drives.v.energy = 0.2;
  w.agents.a1.viab.v = 0.5;
  w.survival.store = 10;
  const v0 = w.agents.a1.viab.v;
  w.agents.a1.execute(w, { kind: 'eat' }, 'deliberation', w.t, true);
  assert.equal(w.survival.store, 9, '必须真实扣一份公仓');
  assert.ok((w.agents.a1.viab.v - v0) > 0.08 && (w.agents.a1.viab.v - v0) < 0.10, '一份饭应 ≈ +0.09 存续（扣动作成本后），实测 ' + (w.agents.a1.viab.v - v0).toFixed(4));
  // 当日第二次：不得再吃
  w.agents.a1.execute(w, { kind: 'eat' }, 'deliberation', w.t, true);
  assert.equal(w.survival.store, 9, '每日只能一次');
  // 无粮：不能吃
  const sp2 = createSurvPlay(7, GAME);
  const w2 = sp2.world;
  w2.loc.a2 = 'store'; w2.agents.a2.drives.v.energy = 0.2; w2.survival.store = 0;
  w2.agents.a2.execute(w2, { kind: 'eat' }, 'deliberation', w2.t, true);
  assert.equal(w2.agents.a2.mealDay, undefined, '无粮不得进食');
});