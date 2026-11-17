// V7.3.2 第二批：容器级守恒快照（去重、内部转移、配给、容量）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotStocks, CONSERVATION_KINDS } from './resource-conservation-probe.mjs';
import { createSurvPlay, tickSurvPlay } from './survplay.mjs';
import { advanceSurvival } from './worldstate.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true,
  farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };
const make = () => { const sp = createSurvPlay(7, GAME); sp.world.t = 10; sp.world.survival.lastDay = 0; return sp.world; };

test('V732-C1 内部转移（背包→家庭容器→公仓）总额不变，逐容器只计一次', () => {
  const w = make();
  w.pinv.p1 = { wood: 10, stone: 0 };
  const before = snapshotStocks(w);
  (w.survival.campContainers ??= {})['home:p1'] = { wood: 4, stone: 0 };
  (w.survival.campContainers)['store:main'] = { wood: 6, stone: 0 };
  w.pinv.p1 = { wood: 0, stone: 0 };
  const after = snapshotStocks(w);
  assert.equal(after.wood, before.wood, '内部转移不改变总量');
  assert.equal(after.wood, 10, '每个容器各计一次，不重复');
  for (const k of CONSERVATION_KINDS) assert.equal(typeof after[k], 'number');
});

test('V732-C2 配给消耗：日界后库存下降且账本 consumed 增加', () => {
  const w = make(); w.t = 24; w.survival.lastDay = 0;
  w.survival.store = 12;
  w.survival.food = { crop: 12, berry: 0, fruit: 0, egg: 0, milk: 0, meat: 0 };
  const before = snapshotStocks(w);
  advanceSurvival(w);
  const after = snapshotStocks(w);
  assert.ok(after.crop < before.crop, '配给应消耗库存');
  assert.ok((w.survival.resLedger?.consumed?.crop?.ration ?? 0) >= 1);
});

test('V732-C3 容量/溢出：overflow 入账，快照不把溢出重复计入库存', async () => {
  const sp = createSurvPlay(7, GAME), w = sp.world; w.t = 10; w.survival.lastDay = 0;
  w.survival.plots[0].growth = 1;
  w.survival.store = 24; // storeCap 满
  w.survival.food = { crop: 24, berry: 0, fruit: 0, egg: 0, milk: 0, meat: 0 };
  const sp2 = await import('./worldstate.mjs');
  const r = sp2.doHarvest(w, 'a1', 0);
  assert.ok(r.ok);
  assert.ok((w.survival.resLedger?.overflow?.crop ?? 0) >= 1, '溢出入账');
  const snap = snapshotStocks(w);
  assert.ok(snap.crop <= 24, '库存不被溢出推超容量');
});

