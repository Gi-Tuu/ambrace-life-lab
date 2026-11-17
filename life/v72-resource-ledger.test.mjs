// V7.2 第五批 D1/D2：资源账本（自然/个人/公共/溢出/消费）与"同一份食物只消费一次"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survAct, survView } from './survplay.mjs';
import { doHarvest, advanceSurvival } from './worldstate.mjs';
import { doGather, effectiveMods } from './production.mjs';
import { move } from './body.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const GAME = {
  eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true,
  autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true,
};
const make = (seed = 7, extra = {}) => createSurvPlay(seed, { ...GAME, ...extra });

test('D1-01 收获分账：个人/公共/超容量损失分开记，仓满有反馈', () => {
  const sp = make(), w = sp.world, s = w.survival;
  s.plots[0].growth = 1;
  const cap = effectiveMods(w).storeCap;
  s.store = cap; // 仓满
  const r = doHarvest(w, 'a1', 0, 1);
  assert.ok(r.ok, JSON.stringify(r));
  const L = s.resLedger;
  assert.ok(L.gross.crop >= 1, '自然产出要记');
  assert.equal(L.personal.crop, 1, '个人获得要记');
  assert.equal(L.publicIn.crop ?? 0, 0, '仓满时公共入库为 0');
  assert.ok((L.overflow.crop ?? 0) >= 1, '超容量部分要记为损失');
  assert.equal(s.lastOverflow.code, 'STORE_FULL', '仓满要留可见反馈');
  assert.ok(survView(sp).resources, '视图要带资源账本');
});

test('D1-02 采集分账：自然产出与个人获得都入账', () => {
  const sp = make(), w = sp.world, s = w.survival;
  move(w, 'a1', 'yard');
  const r = doGather(w, 'a1', 'yard');
  assert.ok(r.ok);
  assert.equal(s.resLedger.gross.wood, r.amount);
  assert.equal(s.resLedger.personal.wood, r.amount);
});

test('D1-03 消费入口分账：玩家在仓里吃 / 居民在仓里吃各记一次', () => {
  const sp = make(), w = sp.world, s = w.survival;
  w.t = 10;
  move(w, 'p1', 'store');
  w.agents.p1.drives.v.energy = 0.3;
  const r = survAct(sp, { kind: 'camp_eat' });
  assert.ok(r.ok, JSON.stringify(r));
  const consumed = s.resLedger.consumed;
  const playerTotal = Object.values(consumed).reduce((n, by) => n + (by.player ?? 0), 0);
  assert.equal(playerTotal, 1, '玩家吃一份只记一次');
  // 居民在公仓吃
  w.agents.a1.drives.v.energy = 0.3;
  move(w, 'a1', 'store');
  assert.ok(w.agents.a1.execute(w, { kind: 'eat' }, 'deliberation', w.t, true)?.ok);
  const residentTotal = Object.values(s.resLedger.consumed).reduce((n, by) => n + (by.resident ?? 0), 0);
  assert.equal(residentTotal, 1);
});

test('D2-01 当天吃过实物的人不再占日界配给（同一份食物只消费一次）', () => {
  const sp = make(), w = sp.world, s = w.survival;
  w.t = 24;
  const day = Math.floor(w.t / 24);
  s.store = 10;
  if (s.food) s.food.crop = 10;
  // 没有吃过的人：3 个居民各占 1 份
  const before = s.store;
  advanceSurvival(w);
  const fullNeed = before - s.store;
  // 复原，让 a1 今天已经在公仓吃过实物
  const sp2 = make(), w2 = sp2.world, s2 = w2.survival;
  w2.t = 24; s2.store = 10; if (s2.food) s2.food.crop = 10;
  w2.agents.a1.mealDay = day;
  const before2 = s2.store;
  advanceSurvival(w2);
  const need2 = before2 - s2.store;
  assert.equal(need2, fullNeed - 1, `吃过一份的人不应再吃配给：${fullNeed} vs ${need2}`);
  assert.ok(s2.resLedger.consumed.crop?.ration >= 1, '配给消费也要入账');
});

test('D2-02 玩家当天已吃：不再占配给份额', () => {
  const sp = make(7, { playerRation: true }), w = sp.world, s = w.survival;
  w.t = 24;
  const day = Math.floor(w.t / 24);
  s.mealsDay = day; s.mealsToday = 1;
  s.store = 10; if (s.food) s.food.crop = 10;
  const before = s.store;
  advanceSurvival(w);
  const need = before - s.store;
  assert.equal(need, 3, '3 个居民吃配给，玩家已吃过不占份额');
});

test('D2-03 研究态不写资源账本（基线边界）', () => {
  const sp = createSurvPlay(7, { independentWorld: true, unifiedCooperation: true }), w = sp.world;
  move(w, 'a1', 'yard');
  doGather(w, 'a1', 'yard');
  assert.equal(w.survival.resLedger, undefined);
  assert.equal(Object.hasOwn(survView(sp), 'resources'), false);
});
