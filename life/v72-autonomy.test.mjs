// V7.2 阶段 A 闸门：玩家不会被自动住房决策代劳；私人食物/木材不会被公共结算直接征用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { createSurvPlay, tickSurvPlay } from './survplay.mjs';
import { advanceSurvival } from './worldstate.mjs';
const BUILD = { wood: 5, stone: 3 }; // households.mjs 内部常量

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };

test('A1 玩家不会被居民住房决策自动买房/建房或扣私人物资', async () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  const h = w.survival.households;
  w.pinv.p1 = { ...(w.pinv.p1 ?? {}), wood: BUILD.wood + 20, stone: BUILD.stone + 20, crop: 0 };
  w.survival.inv.wood = 20; // 公共燃料充足，排除燃料扣木材的干扰
  const home0 = w.housing.p1;
  const bag0 = { ...w.pinv.p1 };
  for (let i = 0; i < 24 * 5; i += 1) await tickSurvPlay(sp, { now: Date.now() });
  assert.equal(w.housing.p1, home0, '玩家住所不应被自动改变');
  assert.equal(h.residents.p1?.decision === 'building' || h.residents.p1?.decision === 'bought' || h.residents.p1?.decision === 'building', false, '玩家不应被登记为买房/建房');
  assert.ok(!Object.values(h.projects).some((p) => p.owner === 'p1'), '玩家不应被自动开工');
  assert.ok(w.pinv.p1.wood >= bag0.wood - 1, `玩家私人物资不应被自动扣建材（${bag0.wood} → ${w.pinv.p1.wood}）`);
  assert.ok(w.pinv.p1.stone >= bag0.stone - 1, '玩家石料不应被自动扣');
});

test('A2 公共缺粮不得直接清空私人餐台；公共容器可被征用', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.survival.store = 0;
  w.survival.food = { crop: 0, berry: 0, fruit: 0, egg: 0, milk: 0, meat: 0 };
  w.survival.campContainers = {
    'home:meal': { crop: 4 },  // 私人餐台
    'store:1': { crop: 2 },    // 公共容器
  };
  w.t = 24;
  advanceSurvival(w);
  assert.equal(w.survival.campContainers['home:meal'].crop, 4, '私人餐台不应被公共缺粮自动清空');
  assert.ok(w.survival.campContainers['store:1'].crop < 2, '公共容器应优先用于公共配给');
});

test('A3 公共燃料不足不得直接烧玩家背包木材（居民个人木材也不应被特殊对待）', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.survival.inv.wood = 0;
  w.pinv.p1 = { ...(w.pinv.p1 ?? {}), wood: 5 };
  w.t = 24;
  advanceSurvival(w);
  assert.equal(w.pinv.p1.wood, 5, '公共设施燃料不应自动扣玩家私人木材');
  assert.equal(w.survival.fuelBurnDays ?? 0, 0, '没有公共柴时不应假装烧过（不应记燃料天数）');
});
