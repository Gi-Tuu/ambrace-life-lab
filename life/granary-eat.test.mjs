// B-a 闸门：谷仓直接吃一份/日，与家里餐桌共用计数，研究态不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { createSurvPlay, survAct } from './survplay.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };

function granary(hungry = true) {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.loc.p1 = 'store';
  w.t = 40;
  w.agents.p1.viab.v = 0.5;
  w.agents.p1.drives.v.energy = hungry ? 0.2 : 0.9;
  w.survival.food.crop = 4;
  w.survival.store = 4;
  return { sp, w };
}

test('FOOD-01 谷仓有粮且饿：吃成功、回补存续、同日第二口 MEAL_LIMIT', () => {
  const { sp, w } = granary();
  const r = survAct(sp, { kind: 'camp_eat', type: 'crop' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(w.survival.food.crop, 3, '必须真实扣一份公仓粮');
  assert.ok(w.agents.p1.viab.v > 0.5, '存续应回补');
  const r2 = survAct(sp, { kind: 'camp_eat', type: 'crop' });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'MEAL_LIMIT');
  assert.equal(w.survival.food.crop, 3, '第二口不得扣粮');
});

test('FOOD-02 谷仓吃过后，同日回家上桌必须被拒（反向亦然）', () => {
  const { sp, w } = granary();
  w.campPlayerRoom = 'home';
  w.pinv.p1.tray = 1;
  w.survival.campContainers = { 'home:meal': { crop: 1 } };
  assert.equal(survAct(sp, { kind: 'camp_eat', type: 'crop' }).ok, true, '先在谷仓吃');
  w.loc.p1 = 'home';
  w.agents.p1.drives.v.energy = 0.2; // 仍饿，排除 NOT_HUNGRY 干扰
  const home = survAct(sp, { kind: 'camp_eat', type: 'crop' });
  assert.equal(home.ok, false);
  assert.equal(home.code, 'MEAL_LIMIT', '同日第二处必须被计数拦住');
  assert.equal(w.survival.campContainers['home:meal'].crop, 1, '家里那份不能扣');
  // 反向：先家里吃，再去谷仓
  const sp2 = createSurvPlay(7, GAME);
  const w2 = sp2.world;
  w2.campPlayerRoom = 'home'; w2.loc.p1 = 'home'; w2.t = 40;
  w2.pinv.p1.tray = 1;
  w2.survival.campContainers = { 'home:meal': { crop: 1 } };
  w2.agents.p1.drives.v.energy = 0.2; w2.agents.p1.viab.v = 0.5;
  assert.equal(survAct(sp2, { kind: 'camp_eat', type: 'crop' }).ok, true, '先在家吃');
  w2.loc.p1 = 'store'; w2.agents.p1.drives.v.energy = 0.2;
  const g2 = survAct(sp2, { kind: 'camp_eat', type: 'crop' });
  assert.equal(g2.ok, false);
  assert.equal(g2.code, 'MEAL_LIMIT');
});

test('FOOD-03 不饿：NOT_HUNGRY 且不扣粮、不计数', () => {
  const { sp, w } = granary(false);
  const r = survAct(sp, { kind: 'camp_eat', type: 'crop' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_HUNGRY');
  assert.equal(w.survival.food.crop, 4);
  assert.equal(w.survival.mealsToday ?? 0, 0);
});

test('FOOD-04 研究态（gameRules:false）不开放谷仓直接吃', () => {
  const sp = createSurvPlay(7, { ...GAME, gameRules: false, independentWorld: false });
  const w = sp.world;
  w.loc.p1 = 'store';
  w.t = 40;
  w.agents.p1.drives.v.energy = 0.2;
  w.survival.food = { crop: 4 }; w.survival.store = 4;
  const r = survAct(sp, { kind: 'camp_eat', type: 'crop' });
  assert.equal(r.ok, false);
  assert.equal(w.survival.food.crop, 4, '研究态公仓不得被吃');
});
