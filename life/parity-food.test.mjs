// V7.1 P0 闸门：同一份食物的存续/能量效果对玩家与居民一致；不重复计粮。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survAct } from './survplay.mjs';
import { advanceSurvival } from './worldstate.mjs';

const GAME = { independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };

test('FOOD-01 玩家一份饭 = 居民一份日粮（存续/能量同一折算）', () => {
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

test('FOOD-02 不重复计粮：日界配给与主动进食各扣各的库存', () => {
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
